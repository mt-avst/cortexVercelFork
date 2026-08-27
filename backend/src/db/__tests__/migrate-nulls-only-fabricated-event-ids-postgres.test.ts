import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";

/**
 * THE MIGRATION MUST NULL THE FABRICATED EVENT IDS AND NOTHING ELSE
 * (cto/AdaptaLabs#89).
 *
 * Until this release `CalendarService.createEvent` simulated its writes and
 * answered `{ success: true, eventId: 'demo-event-<now>' }`, and the booking
 * route wrote that id into `bookings.gcal_event_id`. So production rows record
 * Google events that have never existed - and the cancel and reschedule paths
 * are both gated on that column being truthy, so each one chases a phantom.
 *
 * The migration nulls them. A gate then proved the statement was completely
 * unguarded: deleting it passed 1553 jest and 716 vitest tests, and - worse -
 * deleting only its `WHERE` clause, so it nulls EVERY id on every boot, also
 * passed both suites. That mutation is harmless today because every stored id
 * is fabricated. The moment the per-user OAuth work lands and real Google ids
 * exist, it is silent data loss on every restart with no named failure
 * anywhere.
 *
 * So the predicate gets a test that can only pass against a real database:
 * a row that must be nulled beside rows that must survive.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

let postgres: TestPostgres;
let pool: pg.Pool;
let runMigrations: () => Promise<void>;

/** A booking row with a given `gcal_event_id`, and the ids it needs to exist. */
async function seedBooking(label: string, gcalEventId: string | null): Promise<string> {
  const { rows: userRows } = await pool.query(
    `INSERT INTO users (name, email, role) VALUES ($1, $2, 'employee') RETURNING id`,
    [`User ${label}`, `${label}@example.com`]
  );
  const userId = userRows[0].id;

  const { rows: oppRows } = await pool.query(
    `INSERT INTO opportunities (title, type, purpose_one_liner, status, owner_user_id)
     VALUES ($1, 'interview', $2, 'published', $3) RETURNING id`,
    [`Study ${label}`, 'Checking a thing', userId]
  );

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO sessions (opportunity_id, start_time, end_time, capacity)
     VALUES ($1, NOW() + interval '7 days', NOW() + interval '7 days 30 minutes', 1)
     RETURNING id`,
    [oppRows[0].id]
  );

  const { rows: bookingRows } = await pool.query(
    `INSERT INTO bookings (user_id, session_id, status, gcal_event_id)
     VALUES ($1, $2, 'booked', $3) RETURNING id`,
    [userId, sessionRows[0].id, gcalEventId]
  );
  return bookingRows[0].id;
}

const idOf = async (bookingId: string): Promise<string | null> => {
  const { rows } = await pool.query(`SELECT gcal_event_id FROM bookings WHERE id = $1`, [bookingId]);
  return rows[0].gcal_event_id;
};

describe.skipIf(skipDbTests)("the migration nulls fabricated calendar event ids", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("migrate-demo-event-ids");

    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-migrate-demo-event-ids-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { pool: appPool } = await import("../../config");
    pool = appPool;
    runMigrations = (await import("../migrate")).runMigrations;
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations();
  }, 180_000);

  it("nulls a demo-event- id", async () => {
    const booking = await seedBooking("demo", "demo-event-1787829699354");

    await runMigrations();

    expect(await idOf(booking)).toBeNull();
  });

  it("LEAVES A REAL GOOGLE EVENT ID ALONE", async () => {
    /*
     * THE ARM THAT MATTERS MOST, and the one the suite existed without.
     *
     * Deleting the statement's `WHERE gcal_event_id LIKE 'demo-event-%'` makes
     * it null every id on every boot. That passes the first arm above - the
     * demo id still ends up null - and passes the whole rest of the repo,
     * because no stored id is real yet. This arm is the only thing that can see
     * it, and what it protects is a researcher's live calendar event surviving
     * a pod restart once the OAuth work lands.
     *
     * The shape is a real Google event id: base32hex, no prefix.
     */
    const booking = await seedBooking("real", "6bl2p9k1e8m4qr0tvhc7ndj5ao");

    await runMigrations();

    expect(await idOf(booking)).toBe("6bl2p9k1e8m4qr0tvhc7ndj5ao");
  });

  it.each([
    ["a user-calendar demo id", "demo-user-event-1787829699354"],
    ["a prefixed lookalike", "xdemo-event-1"],
    ["an underscore-prefixed lookalike", "a_demo-event-1"],
    ["a different case", "DEMO-EVENT-123"],
    // Added because a gate found `LIKE 'demo-event%'` - the hyphen dropped -
    // survived every other arm. The exposure was nil (no real Google id starts
    // `demo-event`), but a predicate that looks covered and is not is the thing
    // this file exists to stop.
    ["the prefix without its trailing hyphen", "demo-eventXYZ"],
  ])("leaves %s alone, because LIKE is anchored, hyphenated and case-sensitive", async (_name, value) => {
    const booking = await seedBooking(`v${value.replace(/[^a-z0-9]/gi, "")}`, value);

    await runMigrations();

    expect(await idOf(booking)).toBe(value);
  });

  it("is idempotent, so a restart is a no-op", async () => {
    const demo = await seedBooking("idem", "demo-event-1");
    const real = await seedBooking("idemreal", "9zx8w7v6u5t4s3r2q1p0onmlkj");

    await runMigrations();
    await runMigrations();
    await runMigrations();

    expect(await idOf(demo)).toBeNull();
    expect(await idOf(real)).toBe("9zx8w7v6u5t4s3r2q1p0onmlkj");
  });
});
