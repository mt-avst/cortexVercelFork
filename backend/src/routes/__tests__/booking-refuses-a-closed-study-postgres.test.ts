import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";
import { bookingConsentText } from "../../../../shared/firsthand/consent-templates";

/**
 * THE BOOKING PATH REFUSES A STUDY THAT HAS CLOSED, AGAINST A REAL DATABASE
 * (cto/AdaptaLabs#143).
 *
 * Sibling MR #129 taught the two participant-mint routes to refuse a study
 * whose `end_date` has passed; the moderated booking path was out of that
 * ticket's scope and never gained the equivalent check. A study with
 * `end_date` a year in the past and one FUTURE slot could still be booked, and
 * an existing booking could still be rescheduled onto that same future slot -
 * both were a 2xx before this fix, because the only closure check on this path
 * was the per-slot `end_time` guard, which a future slot always passes.
 *
 * WHY REAL POSTGRES (mandatory, same reasoning as
 * mint-refuses-a-closed-study-postgres.test.ts): the fix reads `end_date` off
 * a row this suite seeds and locks with `FOR UPDATE NOWAIT` inside a real
 * transaction. The jest suite next door mocks the pool, so it can hand the
 * handler a row shaped however a test likes but cannot prove the SELECT this
 * route actually issues carries the column at all.
 *
 * `type: 'test'` throughout (not `unmoderated`, as the mint suite uses): the
 * booking routes only exist for the MODERATED types (`MODERATED_CONSENT_TYPES`
 * = test, interview), and the bug this closes is specifically that a moderated
 * study's closure went unchecked on this path. Consent is accepted on every
 * booking below by echoing the baseline template `bookingConsentText`
 * resolves for a `null` `consent_text` - the consent gate is not what is under
 * test here.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

/** The refusal, spelled as literals so a reworded route fails here by name -
 * the same code and sentence the mint routes already send (cto/AdaptaLabs#129). */
const CLOSED_REFUSAL = "This study has closed and is no longer accepting participants.";
const CLOSED_REFUSAL_CODE = "OPPORTUNITY_CLOSED";

vi.mock("../../services/email", () => ({
  __esModule: true,
  default: { sendEmail: vi.fn(async () => ({ success: true, messageId: "test" })) },
  EmailService: {
    getBookingConfirmationTemplate: vi.fn(() => ({})),
    getBookingCancellationTemplate: vi.fn(() => ({})),
    getAdminNotificationTemplate: vi.fn(() => ({})),
  },
}));

vi.mock("../../services/calendar", () => ({
  __esModule: true,
  default: {
    createEvent: vi.fn(async () => ({ success: true, eventId: "evt" })),
    updateEvent: vi.fn(async () => ({ success: true })),
    deleteEvent: vi.fn(async () => ({ success: true })),
  },
}));

let postgres: TestPostgres;
let pool: pg.Pool;
let app: express.Express;

async function seedUser(role = "employee"): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, name, email, role) VALUES ($1, 'User', $2, $3)`, [
    id,
    `user-${id}@example.com`,
    role,
  ]);
  return id;
}

async function seedOpportunity(opts: {
  ownerId: string;
  status?: string;
  /** SQL interval added to NOW(), or null for no end date at all. */
  endDateOffset?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status, delivery_mode, end_date)
     VALUES ($1, 'test', 'Closed-study booking fixture',
             'Proving the booking path refuses a study that has closed', $2, $3, 'external',
             CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() + $4::interval END)`,
    [id, opts.ownerId, opts.status ?? "published", opts.endDateOffset ?? null]
  );
  return id;
}

/** One slot, placed relative to NOW() by the given SQL interval. */
async function seedSession(opportunityId: string, startOffset: string, endOffset: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
     VALUES ($1, $2, NOW() + $3::interval, NOW() + $4::interval, 2, 0)`,
    [id, opportunityId, startOffset, endOffset]
  );
  return id;
}

const MODERATED_CONSENT = bookingConsentText("test", null);

function book(sessionId: string, userId: string) {
  return request(listening(app))
    .post(`/api/bookings/sessions/${sessionId}/book`)
    .set("x-test-user-id", userId)
    .send({ consent_accepted: true, consent_text_seen: MODERATED_CONSENT });
}

function reschedule(bookingId: string, targetSessionId: string, userId: string) {
  return request(listening(app))
    .post(`/api/bookings/${bookingId}/reschedule`)
    .set("x-test-user-id", userId)
    .send({ target_session_id: targetSessionId });
}

/** Books the given session directly, bypassing the route under test, so a
 * reschedule test starts from a booking already made before the study closed. */
async function seedBooking(userId: string, sessionId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO bookings (id, user_id, session_id, status) VALUES ($1, $2, $3, 'booked')`,
    [id, userId, sessionId]
  );
  await pool.query(`UPDATE sessions SET booked_count = booked_count + 1 WHERE id = $1`, [sessionId]);
  return id;
}

describe.skipIf(skipDbTests)("booking routes refuse a study that has closed", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("closed-study-booking");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-closed-study-booking-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    const bookingsRouter = (await import("../bookings")).default;
    const { errorHandler } = await import("../../utils/errorHandler");
    const expressModule = (await import("express")).default;

    app = expressModule();
    app.use(expressModule.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user-id");
      const role = req.header("x-test-user-role") ?? "employee";
      if (userId) {
        (req as unknown as { session: { user: unknown } }).session = {
          user: { id: userId, name: "Test", email: "t@example.com", role },
        };
      }
      next();
    });
    app.use("/api/bookings", bookingsRouter);
    app.use(errorHandler);
  }, 180_000);

  afterAll(async () => {
    await closeListeningServers();
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE bookings, sessions, opportunities, users CASCADE");
  });

  describe("book", () => {
    it("refuses a published study whose end date has passed, even with a future slot open", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, endDateOffset: "-365 days" });
      const session = await seedSession(opportunity, "1 day", "1 day 1 hour");

      const response = await book(session, participant);
      expect(response.status).toBe(403);
      expect(response.body.error).toBe(CLOSED_REFUSAL);
      expect(response.body.code).toBe(CLOSED_REFUSAL_CODE);

      // CONTROL on the refusal itself: nothing was booked.
      const rows = await pool.query("SELECT count(*)::int AS n FROM bookings WHERE session_id = $1", [
        session,
      ]);
      expect(rows.rows[0].n).toBe(0);
    });

    it("still books a study whose end date is ahead, with a future slot open (control)", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, endDateOffset: "365 days" });
      const session = await seedSession(opportunity, "1 day", "1 day 1 hour");

      await book(session, participant).expect(201);
    });

    it("still books an undated study with a future slot open (control)", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, endDateOffset: null });
      const session = await seedSession(opportunity, "1 day", "1 day 1 hour");

      await book(session, participant).expect(201);
    });

    it("still refuses a past slot on an open study (the pre-existing end_time guard, unregressed)", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, endDateOffset: "365 days" });
      const session = await seedSession(opportunity, "-2 days", "-1 day");

      const response = await book(session, participant);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Cannot book past sessions");
    });
  });

  describe("reschedule", () => {
    it("refuses moving an existing booking onto a future slot of a study whose end date has passed", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      // Booked while still open, closed afterwards - proving the guard is
      // read fresh at reschedule time, not inherited from the original book.
      const opportunity = await seedOpportunity({ ownerId: owner, endDateOffset: "1 day" });
      const originalSession = await seedSession(opportunity, "12 hours", "13 hours");
      const booking = await seedBooking(participant, originalSession);
      const targetSession = await seedSession(opportunity, "2 days", "2 days 1 hour");

      await pool.query("UPDATE opportunities SET end_date = NOW() - INTERVAL '365 days' WHERE id = $1", [
        opportunity,
      ]);

      const response = await reschedule(booking, targetSession, participant);
      expect(response.status).toBe(403);
      expect(response.body.error).toBe(CLOSED_REFUSAL);
      expect(response.body.code).toBe(CLOSED_REFUSAL_CODE);

      // CONTROL: the booking never moved off its original session.
      const stored = await pool.query("SELECT session_id FROM bookings WHERE id = $1", [booking]);
      expect(stored.rows[0].session_id).toBe(originalSession);
    });

    it("still reschedules onto a future slot of a study whose end date is ahead (control)", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, endDateOffset: "365 days" });
      const originalSession = await seedSession(opportunity, "12 hours", "13 hours");
      const booking = await seedBooking(participant, originalSession);
      const targetSession = await seedSession(opportunity, "2 days", "2 days 1 hour");

      await reschedule(booking, targetSession, participant).expect(200);

      const stored = await pool.query("SELECT session_id FROM bookings WHERE id = $1", [booking]);
      expect(stored.rows[0].session_id).toBe(targetSession);
    });

    it("still refuses rescheduling onto a past slot (the pre-existing end_time guard, unregressed)", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, endDateOffset: "365 days" });
      const originalSession = await seedSession(opportunity, "12 hours", "13 hours");
      const booking = await seedBooking(participant, originalSession);
      const pastSession = await seedSession(opportunity, "-2 days", "-1 day");

      const response = await reschedule(booking, pastSession, participant);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Cannot reschedule to past sessions");
    });
  });
});
