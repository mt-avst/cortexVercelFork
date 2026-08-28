import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

import { listening } from '../../__tests__/helpers/listening';

/**
 * Booking artefacts (#79 step 2): the ingest surface for recordings and
 * transcripts of a moderated session. The rules under test, each in both
 * directions:
 *
 *  - every route is owner-or-superadmin through the booking join; a wrong
 *    owner is 403, a foreign booking id is 404
 *  - a cancelled booking refuses ingest BY SENTENCE (F14)
 *  - the D3 gate at presign AND finalize: recorded acceptance, or a TYPED
 *    attestation reason - never a bare boolean, never silence
 *  - transcript mime and BOTH size ceilings pinned as literals - a test that
 *    derives its expectation from the constant cannot see the constant change
 *  - the object key is server-derived; a hostile file name cannot steer it
 *  - finalize trusts only the pending row and HeadObject: unknown key 403,
 *    expired 410, missing object 422, oversize deleted-then-413
 *  - responses never carry relative_path - the media route mints URLs
 */

jest.mock('../../middleware/authenticate');

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

// redactSensitiveUrl included because errorHandler imports it from this same
// module - a factory holding only `logger` makes every 400 a bodiless 500.
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  redactSensitiveUrl: (url: string | undefined) => url,
}));

jest.mock('../../firsthand/runtime-object-storage-s3', () => ({
  createPresignedRecordingUploadUrl: jest.fn(async () => 'https://s3.example/put-url'),
  headS3ObjectStat: jest.fn(async () => ({ sizeBytes: 1024, etag: '"etag-abc123"' })),
  deleteS3Object: jest.fn(async () => undefined),
}));

import bookingArtifactsRouter, {
  ARTIFACT_BOOKING_NOT_BOOKED,
  ARTIFACT_CONSENT_REQUIRED,
  ARTIFACT_ATTESTATION_REASON_EMPTY,
  ARTIFACT_TRANSCRIPT_MIME_REFUSED,
  ARTIFACT_RECORDING_MIME_REFUSED,
} from '../booking-artifacts';
import { pool } from '../../config';
import {
  createPresignedRecordingUploadUrl,
  headS3ObjectStat,
  deleteS3Object,
} from '../../firsthand/runtime-object-storage-s3';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockHead = headS3ObjectStat as unknown as jest.Mock;
const mockPresign = createPresignedRecordingUploadUrl as unknown as jest.Mock;
const mockDeleteObject = deleteS3Object as unknown as jest.Mock;

const OWNER = 'owner-1';
const BOOKING = 'b0000000-0000-4000-8000-000000000001';

const appAs = (id: string, role: 'researcher_admin' | 'superadmin' = 'researcher_admin') => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: string } } }).session = {
      user: { id, name: 'R', email: 'r@example.com', role },
    };
    next();
  });
  app.use('/api/bookings', bookingArtifactsRouter);
  app.use(errorHandler);
  return app;
};

/**
 * Routes every statement by its table. `over` swaps individual answers -
 * pass `null` for the booking to make it not exist.
 */
const arrange = (over: {
  booking?: Record<string, unknown> | null;
  pending?: Record<string, unknown> | null;
  artifact?: Record<string, unknown> | null;
} = {}) => {
  const booking =
    over.booking === null
      ? null
      : {
          id: BOOKING,
          status: 'booked',
          owner_user_id: OWNER,
          consent_accepted_at: null,
          ...(over.booking ?? {}),
        };
  const pending =
    over.pending === undefined || over.pending === null
      ? null
      : {
          id: 'pending-1',
          booking_id: BOOKING,
          kind: 'recording',
          file_name: 'call.webm',
          mime_type: 'video/webm',
          relative_path: `booking-artifacts/${BOOKING}/key.webm`,
          consent_attestation_reason: 'Consent taken verbally at the start of the call',
          valid_until: new Date(Date.now() + 10 * 60 * 1000),
          ...over.pending,
        };
  const artifact =
    over.artifact === undefined || over.artifact === null
      ? null
      : {
          id: 'artifact-1',
          booking_id: BOOKING,
          kind: 'recording',
          file_name: 'call.webm',
          mime_type: 'video/webm',
          file_size_bytes: '1024',
          storage_provider: 's3',
          relative_path: `booking-artifacts/${BOOKING}/key.webm`,
          uploaded_by: OWNER,
          uploaded_at: new Date('2026-08-28T12:00:00Z'),
          // POPULATED, or the etag exclusion pin below is vacuous - a fixture
          // that cannot produce the property proves nothing about the map
          // (the step 1b lesson, reintroduced once by a fix round and caught
          // by its gate).
          etag: '"etag-abc123"',
          consent_attested_by: null,
          consent_attested_at: null,
          consent_attestation_reason: null,
          ...over.artifact,
        };

  mockQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('FROM bookings b')) {
      return booking ? { rows: [booking], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (text.includes('FROM pending_booking_artifact_uploads')) {
      return pending ? { rows: [pending], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (text.includes('INSERT INTO booking_artifacts')) {
      return { rows: [artifact ?? {
        id: 'artifact-1',
        booking_id: BOOKING,
        kind: 'recording',
        file_name: 'call.webm',
        mime_type: 'video/webm',
        file_size_bytes: '1024',
        storage_provider: 's3',
        relative_path: `booking-artifacts/${BOOKING}/key.webm`,
        uploaded_by: OWNER,
        uploaded_at: new Date('2026-08-28T12:00:00Z'),
        etag: '"etag-abc123"',
        consent_attested_by: OWNER,
        consent_attested_at: new Date('2026-08-28T12:00:00Z'),
        consent_attestation_reason: 'Consent taken verbally at the start of the call',
      }], rowCount: 1 };
    }
    if (text.includes('FROM booking_artifacts')) {
      return artifact ? { rows: [artifact], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
};

const statements = () => mockQuery.mock.calls.map((call: unknown[]) => String(call[0]));

const callFor = (fragment: string) =>
  mockQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes(fragment));

const PRESIGN_RECORDING = {
  kind: 'recording',
  file_name: 'call.webm',
  mime_type: 'video/webm',
  file_size_bytes: 1024,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockHead.mockResolvedValue({ sizeBytes: 1024, etag: '"etag-abc123"' } as never);
  mockDeleteObject.mockResolvedValue(undefined as never);
  mockPresign.mockResolvedValue('https://s3.example/put-url' as never);
});

describe('ownership: every route is owner-or-superadmin through the booking join', () => {
  it.each([
    ['presign', () => request(listening(appAs('somebody-else'))).post(`/api/bookings/${BOOKING}/artifacts/presign`).send(PRESIGN_RECORDING)],
    ['finalize', () => request(listening(appAs('somebody-else'))).post(`/api/bookings/${BOOKING}/artifacts/finalize`).send({ object_key: 'k' })],
    ['list', () => request(listening(appAs('somebody-else'))).get(`/api/bookings/${BOOKING}/artifacts`)],
    ['delete', () => request(listening(appAs('somebody-else'))).delete(`/api/bookings/${BOOKING}/artifacts/artifact-1`)],
  ])('%s refuses a researcher who does not own the opportunity', async (_name, send) => {
    arrange();

    const res = await send();

    expect(res.status).toBe(403);
    // The SENTENCE, not just the status: finalize answers 403 for an
    // unregistered upload too, and a neutered ownership gate sailed this
    // table's finalize arm on that other guard's status alone.
    expect(res.body.error).toBe(
      'Only the owner or a superadmin can manage artefacts for this booking'
    );
    // Nothing written or presigned for a refused caller.
    expect(statements().filter((sql) => sql.includes('INSERT'))).toEqual([]);
  });

  it('admits a superadmin who owns nothing', async () => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs('super-1', 'superadmin')))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send(PRESIGN_RECORDING);

    expect(res.status).toBe(200);
  });

  it('a booking that does not exist is a 404, not a 403', async () => {
    arrange({ booking: null });

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts`);

    expect(res.status).toBe(404);
  });
});

describe('a cancelled booking refuses ingest by sentence (F14)', () => {
  it.each(['presign', 'finalize'])('%s refuses on a cancelled booking', async (route) => {
    arrange({ booking: { status: 'cancelled' }, pending: {} });

    const res =
      route === 'presign'
        ? await request(listening(appAs(OWNER)))
            .post(`/api/bookings/${BOOKING}/artifacts/presign`)
            .send(PRESIGN_RECORDING)
        : await request(listening(appAs(OWNER)))
            .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
            .send({ object_key: `booking-artifacts/${BOOKING}/key.webm` });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ARTIFACT_BOOKING_NOT_BOOKED);
  });
});

describe('the D3 gate: acceptance or a typed attestation, at presign AND finalize', () => {
  it('refuses presign with neither, by the exact sentence', async () => {
    arrange();

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send(PRESIGN_RECORDING);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ARTIFACT_CONSENT_REQUIRED);
    expect(callFor('INSERT INTO pending_booking_artifact_uploads')).toBeUndefined();
  });

  it('refuses a whitespace-only attestation reason - a bare boolean in disguise', async () => {
    arrange();

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, consent_attestation_reason: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ARTIFACT_ATTESTATION_REASON_EMPTY);
  });

  it('presigns with a typed reason and registers it on the pending row', async () => {
    arrange();

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({
        ...PRESIGN_RECORDING,
        consent_attestation_reason: 'Consent taken verbally at the start of the call',
      });

    expect(res.status).toBe(200);
    const insert = callFor('INSERT INTO pending_booking_artifact_uploads')!;
    expect(insert[1]).toContain('Consent taken verbally at the start of the call');
  });

  it('recorded acceptance needs no attestation, and outranks a volunteered one', async () => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({
        ...PRESIGN_RECORDING,
        consent_attestation_reason: 'A weaker claim than the acceptance on the row',
      });

    expect(res.status).toBe(200);
    // The pending row records NO attestation: the booking's own acceptance is
    // the stronger record, and an attestation beside it would muddy which one
    // authorised the ingest.
    const insert = callFor('INSERT INTO pending_booking_artifact_uploads')!;
    expect(insert[1]).not.toContain('A weaker claim than the acceptance on the row');
    expect((insert[1] as unknown[])).toContain(null);
  });

  it('refuses finalize when the pending row carries no reason and the booking no acceptance', async () => {
    arrange({ pending: { consent_attestation_reason: null } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
      .send({ object_key: `booking-artifacts/${BOOKING}/key.webm` });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ARTIFACT_CONSENT_REQUIRED);
    expect(callFor('INSERT INTO booking_artifacts')).toBeUndefined();
  });

  it('finalize persists the PRESIGN-time reason as the attestation', async () => {
    arrange({ pending: {} });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
      .send({ object_key: `booking-artifacts/${BOOKING}/key.webm` });

    expect(res.status).toBe(201);
    const insert = callFor('INSERT INTO booking_artifacts')!;
    const values = insert[1] as unknown[];
    expect(values).toContain('Consent taken verbally at the start of the call');
    // attested_by/at derive from the reason param in SQL - the same
    // CASE-WHEN-null shape the booking INSERT uses for its timestamp.
    expect(String(insert[0])).toContain('CASE WHEN');
  });
});

describe('mime and size ceilings, pinned as literals', () => {
  it('refuses a transcript that is not vtt or plain text, by sentence', async () => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ kind: 'transcript', file_name: 't.pdf', mime_type: 'application/pdf', file_size_bytes: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ARTIFACT_TRANSCRIPT_MIME_REFUSED);
  });

  it.each(['text/vtt', 'TEXT/PLAIN'])('accepts a %s transcript, case-blind', async (mime) => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ kind: 'transcript', file_name: 't.vtt', mime_type: mime, file_size_bytes: 100 });

    expect(res.status).toBe(200);
  });

  it('refuses a recording that is neither video nor audio, by sentence', async () => {
    // The write-side twin of the read-side playable gate: the normaliser only
    // defaults EMPTY types, so without this a text/html "recording" stores
    // with that type signed into the PUT - stored XSS waiting for the step 3
    // serving route.
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, mime_type: 'text/html' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ARTIFACT_RECORDING_MIME_REFUSED);
    expect(callFor('INSERT INTO pending_booking_artifact_uploads')).toBeUndefined();
  });

  it('accepts an audio recording - the gate is playable, not video-only', async () => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, file_name: 'call.m4a', mime_type: 'audio/mp4' });

    expect(res.status).toBe(200);
  });

  it('caps a recording at 2147483648 bytes - the literal, not the constant', async () => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const over = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, file_size_bytes: 2147483649 });
    expect(over.status).toBe(413);

    const at = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, file_size_bytes: 2147483648 });
    expect(at.status).toBe(200);
  });

  it('caps a transcript at 10485760 bytes - the literal, not the constant', async () => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const over = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ kind: 'transcript', file_name: 't.vtt', mime_type: 'text/vtt', file_size_bytes: 10485761 });
    expect(over.status).toBe(413);

    const at = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ kind: 'transcript', file_name: 't.vtt', mime_type: 'text/vtt', file_size_bytes: 10485760 });
    expect(at.status).toBe(200);
  });
});

describe('the object key is server-derived', () => {
  it('a hostile file name cannot steer the key out of the booking prefix', async () => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, file_name: '../../recordings/other/steal.webm' });

    expect(res.status).toBe(200);
    expect(res.body.objectKey).toMatch(new RegExp(`^booking-artifacts/${BOOKING}/`));
    // The invariant is that the CLIENT contributes no path separators: the
    // suffix after the fixed prefix is a single segment. Literal dots survive
    // sanitisation ("..") but with every slash flattened to an underscore
    // they are inert text in a flat S3 keyspace, not traversal.
    const suffix = res.body.objectKey.slice(`booking-artifacts/${BOOKING}/`.length);
    expect(suffix.length).toBeGreaterThan(0);
    expect(suffix).not.toContain('/');
  });

  it('writes NO pending row when signing fails - sign first, insert after', async () => {
    // A deployment without S3 makes the presigner throw. The first version
    // inserted the row and THEN signed, leaking one orphan pending row per
    // failed attempt - a review gate proved it with exactly this arrangement.
    arrange({ booking: { consent_accepted_at: new Date() } });
    mockPresign.mockRejectedValue(new Error('S3 storage is not configured') as never);

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send(PRESIGN_RECORDING);

    expect(res.status).toBe(500);
    expect(callFor('INSERT INTO pending_booking_artifact_uploads')).toBeUndefined();
  });

  it('refuses a body carrying any unknown key - the schema is strict', async () => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, relative_path: 'attacker-chosen' });

    expect(res.status).toBe(400);
  });
});

describe('finalize trusts the pending row and HeadObject, nothing else', () => {
  it('refuses an object key nobody registered, 403', async () => {
    arrange({ pending: null });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
      .send({ object_key: 'booking-artifacts/unregistered/key.webm' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unknown_upload');
  });

  it('scope-binds the pending row to the booking in the path', async () => {
    arrange({ pending: {} });

    await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
      .send({ object_key: `booking-artifacts/${BOOKING}/key.webm` });

    const lookup = callFor('FROM pending_booking_artifact_uploads')!;
    expect(String(lookup[0])).toContain('booking_id = $2');
    expect(lookup[1]).toContain(BOOKING);
  });

  it('refuses an expired window, 410', async () => {
    arrange({ pending: { valid_until: new Date(Date.now() - 1000) } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
      .send({ object_key: `booking-artifacts/${BOOKING}/key.webm` });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe('upload_expired');
  });

  it('refuses when no object was actually uploaded, 422', async () => {
    arrange({ pending: {} });
    mockHead.mockResolvedValue(null as never);

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
      .send({ object_key: `booking-artifacts/${BOOKING}/key.webm` });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('uploaded_object_missing');
  });

  it('deletes an oversize object, drops the pending row and answers 413', async () => {
    arrange({ pending: {} });
    mockHead.mockResolvedValue({ sizeBytes: 2147483649, etag: '"etag-big"' } as never);

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
      .send({ object_key: `booking-artifacts/${BOOKING}/key.webm` });

    expect(res.status).toBe(413);
    expect(mockDeleteObject).toHaveBeenCalledWith(`booking-artifacts/${BOOKING}/key.webm`);
    expect(callFor('DELETE FROM pending_booking_artifact_uploads')).toBeDefined();
    expect(callFor('INSERT INTO booking_artifacts')).toBeUndefined();
  });

  it('records the size HeadObject measured, never the size the body claimed', async () => {
    arrange({ pending: {} });
    mockHead.mockResolvedValue({ sizeBytes: 555, etag: '"etag-555"' } as never);

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
      .send({ object_key: `booking-artifacts/${BOOKING}/key.webm` });

    expect(res.status).toBe(201);
    const values = callFor('INSERT INTO booking_artifacts')![1] as unknown[];
    expect(values).toContain(555);
    // The ETag rides into the row: the presigned URL outlives finalize, so a
    // re-PUT can swap the bytes - the stored ETag is what lets the step 3
    // media route refuse the swapped object.
    expect(values).toContain('"etag-555"');
    // And the pending row is consumed - a finalize that leaves it behind can
    // be replayed.
    expect(callFor('DELETE FROM pending_booking_artifact_uploads')).toBeDefined();
  });
});

describe('responses never carry the raw object key', () => {
  it('finalize serialises the artefact without relative_path', async () => {
    arrange({ pending: {} });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
      .send({ object_key: `booking-artifacts/${BOOKING}/key.webm` });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('relative_path');
    expect(res.body).not.toHaveProperty('etag');
    // The control: the map is real, and BIGINT strings become numbers.
    expect(res.body.kind).toBe('recording');
    expect(typeof res.body.file_size_bytes).toBe('number');
  });

  it('list scopes to the booking and serialises without relative_path', async () => {
    arrange({ artifact: {} });

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts`);

    expect(res.status).toBe(200);
    const select = callFor('FROM booking_artifacts')!;
    expect(String(select[0])).toContain('WHERE booking_id = $1');
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).not.toHaveProperty('relative_path');
    expect(res.body[0].file_name).toBe('call.webm');
  });
});

describe('delete removes the object first, then the row', () => {
  it('deletes both and answers 204', async () => {
    arrange({ artifact: {} });

    const res = await request(listening(appAs(OWNER)))
      .delete(`/api/bookings/${BOOKING}/artifacts/artifact-1`);

    expect(res.status).toBe(204);
    expect(mockDeleteObject).toHaveBeenCalledWith(`booking-artifacts/${BOOKING}/key.webm`);
    expect(callFor('DELETE FROM booking_artifacts')).toBeDefined();
  });

  it('scope-binds the artefact to the booking in the path - 404 otherwise', async () => {
    arrange({ artifact: null });

    const res = await request(listening(appAs(OWNER)))
      .delete(`/api/bookings/${BOOKING}/artifacts/artifact-from-elsewhere`);

    expect(res.status).toBe(404);
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(callFor('DELETE FROM booking_artifacts')).toBeUndefined();
  });

  it('an already-absent object still removes the row - no orphan rows over holes', async () => {
    arrange({ artifact: {} });
    const gone = new Error('gone');
    gone.name = 'NotFound';
    mockDeleteObject.mockRejectedValue(gone as never);

    const res = await request(listening(appAs(OWNER)))
      .delete(`/api/bookings/${BOOKING}/artifacts/artifact-1`);

    expect(res.status).toBe(204);
    expect(callFor('DELETE FROM booking_artifacts')).toBeDefined();
  });

  it('any other storage failure leaves the row - the pointer stays honest', async () => {
    arrange({ artifact: {} });
    mockDeleteObject.mockRejectedValue(new Error('S3 fell over') as never);

    const res = await request(listening(appAs(OWNER)))
      .delete(`/api/bookings/${BOOKING}/artifacts/artifact-1`);

    expect(res.status).toBe(500);
    expect(callFor('DELETE FROM booking_artifacts')).toBeUndefined();
  });
});
