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
  createS3TranscriptArtifactResponse: jest.fn(
    async () =>
      new Response('WEBVTT\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
  ),
}));

jest.mock('../../firsthand/object-storage', () => ({
  createRecordingAssetResponse: jest.fn(
    async () =>
      new Response('recording-bytes', {
        headers: {
          'Content-Type': 'video/webm',
          'Content-Length': '15',
          'Accept-Ranges': 'bytes',
          // The allowlist must FILTER, not forward wholesale - this header
          // must never reach the client.
          'X-Amz-Meta-Leak': 'should-not-forward',
        },
      })
  ),
}));

import bookingArtifactsRouter, {
  ARTIFACT_BOOKING_NOT_BOOKED,
  ARTIFACT_CONSENT_REQUIRED,
  ARTIFACT_ATTESTATION_REASON_EMPTY,
  ARTIFACT_TRANSCRIPT_MIME_REFUSED,
  ARTIFACT_RECORDING_MIME_REFUSED,
  ARTIFACT_ETAG_MISSING,
  ARTIFACT_MEDIA_UNVERIFIED,
  ARTIFACT_MEDIA_CHANGED,
} from '../booking-artifacts';
import { pool } from '../../config';
import {
  createPresignedRecordingUploadUrl,
  createS3TranscriptArtifactResponse,
  headS3ObjectStat,
  deleteS3Object,
} from '../../firsthand/runtime-object-storage-s3';
import { createRecordingAssetResponse } from '../../firsthand/object-storage';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockHead = headS3ObjectStat as unknown as jest.Mock;
const mockPresign = createPresignedRecordingUploadUrl as unknown as jest.Mock;
const mockDeleteObject = deleteS3Object as unknown as jest.Mock;
const mockRecordingResponse = createRecordingAssetResponse as unknown as jest.Mock;
const mockTranscriptResponse = createS3TranscriptArtifactResponse as unknown as jest.Mock;

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

  // The mock HONOURS ITS PARAMETERS, not just the SQL text. A review gate
  // proved the earlier text-only version made every scope-binding test
  // vacuous: deleting `AND booking_id = $2` from the media route passed all
  // 48 tests, because the fixture's null was doing the refusing, not the
  // clause. Now a lookup only answers when the route actually asked for the
  // fixture's own identifiers.
  mockQuery.mockImplementation(async (sql: unknown, rawParams: unknown) => {
    const text = String(sql);
    const params = rawParams as unknown[] | undefined;
    if (text.includes('FROM bookings b')) {
      return booking && params?.[0] === BOOKING
        ? { rows: [booking], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (text.includes('FROM pending_booking_artifact_uploads')) {
      return pending &&
        params?.[0] === pending.relative_path &&
        params?.[1] === BOOKING
        ? { rows: [pending], rowCount: 1 }
        : { rows: [], rowCount: 0 };
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
    if (text.includes('DELETE FROM booking_artifacts')) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM booking_artifacts ba')) {
      // The list, keyed by booking.
      return artifact && params?.[0] === BOOKING
        ? { rows: [artifact], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (text.includes('FROM booking_artifacts')) {
      // The scoped single-artefact lookups (media, delete): id AND booking.
      return artifact &&
        params?.[0] === artifact.id &&
        params?.[1] === BOOKING
        ? { rows: [artifact], rowCount: 1 }
        : { rows: [], rowCount: 0 };
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
  // mockImplementation, not mockResolvedValue: a Response body is consumable
  // once, so each call must mint a fresh one.
  mockRecordingResponse.mockImplementation(
    async () =>
      new Response('recording-bytes', {
        headers: {
          'Content-Type': 'video/webm',
          'Content-Length': '15',
          'Accept-Ranges': 'bytes',
          'X-Amz-Meta-Leak': 'should-not-forward',
        },
      }) as never
  );
  mockTranscriptResponse.mockImplementation(
    async () =>
      new Response('WEBVTT\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }) as never
  );
});

describe('ownership: every route is owner-or-superadmin through the booking join', () => {
  it.each([
    ['presign', () => request(listening(appAs('somebody-else'))).post(`/api/bookings/${BOOKING}/artifacts/presign`).send(PRESIGN_RECORDING)],
    ['finalize', () => request(listening(appAs('somebody-else'))).post(`/api/bookings/${BOOKING}/artifacts/finalize`).send({ object_key: 'k' })],
    ['list', () => request(listening(appAs('somebody-else'))).get(`/api/bookings/${BOOKING}/artifacts`)],
    ['delete', () => request(listening(appAs('somebody-else'))).delete(`/api/bookings/${BOOKING}/artifacts/artifact-1`)],
    ['media', () => request(listening(appAs('somebody-else'))).get(`/api/bookings/${BOOKING}/artifacts/artifact-1/media`)],
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

  it.each([
    ['a codepoint above U+00FF', 'video/mp4会'],
    ['a CR/LF pair', 'video/mp4\r\nx-injected: 1'],
  ])('refuses a mime type carrying %s - it becomes the serve-time Content-Type', async (_what, mime) => {
    // The file_name failure one field over: undici throws on the header at
    // serve, so a row storing this type serves never. Printable ASCII only.
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, mime_type: mime });

    expect(res.status).toBe(400);
    expect(callFor('INSERT INTO pending_booking_artifact_uploads')).toBeUndefined();
  });

  it('accepts a mime type with parameters - codecs strings are legitimate', async () => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, mime_type: 'video/webm;codecs="vp9,opus"' });

    expect(res.status).toBe(200);
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

  it.each([
    ['a double quote', 'evil".html"; filename*=UTF-8\'\'x.webm'],
    ['a CR/LF pair', 'call\r\nX-Injected: 1.webm'],
    ['a NUL byte', 'call\u0000.webm']
  ])('refuses a file name carrying %s - it reaches a Content-Disposition header at serve', async (_what, name) => {
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, file_name: name });

    expect(res.status).toBe(400);
    expect(callFor('INSERT INTO pending_booking_artifact_uploads')).toBeUndefined();
  });

  it('accepts a CJK file name and stores it RAW - header safety is owned by the encoder, not by refusing the name', async () => {
    // A review gate measured the failure this pins against: 会議.webm
    // presigned, uploaded and finalized cleanly, then 500ed on every serve,
    // because the old Content-Disposition interpolation threw on any
    // codepoint above U+00FF. buildInlineContentDisposition (unit-tested in
    // firsthand/__tests__/content-disposition.test.ts against a real Headers
    // object) now encodes at serve; refusing the researcher's own language
    // at upload was the trade not taken.
    arrange({ booking: { consent_accepted_at: new Date() } });

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/presign`)
      .send({ ...PRESIGN_RECORDING, file_name: '会議.webm' });

    expect(res.status).toBe(200);
    const insert = callFor('INSERT INTO pending_booking_artifact_uploads')!;
    expect(insert[1]).toContain('会議.webm');
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
    arrange({ artifact: { uploaded_by_name: 'Ada Researcher' } });

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts`);

    expect(res.status).toBe(200);
    const select = callFor('FROM booking_artifacts')!;
    expect(String(select[0])).toContain('WHERE ba.booking_id = $1');
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).not.toHaveProperty('relative_path');
    expect(res.body[0]).not.toHaveProperty('etag');
    expect(res.body[0].file_name).toBe('call.webm');
    // The uploader's NAME rides the list wire (a UUID is not a caption), from
    // the users join - populated in the fixture so this pin is not vacuous.
    expect(res.body[0].uploaded_by_name).toBe('Ada Researcher');
  });
});

describe('finalize refuses an upload the store returned no ETag for', () => {
  it('answers 422 by sentence and writes no artefact row - the null-etag decision, made explicitly', async () => {
    arrange({ pending: {} });
    mockHead.mockResolvedValue({ sizeBytes: 1024, etag: null } as never);

    const res = await request(listening(appAs(OWNER)))
      .post(`/api/bookings/${BOOKING}/artifacts/finalize`)
      .send({ object_key: `booking-artifacts/${BOOKING}/key.webm` });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(ARTIFACT_ETAG_MISSING);
    expect(callFor('INSERT INTO booking_artifacts')).toBeUndefined();
  });
});

describe('the media route: gate chain, then the ETag tripwire, then bytes', () => {
  it('streams a recording with the security headers and only allowlisted storage headers', async () => {
    arrange({ artifact: {} });

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts/artifact-1/media`)
      // supertest only buffers bodies of types it knows as text - a
      // video/webm body needs collecting by hand or res.text is undefined.
      .buffer(true)
      .parse((response, callback) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => callback(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['content-type']).toBe('video/webm');
    // The allowlist filters - a storage header off the list never forwards.
    expect(res.headers['x-amz-meta-leak']).toBeUndefined();
    expect(res.body).toBe('recording-bytes');
  });

  it('forwards the Range header into the storage read', async () => {
    arrange({ artifact: {} });

    await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts/artifact-1/media`)
      .set('Range', 'bytes=0-99');

    expect(mockRecordingResponse).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: `booking-artifacts/${BOOKING}/key.webm` }),
      { rangeHeader: 'bytes=0-99' }
    );
  });

  it('refuses when the live ETag differs from the stored one, by sentence, serving nothing', async () => {
    arrange({ artifact: {} });
    mockHead.mockResolvedValue({ sizeBytes: 1024, etag: '"etag-SWAPPED"' } as never);

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts/artifact-1/media`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(ARTIFACT_MEDIA_CHANGED);
    // The refusal happens BEFORE a byte is read - the object is not opened.
    expect(mockRecordingResponse).not.toHaveBeenCalled();
  });

  it('compares ETags shape-blind: a live tag without quotes still matches a stored quoted one', async () => {
    // The control for the mismatch test above: the tripwire fires on the
    // VALUE changing, never on quoting. A compare that read quoted-vs-bare as
    // different would refuse every serve forever - which looks exactly like
    // the tripwire working.
    arrange({ artifact: {} });
    mockHead.mockResolvedValue({ sizeBytes: 1024, etag: 'etag-abc123' } as never);

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts/artifact-1/media`);

    expect(res.status).toBe(200);
  });

  it.each([
    ['stored', { artifact: { etag: null } }, { sizeBytes: 1024, etag: '"etag-abc123"' }],
    ['live', { artifact: {} }, { sizeBytes: 1024, etag: null }],
  ])('fails closed when the %s ETag is null, by its own sentence', async (_side, over, head) => {
    arrange(over as Parameters<typeof arrange>[0]);
    mockHead.mockResolvedValue(head as never);

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts/artifact-1/media`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(ARTIFACT_MEDIA_UNVERIFIED);
    expect(mockRecordingResponse).not.toHaveBeenCalled();
  });

  it('a missing object is a 404, not a served hole', async () => {
    arrange({ artifact: {} });
    mockHead.mockResolvedValue(null as never);

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts/artifact-1/media`);

    expect(res.status).toBe(404);
  });

  it('scope-binds the artefact to the booking in the path - 404, and storage never consulted', async () => {
    arrange({ artifact: null });

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts/artifact-from-elsewhere/media`);

    expect(res.status).toBe(404);
    expect(mockHead).not.toHaveBeenCalled();
    expect(mockRecordingResponse).not.toHaveBeenCalled();
    // The CLAUSE, pinned by text: the params-honouring mock makes the 404
    // above real behaviour, but a mutated SQL that dropped the binding would
    // still PASS both params, so only the text can see the clause go. This
    // assertion anchors the booking-artifact-media-scope-binding canary.
    const lookup = callFor('FROM booking_artifacts a')!;
    expect(String(lookup[0])).toContain('WHERE a.id = $1 AND a.booking_id = $2');
    expect(lookup[1]).toEqual(['artifact-from-elsewhere', BOOKING]);
  });

  it('refuses a recording row whose stored mime is not playable - the read-side twin', async () => {
    // The write side refuses these at presign, but rows outlive route
    // versions; a text/html "recording" served inline under an admin cookie
    // is stored XSS, so the read side re-checks.
    arrange({ artifact: { mime_type: 'text/html' } });

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts/artifact-1/media`);

    expect(res.status).toBe(404);
    expect(mockHead).not.toHaveBeenCalled();
  });

  it('sends a clean 500 with no stale content headers when the stream errors before any bytes', async () => {
    // The precedent's own gate, ported (session-outputs-internal.test.ts):
    // leaving content-type behind would label the JSON error body video/webm.
    arrange({ artifact: {} });
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('s3 body read failed'));
      },
    });
    mockRecordingResponse.mockResolvedValue(
      new Response(failing, {
        status: 200,
        headers: {
          'Content-Type': 'video/webm',
          'Content-Length': '1024',
          'Accept-Ranges': 'bytes',
          'Content-Disposition': 'inline; filename="call.webm"',
        },
      }) as never
    );

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts/artifact-1/media`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('artifact_media_stream_failed');
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['accept-ranges']).toBeUndefined();
  });

  it('serves a transcript as text through the transcript path, ETag-checked like a recording', async () => {
    arrange({ artifact: { kind: 'transcript', file_name: 't.vtt', mime_type: 'text/vtt', relative_path: `booking-artifacts/${BOOKING}/t.vtt` } });

    const res = await request(listening(appAs(OWNER)))
      .get(`/api/bookings/${BOOKING}/artifacts/artifact-1/media`);

    expect(res.status).toBe(200);
    expect(mockTranscriptResponse).toHaveBeenCalledWith(`booking-artifacts/${BOOKING}/t.vtt`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.text).toBe('WEBVTT\n');
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
    // Same text pin as the media twin - the mock honours params, but only
    // the text can see the WHERE clause itself narrow.
    const lookup = mockQuery.mock.calls.find(
      (call: unknown[]) =>
        String(call[0]).includes('FROM booking_artifacts') &&
        String(call[0]).includes('consent_attested_by')
    )!;
    expect(String(lookup[0])).toContain('WHERE id = $1 AND booking_id = $2');
    expect(lookup[1]).toEqual(['artifact-from-elsewhere', BOOKING]);
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
