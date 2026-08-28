import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../config';
import { requireAdmin } from '../middleware/authenticate';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  asyncHandler
} from '../utils/errorHandler';
import { isOpportunityOwner } from '../utils/opportunityOwnership';
import { logger } from '../utils/logger';
import { buildStorageFileName } from '../firsthand/storage-file-name';
import { normalizeRecordingMimeType } from '../firsthand/recording-mime';
import { isPlayableMimeType } from '../firsthand/session-outputs';
import { getMaximumRecordingSizeBytes } from '../firsthand/recording-limits';
import {
  createPresignedRecordingUploadUrl,
  deleteS3Object,
  headS3ObjectStat
} from '../firsthand/runtime-object-storage-s3';

const router: Router = Router();

/**
 * Booking artefacts (#79 step 2): recordings and transcripts of a moderated
 * session, ingested AFTER the call. The uploader is the RESEARCHER
 * (owner-or-superadmin), a different principal from the runtime flow's
 * participant, so these are new routes rather than extensions of the
 * participant router - same presign -> direct-to-S3 PUT -> finalize shape,
 * same S3 helpers, different gate.
 *
 * Every refusal is an exported sentence asserted verbatim in tests - two
 * guards sharing a status are indistinguishable, and errorHandler drops
 * ValidationError's details array, so the sentence must BE the message.
 */
export const ARTIFACT_BOOKING_NOT_BOOKED =
  'This booking is cancelled; artefacts attach only to a booked session';
export const ARTIFACT_CONSENT_REQUIRED =
  'Attach a recording only to a booking with recorded consent, or attest how consent was obtained outside Cortex';
export const ARTIFACT_ATTESTATION_REASON_EMPTY =
  'An attestation needs its reason - say how consent was obtained';
export const ARTIFACT_TRANSCRIPT_MIME_REFUSED =
  'Transcripts are accepted as text/vtt or text/plain only';
export const ARTIFACT_RECORDING_MIME_REFUSED =
  'Recordings are accepted as video or audio types only';

/**
 * Transcript ceiling, a LITERAL by design (10 MiB): a transcript is text, and
 * a "transcript" the size of a film is either the wrong file or an attack.
 * Recordings use the runtime's 2 GiB constant. Both numbers are pinned as
 * literals in tests, because a test that derives its expectation from the
 * constant cannot see the constant change.
 */
export const MAX_TRANSCRIPT_SIZE_BYTES = 10 * 1024 * 1024;

export const TRANSCRIPT_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/vtt',
  'text/plain'
]);

/** The presign window, mirroring the runtime path's 15 minutes. */
const PENDING_UPLOAD_VALIDITY_MS = 15 * 60 * 1000;

const presignSchema = z
  .object({
    kind: z.enum(['recording', 'transcript']),
    file_name: z.string().trim().min(1).max(255),
    mime_type: z.string().trim().min(1).max(255),
    file_size_bytes: z.number().int().positive(),
    // D3's escape hatch, F13-shaped: the attestation IS the typed reason - a
    // bare boolean asserts nothing anyone can later read. Optional; its
    // absence on a booking without recorded acceptance is a refusal.
    consent_attestation_reason: z.string().max(2000).optional()
  })
  .strict();

const finalizeSchema = z
  .object({
    object_key: z.string().trim().min(1).max(1024)
  })
  .strict();

interface OwnedBooking {
  id: string;
  status: string;
  owner_user_id: string | null;
  consent_accepted_at: Date | null;
}

/**
 * The three-stage gate every route here shares: requireAdmin has already
 * re-read the LIVE role; this loads the booking through the
 * booking -> session -> opportunity join (there is no bookings.opportunity_id;
 * every join goes through sessions) and refuses everyone but the opportunity's
 * owner or a superadmin. Returns what the consent gate needs off the same row.
 */
async function loadOwnedBooking(req: Request): Promise<OwnedBooking> {
  const { bookingId } = req.params;

  const result = await pool.query(
    `
    SELECT b.id, b.status, b.consent_accepted_at, o.owner_user_id
    FROM bookings b
    JOIN sessions s ON b.session_id = s.id
    JOIN opportunities o ON s.opportunity_id = o.id
    WHERE b.id = $1
  `,
    [bookingId]
  );

  if (result.rows.length === 0) {
    throw new NotFoundError('Booking');
  }

  const booking = result.rows[0];
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOpportunityOwner(booking, req.user)) {
    throw new ForbiddenError(
      'Only the owner or a superadmin can manage artefacts for this booking'
    );
  }

  return booking;
}

/**
 * The D3 gate: artefact ingest requires recorded acceptance on the booking OR
 * an explicit typed attestation. Returns the attestation reason to persist
 * (null when acceptance covers it - an attestation beside a real acceptance
 * would record a weaker claim over a stronger one).
 *
 * F13's "refuse attestation when the participant was asked and declined" has
 * no representable case: declining the consent modal books NOTHING, so a
 * booking with null acceptance on a consent-carrying opportunity can only
 * predate the wording (or step 1b itself) - exactly the population the
 * attestation exists for.
 *
 * VERDICT, not an omission: the acceptance is deliberately NOT re-compared
 * against the opportunity's LIVE wording (via consent_text_snapshot_hash or
 * otherwise). The booking row snapshots the exact sentence the participant
 * accepted; a researcher editing the opportunity's wording afterwards cannot
 * retroactively unconsent a session that already ran under the snapshot. A
 * gate that downgraded such bookings to attestation-required would refuse
 * ingest for correctly consented sessions on the strength of an edit the
 * participant never saw. The hash exists so a DISPUTE can prove what was
 * accepted - it is evidence, not a live comparison input.
 */
function resolveConsentGate(
  booking: OwnedBooking,
  attestationReason: string | undefined
): string | null {
  if (booking.consent_accepted_at) {
    return null;
  }

  if (attestationReason === undefined) {
    throw new ValidationError(ARTIFACT_CONSENT_REQUIRED);
  }

  const reason = attestationReason.trim();
  if (!reason) {
    throw new ValidationError(ARTIFACT_ATTESTATION_REASON_EMPTY);
  }

  return reason;
}

// POST /api/bookings/:bookingId/artifacts/presign - presign a direct-to-S3
// PUT. The object key is server-derived, never client-chosen: a presigned PUT
// is a raw write capability, and honouring a client key would let one upload
// overwrite another.
router.post(
  '/:bookingId/artifacts/presign',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = presignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(
        'presign needs kind, file_name, mime_type and file_size_bytes, and no other key'
      );
    }

    const booking = await loadOwnedBooking(req);

    // F14: a cancelled booking holds no session to have artefacts of.
    if (booking.status !== 'booked') {
      throw new ValidationError(ARTIFACT_BOOKING_NOT_BOOKED);
    }

    const attestationReason = resolveConsentGate(
      booking,
      parsed.data.consent_attestation_reason
    );

    let mimeType: string;
    let maximumSizeBytes: number;
    if (parsed.data.kind === 'recording') {
      mimeType = normalizeRecordingMimeType(parsed.data.mime_type);
      // Write-side twin of the read-side playable gate: the normaliser only
      // defaults EMPTY types, so without this a text/html "recording" is
      // storable with that type signed into the PUT - and the serving route
      // step 3 adds would hand it back inline on origin, which is stored XSS
      // between admins. Refused here, where the type is chosen.
      if (!isPlayableMimeType(mimeType)) {
        throw new ValidationError(ARTIFACT_RECORDING_MIME_REFUSED);
      }
      maximumSizeBytes = getMaximumRecordingSizeBytes();
    } else {
      mimeType = parsed.data.mime_type.toLowerCase();
      if (!TRANSCRIPT_MIME_TYPES.has(mimeType)) {
        throw new ValidationError(ARTIFACT_TRANSCRIPT_MIME_REFUSED);
      }
      maximumSizeBytes = MAX_TRANSCRIPT_SIZE_BYTES;
    }

    if (parsed.data.file_size_bytes > maximumSizeBytes) {
      return res.status(413).json({
        error: 'artifact_too_large',
        maximumSizeInBytes: maximumSizeBytes
      });
    }

    const objectKey = `booking-artifacts/${booking.id}/${buildStorageFileName(parsed.data.file_name)}`;
    const validUntil = new Date(Date.now() + PENDING_UPLOAD_VALIDITY_MS);

    // Sign FIRST: signing has no side effects, and it throws on a deployment
    // without S3 configured - a review gate proved the previous order wrote
    // the pending row and then 500ed, leaking one orphan row per attempt.
    const uploadUrl = await createPresignedRecordingUploadUrl({
      contentType: mimeType,
      expiresInSeconds: PENDING_UPLOAD_VALIDITY_MS / 1000,
      objectKey
    });

    // ponytail: a pending row whose upload never finalizes outlives its
    //   window forever, and so does the S3 object behind it - the 410 branch
    //   at finalize leaves both. The runtime twin has a sweeper
    //   (runtime-repository-postgres.ts, valid_until + grace, object deleted
    //   with the row); the upgrade path here is the same sweeper plus an
    //   index on valid_until, and a per-router limiter (the !201 pattern) if
    //   the surface ever stops being admin-only. An expired row can never
    //   become an artefact - finalize checks the window - so the ceiling is
    //   storage cost, reachable by accident or by a compromised admin session
    //   presigning in a loop; live-role re-read on every request is what cuts
    //   the second one off at revocation. Same ceiling, third arm: an
    //   oversize re-PUT through a still-valid URL AFTER finalize sits in
    //   storage under a small row - detectable at serve via the ETag, but
    //   only the sweeper reclaims the bytes.
    await pool.query(
      `
      INSERT INTO pending_booking_artifact_uploads
        (booking_id, kind, file_name, mime_type, relative_path, requested_by,
         consent_attestation_reason, valid_until)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
      [
        booking.id,
        parsed.data.kind,
        parsed.data.file_name,
        mimeType,
        objectKey,
        req.user!.id,
        attestationReason,
        validUntil
      ]
    );

    return res.json({
      mode: 's3',
      objectKey,
      uploadUrl,
      validUntil: validUntil.toISOString()
    });
  })
);

// POST /api/bookings/:bookingId/artifacts/finalize - turn a completed direct
// upload into an artefact row. Everything about the artefact comes from the
// pending row registered at presign plus HeadObject; the caller only names
// which of this booking's registered uploads to finalize. The consent gate
// runs AGAIN off the live booking row - presign and finalize are separate
// requests and the gate must hold at both.
router.post(
  '/:bookingId/artifacts/finalize',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = finalizeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('finalize names object_key and nothing else');
    }

    const booking = await loadOwnedBooking(req);

    if (booking.status !== 'booked') {
      throw new ValidationError(ARTIFACT_BOOKING_NOT_BOOKED);
    }

    const pendingResult = await pool.query(
      `
      SELECT id, booking_id, kind, file_name, mime_type, relative_path,
             consent_attestation_reason, valid_until
      FROM pending_booking_artifact_uploads
      WHERE relative_path = $1 AND booking_id = $2
    `,
      [parsed.data.object_key, booking.id]
    );

    if (pendingResult.rows.length === 0) {
      return res.status(403).json({ error: 'unknown_upload' });
    }
    const pending = pendingResult.rows[0];

    if (new Date(pending.valid_until).getTime() < Date.now()) {
      return res.status(410).json({ error: 'upload_expired' });
    }

    // The gate again, with the reason PRESIGN captured - not whatever this
    // request cares to say. Acceptance recorded since presign also counts.
    const attestationReason = resolveConsentGate(
      booking,
      pending.consent_attestation_reason ?? undefined
    );

    const objectStat = await headS3ObjectStat(pending.relative_path);
    if (objectStat === null) {
      return res.status(422).json({ error: 'uploaded_object_missing' });
    }
    const objectSizeBytes = objectStat.sizeBytes;

    const maximumSizeBytes =
      pending.kind === 'recording'
        ? getMaximumRecordingSizeBytes()
        : MAX_TRANSCRIPT_SIZE_BYTES;
    if (objectSizeBytes > maximumSizeBytes) {
      // Delete-on-oversize is NEW behaviour relative to the runtime path
      // (which answers 413 and leaves the object) - deliberate, per the plan's
      // F2: an over-limit object nobody will ever finalize is storage nobody
      // will ever reclaim.
      await deleteS3Object(pending.relative_path).catch((error) => {
        logger.warn('Oversize artifact object could not be deleted', {
          relativePath: pending.relative_path,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      await pool.query(
        'DELETE FROM pending_booking_artifact_uploads WHERE id = $1',
        [pending.id]
      );
      return res.status(413).json({
        error: 'artifact_too_large',
        maximumSizeInBytes: maximumSizeBytes
      });
    }

    // ponytail: no virus scanning on any upload path repo-wide - mime, size
    //   and key shape are verified, bytes are not inspected
    //   -> cto/AdaptaLabs#98, sized there with the mitigation spectrum.
    //
    // The ETag is stored because the presigned PUT URL stays valid for its
    // whole window after this row lands - S3 cannot revoke a signature - so a
    // re-PUT can swap the bytes under a finalized artefact. The step 3 media
    // route must refuse to serve when the live ETag no longer matches this
    // one, which turns a silent swap into a named failure.
    const artifactResult = await pool.query(
      `
      INSERT INTO booking_artifacts
        (booking_id, kind, file_name, mime_type, file_size_bytes,
         storage_provider, relative_path, uploaded_by, etag,
         consent_attested_by, consent_attested_at, consent_attestation_reason)
      VALUES ($1, $2, $3, $4, $5, 's3', $6, $7, $8,
        CASE WHEN $9::text IS NOT NULL THEN $7::uuid END,
        CASE WHEN $9::text IS NOT NULL THEN NOW() END,
        $9)
      RETURNING *
    `,
      [
        booking.id,
        pending.kind,
        pending.file_name,
        pending.mime_type,
        objectSizeBytes,
        pending.relative_path,
        req.user!.id,
        objectStat.etag,
        attestationReason
      ]
    );

    await pool.query(
      'DELETE FROM pending_booking_artifact_uploads WHERE id = $1',
      [pending.id]
    );

    return res.status(201).json(serializeArtifact(artifactResult.rows[0]));
  })
);

// GET /api/bookings/:bookingId/artifacts - list this booking's artefacts.
router.get(
  '/:bookingId/artifacts',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const booking = await loadOwnedBooking(req);

    const result = await pool.query(
      `
      SELECT id, booking_id, kind, file_name, mime_type, file_size_bytes,
             storage_provider, relative_path, uploaded_by, uploaded_at,
             consent_attested_by, consent_attested_at, consent_attestation_reason
      FROM booking_artifacts
      WHERE booking_id = $1
      ORDER BY uploaded_at DESC, id DESC
    `,
      [booking.id]
    );

    return res.json(result.rows.map(serializeArtifact));
  })
);

// DELETE /api/bookings/:bookingId/artifacts/:artifactId - remove one artefact,
// object first. The artefact is loaded SCOPED to the booking in the path, so
// an id from another booking is a 404 here even for its owner - the same
// scope-binding the session-outputs media route does.
router.delete(
  '/:bookingId/artifacts/:artifactId',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const booking = await loadOwnedBooking(req);
    const { artifactId } = req.params;

    const artifactResult = await pool.query(
      `
      SELECT id, kind, file_name, relative_path, storage_provider,
             consent_attested_by, consent_attested_at, consent_attestation_reason
      FROM booking_artifacts
      WHERE id = $1 AND booking_id = $2
    `,
      [artifactId, booking.id]
    );

    if (artifactResult.rows.length === 0) {
      throw new NotFoundError('Artifact');
    }
    const artifact = artifactResult.rows[0];

    // The attestation trio lives ONLY on this row, so deleting the artefact
    // erases the record of who asserted consent for it - deliberate (the
    // record covers an object that will no longer exist), but the erasure
    // itself goes to the log so the assertion is not silently unmade by the
    // same principal class that made it.
    if (artifact.consent_attested_at) {
      logger.info('Deleting an attested booking artefact', {
        artifactId: artifact.id,
        bookingId: booking.id,
        kind: artifact.kind,
        deletedBy: req.user!.id,
        consentAttestedBy: artifact.consent_attested_by,
        consentAttestedAt: artifact.consent_attested_at,
        consentAttestationReason: artifact.consent_attestation_reason
      });
    }

    // Object first, so a storage failure leaves the ROW pointing at a real
    // object rather than an object nobody can reach. An already-absent object
    // is logged and tolerated: an orphan row over a hole is strictly worse
    // than tolerating an erasure that already happened.
    try {
      await deleteS3Object(artifact.relative_path);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'NotFound' || error.name === 'NoSuchKey')
      ) {
        logger.warn('Artifact object already absent at delete', {
          relativePath: artifact.relative_path
        });
      } else {
        throw error;
      }
    }

    await pool.query('DELETE FROM booking_artifacts WHERE id = $1', [
      artifact.id
    ]);

    return res.status(204).send();
  })
);

interface ArtifactRow {
  id: string;
  booking_id: string;
  kind: string;
  file_name: string;
  mime_type: string;
  file_size_bytes: string | number;
  storage_provider: string;
  relative_path: string;
  uploaded_by: string | null;
  uploaded_at: Date;
  // Deliberately NOT serialised, like relative_path: the ETag is the step 3
  // media route's server-side integrity check against a post-finalize re-PUT,
  // and nothing on the wire needs it.
  etag: string | null;
  consent_attested_by: string | null;
  consent_attested_at: Date | null;
  consent_attestation_reason: string | null;
}

/**
 * Field-by-field on purpose, like every response map on the bookings routes:
 * a column not named here never leaves the server, whatever lands on the row
 * later. relative_path stays INTERNAL - the step 3 media route will mint URLs
 * server-side, and a raw object key on the wire invites building one by hand.
 */
function serializeArtifact(row: ArtifactRow) {
  return {
    id: row.id,
    booking_id: row.booking_id,
    kind: row.kind,
    file_name: row.file_name,
    mime_type: row.mime_type,
    // BIGINT arrives as a string from pg; the wire speaks numbers.
    file_size_bytes: Number(row.file_size_bytes),
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at ? new Date(row.uploaded_at).toISOString() : null,
    consent_attested_by: row.consent_attested_by,
    consent_attested_at: row.consent_attested_at
      ? new Date(row.consent_attested_at).toISOString()
      : null,
    consent_attestation_reason: row.consent_attestation_reason
  };
}

export default router;
