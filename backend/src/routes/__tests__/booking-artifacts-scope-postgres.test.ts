import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * THE CROSS-BOOKING ARTEFACT SCOPE, AGAINST A REAL DATABASE (cto/AdaptaLabs#99).
 *
 * booking-artifacts.test.ts already pins the media and delete routes' scope
 * clause (`WHERE a.id = $1 AND a.booking_id = $2`) with a mocked pool that
 * HONOURS its parameters - proven necessary by the #79 gate that found a
 * params-blind mock making the identical assertion vacuous (deleting the
 * `AND booking_id = $2` clause still passed all 48 tests there). But an
 * honouring mock is still a fixture standing in for Postgres: it proves the
 * route BINDS the right two parameters, not that a real join across two real
 * booking rows actually 404s a cross-booking artefact id. This is that proof,
 * following the #32 precedent (bookings-concurrency-postgres.test.ts) for why
 * it lives here rather than in the mocked suite: jest's pool is a mock and
 * cannot execute a real query against two real rows.
 *
 * Only the storage layer is stubbed below; every database call, including the
 * one inside `requireAdmin`'s live-role re-read, is the real pool against a
 * real Postgres.
 *
 * Runs in CI's `test-backend-db` (`npx vitest run postgres`); the no-DB
 * vitest job skips it via FIRSTHAND_SKIP_DB_TESTS.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

// A transcript artefact is used throughout: it skips the recording
// playable-mime re-check and the Range-forwarding path, neither of which this
// file is about. Only the storage layer is stubbed - the scope clause itself
// runs against the real database.
const headS3ObjectStat = vi.fn();
const createS3TranscriptArtifactResponse = vi.fn();

vi.mock("../../firsthand/runtime-object-storage-s3", () => ({
  createPresignedRecordingUploadUrl: vi.fn(),
  deleteS3Object: vi.fn(),
  headS3ObjectStat,
  createS3TranscriptArtifactResponse
}));

vi.mock("../../firsthand/object-storage", () => ({
  createRecordingAssetResponse: vi.fn()
}));

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

interface TwoBookings {
  ownerId: string;
  bookingA: string;
  bookingB: string;
  artifactB: string;
}

/**
 * Two bookings under the SAME owner, on purpose. A 404 on the wrong booking
 * then can only be the `booking_id` scope clause - the ownership gate
 * (`loadOwnedBooking`, already proven against a real database by
 * bookings-concurrency-postgres.test.ts's twin fixture shape and against a
 * mock by booking-artifacts.test.ts's ownership table) would 403 a
 * non-owner regardless of which booking the artefact actually belongs to, so
 * two owners here would leave it ambiguous which gate refused.
 */
async function seedTwoBookings(): Promise<TwoBookings> {
  const ownerId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'Owner', $2, 'researcher_admin')`,
    [ownerId, `owner-${ownerId}@example.com`]
  );

  async function seedBooking(): Promise<string> {
    const opportunityId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const bookingId = crypto.randomUUID();
    const participantId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status)
       VALUES ($1, 'test', 'Artefact scope test opportunity',
               'Proving the cross-booking artefact scope against a real database', $2, 'published')`,
      [opportunityId, ownerId]
    );
    await pool.query(
      `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
       VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 1 hour', 1, 1)`,
      [sessionId, opportunityId]
    );
    await pool.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Participant', $2)`, [
      participantId,
      `participant-${participantId}@example.com`
    ]);
    // No consent columns: the media route (unlike presign/finalize) never
    // re-checks consent - "a CANCELLED booking must still list, stream and
    // delete what was ingested while it was booked" applies just as much to
    // one that never recorded acceptance at all - so this fixture leaves them
    // null rather than fabricate a snapshot the shape constraint would demand.
    await pool.query(
      `INSERT INTO bookings (id, user_id, session_id, status)
       VALUES ($1, $2, $3, 'booked')`,
      [bookingId, participantId, sessionId]
    );
    return bookingId;
  }

  const bookingA = await seedBooking();
  const bookingB = await seedBooking();

  const artifactB = crypto.randomUUID();
  await pool.query(
    `INSERT INTO booking_artifacts
       (id, booking_id, kind, file_name, mime_type, file_size_bytes,
        storage_provider, relative_path, uploaded_by, etag)
     VALUES ($1, $2, 'transcript', 't.vtt', 'text/vtt', 100,
             's3', $3, $4, '"etag-b"')`,
    [artifactB, bookingB, `booking-artifacts/${bookingB}/t.vtt`, ownerId]
  );

  return { ownerId, bookingA, bookingB, artifactB };
}

describe.skipIf(skipDbTests)(
  "booking artefact media, cross-booking scope against real Postgres",
  () => {
    beforeAll(async () => {
      postgres = await startTestPostgres("booking-artifacts-scope");

      // BEFORE importing ../../config: the pool reads DATABASE_URL once, at
      // import.
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.SESSION_SECRET ||=
        "vitest-postgres-artifact-scope-constant-not-a-real-secret"; // gitleaks:allow
      process.env.NODE_ENV = "test";

      const { runMigrations } = await import("../../db/migrate");
      await runMigrations();

      const { pool: appPool } = await import("../../config");
      pool = appPool;

      const bookingArtifactsRouter = (await import("../booking-artifacts")).default;
      const { errorHandler } = await import("../../utils/errorHandler");
      const expressModule = (await import("express")).default;

      app = expressModule();
      app.use(expressModule.json());
      // Stand in for the real session middleware: `requireAdmin` only needs
      // req.session.user.id - it re-reads the role LIVE from the real users
      // table itself, which is the point of leaving it unmocked here.
      app.use((req, _res, next) => {
        const userId = req.header("x-test-user-id");
        if (userId) {
          (req as unknown as { session: { user: unknown } }).session = {
            user: { id: userId, name: "Test", email: "t@example.com", role: "researcher_admin" }
          };
        }
        next();
      });
      app.use("/api/bookings", bookingArtifactsRouter);
      app.use(errorHandler);
    }, 180_000);

    afterAll(async () => {
      // The jest global teardown that normally closes these does not run
      // under vitest, so close here or the open server holds the process open.
      await closeListeningServers();
      await pool?.end().catch(() => {});
      await postgres?.stop();
      delete process.env.DATABASE_URL;
    });

    beforeEach(async () => {
      await pool.query(
        "TRUNCATE bookings, sessions, opportunities, users, booking_artifacts CASCADE"
      );
      headS3ObjectStat.mockReset();
      createS3TranscriptArtifactResponse.mockReset();
      // A default for BOTH tests, including the 404 one: if a scope
      // regression ever lets that request reach storage, it should read as
      // the wrong artefact being served (200), not as an unrelated mock
      // throwing on an unstubbed call - the failure this test exists to name
      // is the scope clause, not the fixture.
      headS3ObjectStat.mockResolvedValue({ sizeBytes: 100, etag: '"etag-b"' });
      createS3TranscriptArtifactResponse.mockResolvedValue(
        new Response("WEBVTT\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } })
      );
    });

    it("404s an artefact requested through a booking that does not own it", async () => {
      const { ownerId, bookingA, artifactB } = await seedTwoBookings();

      const res = await request(listening(app))
        .get(`/api/bookings/${bookingA}/artifacts/${artifactB}/media`)
        .set("x-test-user-id", ownerId);

      expect(res.status).toBe(404);
      // The scope clause refused BEFORE storage was ever consulted - and this
      // is provably not the ownership gate (both bookings share one owner)
      // and not a missing artefact (the control below serves the identical
      // row through its own booking).
      expect(headS3ObjectStat).not.toHaveBeenCalled();
    });

    it("CONTROL: the identical artefact id serves through its own booking", async () => {
      const { ownerId, bookingB, artifactB } = await seedTwoBookings();

      const res = await request(listening(app))
        .get(`/api/bookings/${bookingB}/artifacts/${artifactB}/media`)
        .set("x-test-user-id", ownerId);

      expect(res.status).toBe(200);
      expect(headS3ObjectStat).toHaveBeenCalledWith(`booking-artifacts/${bookingB}/t.vtt`);
    });
  }
);
