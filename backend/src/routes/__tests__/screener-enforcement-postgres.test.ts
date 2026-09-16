import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";
import { bookingConsentText } from "../../../../shared/firsthand/consent-templates";
import { SCREENER_NOT_PASSED, SCREENER_NONE_TO_ANSWER } from "../../services/screener";

/**
 * SCREENER ENFORCEMENT, AGAINST A REAL DATABASE.
 *
 * The screener's whole value is that the three apply chokepoints refuse anyone
 * without a stored 'qualified' verdict. That refusal is a real row lookup on
 * opportunity_screener_responses, so - like the booking race next door - it is
 * unobservable under the jest mocked pool and lives here as a `*-postgres.test.ts`
 * suite (jest ignores the suffix, vitest collects it).
 *
 * A `test`-type opportunity is used so the booking path is realistic; the
 * screener gate sits BEFORE the consent gate, so a screened-out participant is
 * refused without any consent being involved, and the qualified path passes
 * consent by echoing the same wording the handler resolves.
 */
const skipDbTests = process.env.FIRSTHAND_SKIP_DB_TESTS === "1";

vi.mock("../../services/email", () => ({
  __esModule: true,
  default: { sendEmail: vi.fn(async () => ({ success: true, messageId: "test" })) },
  EmailService: {
    getBookingConfirmationTemplate: vi.fn(() => ({})),
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

const SCREENER = {
  questions: [
    {
      id: "role",
      prompt: "Which best describes your role?",
      options: [
        { id: "eng", label: "Engineer", disqualifies: false },
        { id: "sales", label: "Sales", disqualifies: true },
      ],
    },
  ],
};

async function seedUser(role = "employee"): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'User', $2, $3)`,
    [id, `user-${id}@example.com`, role]
  );
  return id;
}

async function seedOpportunity(opts: {
  ownerId: string;
  screener?: unknown;
  type?: string;
  status?: string;
  deliveryMode?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status, delivery_mode, screener)
     VALUES ($1, $2, 'Screener enforcement opportunity',
             'Proving screener enforcement against a real database', $3, $4, $5, $6::jsonb)`,
    [
      id,
      opts.type ?? "test",
      opts.ownerId,
      opts.status ?? "published",
      opts.deliveryMode ?? "external",
      opts.screener ? JSON.stringify(opts.screener) : null,
    ]
  );
  return id;
}

async function seedSession(opportunityId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, opportunity_id, start_time, end_time, capacity, booked_count)
     VALUES ($1, $2, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 1 hour', 1, 0)`,
    [id, opportunityId]
  );
  return id;
}

/** Write a verdict directly, to test enforcement without going through the endpoint. */
async function setVerdict(opportunityId: string, userId: string, outcome: string): Promise<void> {
  await pool.query(
    `INSERT INTO opportunity_screener_responses
       (opportunity_id, user_id, outcome, answers, questions_snapshot)
     VALUES ($1, $2, $3, '{}'::jsonb, '[]'::jsonb)`,
    [opportunityId, userId, outcome]
  );
}

const MODERATED_CONSENT = bookingConsentText("test", null);

function book(sessionId: string, userId: string, withConsent = false) {
  return request(listening(app))
    .post(`/api/bookings/sessions/${sessionId}/book`)
    .set("x-test-user-id", userId)
    .send(withConsent ? { consent_accepted: true, consent_text_seen: MODERATED_CONSENT } : {});
}

function submit(opportunityId: string, userId: string, answers: unknown) {
  return request(listening(app))
    .post(`/api/opportunities/${opportunityId}/screener`)
    .set("x-test-user-id", userId)
    .send({ answers });
}

describe.skipIf(skipDbTests)("screener enforcement against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("screener-enforcement");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-screener-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

    const bookingsRouter = (await import("../bookings")).default;
    const opportunitiesRouter = (await import("../opportunities")).default;
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
    app.use("/api/opportunities", opportunitiesRouter);
    app.use(errorHandler);
  }, 180_000);

  afterAll(async () => {
    await closeListeningServers();
    await pool?.end().catch(() => {});
    await postgres?.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE opportunity_screener_responses, bookings, sessions, opportunities, users CASCADE"
    );
  });

  describe("booking gate", () => {
    it("allows a booking when the opportunity has no screener", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner });
      const session = await seedSession(opportunity);

      await book(session, participant, true).expect(201);
    });

    it("refuses a booking when a screener exists and the participant has no verdict", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, screener: SCREENER });
      const session = await seedSession(opportunity);

      const response = await book(session, participant).expect(403);
      expect(response.body.error).toBe(SCREENER_NOT_PASSED);
    });

    it("refuses a booking when the participant was screened out", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, screener: SCREENER });
      const session = await seedSession(opportunity);
      await setVerdict(opportunity, participant, "screened_out");

      const response = await book(session, participant).expect(403);
      expect(response.body.error).toBe(SCREENER_NOT_PASSED);
    });

    it("allows a booking when the participant has a qualified verdict", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, screener: SCREENER });
      const session = await seedSession(opportunity);
      await setVerdict(opportunity, participant, "qualified");

      await book(session, participant, true).expect(201);
    });
  });

  describe("submission endpoint", () => {
    it("qualifies on passing answers, stores the verdict, and the booking then succeeds", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, screener: SCREENER });
      const session = await seedSession(opportunity);

      const submission = await submit(opportunity, participant, { role: "eng" }).expect(200);
      expect(submission.body.outcome).toBe("qualified");

      await book(session, participant, true).expect(201);
    });

    it("screens out on a disqualifying answer, and the booking is then refused", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, screener: SCREENER });
      const session = await seedSession(opportunity);

      const submission = await submit(opportunity, participant, { role: "sales" }).expect(200);
      expect(submission.body.outcome).toBe("screened_out");

      await book(session, participant).expect(403);
    });

    it("400s when the opportunity has no screener to answer", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner });

      const response = await submit(opportunity, participant, { role: "eng" }).expect(400);
      expect(response.body.error).toContain(SCREENER_NONE_TO_ANSWER);
    });

    it("400s on an answer that is missing or not one of the question's options", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, screener: SCREENER });

      await submit(opportunity, participant, {}).expect(400);
      await submit(opportunity, participant, { role: "not-an-option" }).expect(400);
    });

    it("lets a screened-out participant retake and qualify, keeping one verdict row", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, screener: SCREENER });
      const session = await seedSession(opportunity);

      await submit(opportunity, participant, { role: "sales" }).expect(200);
      await book(session, participant).expect(403);

      const retake = await submit(opportunity, participant, { role: "eng" }).expect(200);
      expect(retake.body.outcome).toBe("qualified");

      const rows = await pool.query(
        "SELECT count(*)::int AS n FROM opportunity_screener_responses WHERE opportunity_id = $1 AND user_id = $2",
        [opportunity, participant]
      );
      expect(rows.rows[0].n).toBe(1);

      await book(session, participant, true).expect(201);
    });

    it("snapshots the questions, so editing the screener later does not rewrite a stored verdict", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, screener: SCREENER });

      await submit(opportunity, participant, { role: "eng" }).expect(200);

      // Edit the opportunity's screener to a different question set.
      const editedScreener = {
        questions: [
          {
            id: "different",
            prompt: "A different question",
            options: [
              { id: "a", label: "A", disqualifies: false },
              { id: "b", label: "B", disqualifies: true },
            ],
          },
        ],
      };
      await pool.query("UPDATE opportunities SET screener = $2::jsonb WHERE id = $1", [
        opportunity,
        JSON.stringify(editedScreener),
      ]);

      const stored = await pool.query(
        "SELECT outcome, questions_snapshot FROM opportunity_screener_responses WHERE opportunity_id = $1 AND user_id = $2",
        [opportunity, participant]
      );
      expect(stored.rows[0].outcome).toBe("qualified");
      // The snapshot is the ORIGINAL question, not the edited one.
      expect(stored.rows[0].questions_snapshot).toEqual(SCREENER.questions);
    });
  });

  describe("mint gates", () => {
    it("refuses to mint a recorded session when the participant has no verdict", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      // Unmoderated + published + a screener; the screener gate fires before the
      // linked-study check, so no study needs to exist to prove the refusal.
      const opportunity = await seedOpportunity({
        ownerId: owner,
        screener: SCREENER,
        type: "unmoderated",
      });

      const response = await request(listening(app))
        .post(`/api/opportunities/${opportunity}/recorded-study-session`)
        .set("x-test-user-id", participant)
        .expect(403);
      expect(response.body.error).toBe(SCREENER_NOT_PASSED);
    });

    it("refuses to mint a native survey session when the participant has no verdict", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      // A native survey + published + a screener; the gate fires before the
      // linked-study check, so no study needs to exist to prove the refusal.
      const opportunity = await seedOpportunity({
        ownerId: owner,
        screener: SCREENER,
        type: "survey",
        deliveryMode: "native",
      });

      const response = await request(listening(app))
        .post(`/api/opportunities/${opportunity}/survey-session`)
        .set("x-test-user-id", participant)
        .expect(403);
      expect(response.body.error).toBe(SCREENER_NOT_PASSED);
    });
  });

  describe("participant screener status on the opportunity payload", () => {
    const getAsParticipant = (opportunityId: string, userId: string) =>
      request(listening(app))
        .get(`/api/opportunities/${opportunityId}`)
        .set("x-test-user-id", userId);

    it("reports answered:false and the redacted screener before the participant takes it", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, screener: SCREENER });

      const response = await getAsParticipant(opportunity, participant).expect(200);
      expect(response.body.screenerStatus).toEqual({ answered: false });
      // Redacted: the participant payload carries the questions but no flags.
      expect(JSON.stringify(response.body.screener)).not.toContain("disqualifies");
    });

    it("reports the stored verdict once the participant has answered", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner, screener: SCREENER });
      await setVerdict(opportunity, participant, "qualified");

      const response = await getAsParticipant(opportunity, participant).expect(200);
      expect(response.body.screenerStatus).toEqual({ answered: true, outcome: "qualified" });
    });

    it("omits screenerStatus for an opportunity with no screener", async () => {
      const owner = await seedUser("researcher_admin");
      const participant = await seedUser();
      const opportunity = await seedOpportunity({ ownerId: owner });

      const response = await getAsParticipant(opportunity, participant).expect(200);
      expect(response.body.screenerStatus).toBeUndefined();
    });
  });
});
