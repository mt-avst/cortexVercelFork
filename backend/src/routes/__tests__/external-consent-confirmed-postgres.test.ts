import crypto from "node:crypto";

import type express from "express";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startTestPostgres, type TestPostgres } from "../../__tests__/helpers/postgres-instance";
import { closeListeningServers, listening } from "../../__tests__/helpers/listening";

/**
 * EXTERNAL-DELIVERY CONSENT AFFIRMATION, AGAINST A REAL DATABASE.
 *
 * cto/AdaptaLabs#136. `external_consent_confirmed` is the author's checkbox
 * affirming the external tool handling a hand-off study collects its own
 * consent - previously CLIENT-ONLY (OpportunityFormData), absent from every
 * save payload and defaulted on load to `status === 'published'`, so an
 * author's confirmation vanished on reload. This is the persistence half:
 * a nullable boolean column, written on create and PATCH, read back on the
 * owner/admin payload, and stripped from the participant payload the same
 * way owner identity is (it is authoring metadata, not a participant fact).
 *
 * NULL is a real, distinct state - "never recorded", which is every
 * opportunity that predates this column - and must never collapse into
 * `false`. It deliberately does NOT gate publish (decided 2026-09-21 - see
 * the publish-validation call sites in this router for why).
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

async function seedUser(role = "researcher_admin"): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, role) VALUES ($1, 'User', $2, $3)`,
    [id, `user-${id}@example.com`, role]
  );
  return id;
}

/** A published opportunity written directly, to test the read/serialiser paths. */
async function seedPublishedOpportunity(opts: {
  ownerId: string;
  externalConsentConfirmed?: boolean | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO opportunities (id, type, title, purpose_one_liner, owner_user_id, status, delivery_mode, external_consent_confirmed)
     VALUES ($1, 'poll', 'External consent opportunity', 'Advertising an audience', $2, 'published', 'external', $3)`,
    [id, opts.ownerId, opts.externalConsentConfirmed ?? null]
  );
  return id;
}

const CREATE_BODY = {
  type: "poll",
  title: "A study handed off to an external tool",
  purpose_one_liner: "So the participant answers on the external service",
  delivery_mode: "external" as const,
  external_link_optional: "https://example.com/survey",
};

const create = (userId: string, body: Record<string, unknown>) =>
  request(listening(app))
    .post("/api/opportunities")
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "researcher_admin")
    .send(body);

const patch = (opportunityId: string, userId: string, body: Record<string, unknown>) =>
  request(listening(app))
    .patch(`/api/opportunities/${opportunityId}`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "researcher_admin")
    .send(body);

const getAsAdmin = (opportunityId: string, userId: string) =>
  request(listening(app))
    .get(`/api/opportunities/${opportunityId}`)
    .set("x-test-user-id", userId)
    .set("x-test-user-role", "researcher_admin");

const getAsParticipant = (opportunityId: string, userId: string) =>
  request(listening(app))
    .get(`/api/opportunities/${opportunityId}`)
    .set("x-test-user-id", userId);

describe.skipIf(skipDbTests)("external-delivery consent affirmation against real Postgres", () => {
  beforeAll(async () => {
    postgres = await startTestPostgres("external-consent-confirmed");
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.SESSION_SECRET ||=
      "vitest-postgres-external-consent-constant-not-a-real-secret"; // gitleaks:allow
    process.env.NODE_ENV = "test";

    const { runMigrations } = await import("../../db/migrate");
    await runMigrations();

    const { pool: appPool } = await import("../../config");
    pool = appPool;

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
    await pool.query("TRUNCATE opportunities, users CASCADE");
  });

  describe("the create write path", () => {
    it("stores true and reads it back on the admin payload", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: true,
      }).expect(201);

      expect(created.body.external_consent_confirmed).toBe(true);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBe(true);
    });

    it("stores false distinctly from null", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: false,
      }).expect(201);

      expect(created.body.external_consent_confirmed).toBe(false);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBe(false);
    });

    it("stores null when the field is never sent, distinct from false", async () => {
      const admin = await seedUser();
      const created = await create(admin, CREATE_BODY).expect(201);

      expect(created.body.external_consent_confirmed).toBeNull();

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBeNull();
    });

    it("refuses a non-boolean value by name", async () => {
      const admin = await seedUser();
      const res = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: "yes",
      }).expect(400);

      expect(res.body.error).toBe("Validation failed");
      expect(res.body.details.join(" ")).toContain("external_consent_confirmed");
    });
  });

  describe("the update write path", () => {
    it("flips false to true", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: false,
      }).expect(201);

      await patch(created.body.id, admin, { external_consent_confirmed: true }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBe(true);
    });

    it("clears a recorded value back to null", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: true,
      }).expect(201);

      await patch(created.body.id, admin, { external_consent_confirmed: null }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBeNull();
    });

    it("refuses a non-boolean value on update by name", async () => {
      const admin = await seedUser();
      const created = await create(admin, CREATE_BODY).expect(201);

      const res = await patch(created.body.id, admin, {
        external_consent_confirmed: "yes",
      }).expect(400);

      expect(res.body.error).toBe("Validation failed");
      expect(res.body.details.join(" ")).toContain("external_consent_confirmed");
    });
  });

  /**
   * RELINKING RESETS THE AFFIRMATION.
   *
   * The affirmation is about ONE external destination. Left alone across a
   * change of `external_link_optional`, a `true` made about tool A silently
   * reads as an affirmation about tool B. It gates nothing, but Review would
   * say "confirmed" for a tool nobody confirmed, and any provenance added
   * later (cto/AdaptaLabs#126) would record an attestation nobody made.
   *
   * This reset is the FLOOR, not the whole fix. Cortex's own form clears the
   * tick in state when the author edits the link, so a relink saved from the
   * UI arrives with the link changed and the affirmation absent - the shape
   * the reset is waiting for. Without that clear the form sent the new link
   * and the stale `true` together and the exception below honoured it, so
   * these arms were green while the bug was reachable through the UI; the
   * clear is pinned in OpportunityForm.external-consent.test.tsx. What the
   * reset still covers on its own is every other client: a direct API caller
   * cannot leave a `true` about tool A on a row pointing at tool B.
   *
   * Reset to NULL - "never recorded" - rather than false, because the author
   * has said nothing about the new destination, not no.
   *
   * The one exception is a deliberate re-affirmation: a PATCH carrying BOTH a
   * new link and an explicit boolean is the author confirming the new tool in
   * the same breath, and the explicit value wins.
   */
  describe("relinking an external study", () => {
    it("resets a recorded affirmation to null when the link changes", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: true,
      }).expect(201);
      expect(created.body.external_consent_confirmed).toBe(true);

      await patch(created.body.id, admin, {
        external_link_optional: "https://other.example.com/different-survey",
      }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBeNull();
      expect(read.body.external_link_optional).toBe(
        "https://other.example.com/different-survey"
      );
    });

    it("keeps an explicit affirmation sent in the same patch as the new link", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: true,
      }).expect(201);

      await patch(created.body.id, admin, {
        external_link_optional: "https://other.example.com/different-survey",
        external_consent_confirmed: true,
      }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBe(true);
    });

    it("honours an explicit false sent alongside a new link", async () => {
      // The other half of "the explicit boolean wins". Without this arm, a
      // reset that ran unconditionally would be indistinguishable from the
      // rule, because null and false both read as unconfirmed on Review.
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: true,
      }).expect(201);

      await patch(created.body.id, admin, {
        external_link_optional: "https://other.example.com/different-survey",
        external_consent_confirmed: false,
      }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBe(false);
    });

    it("leaves the affirmation alone when the patch sets the same link again", async () => {
      // The form re-sends the whole shape on every save, so the common case is
      // a link field that is present and unchanged. A reset that fired on mere
      // PRESENCE would clear the affirmation on every ordinary save.
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: true,
      }).expect(201);

      await patch(created.body.id, admin, {
        external_link_optional: CREATE_BODY.external_link_optional,
        title: "A study handed off to an external tool, retitled",
      }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBe(true);
      expect(read.body.title).toBe(
        "A study handed off to an external tool, retitled"
      );
    });

    it("leaves the affirmation alone on a patch that never mentions the link", async () => {
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: true,
      }).expect(201);

      await patch(created.body.id, admin, {
        title: "A study handed off to an external tool, renamed",
      }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBe(true);
    });

    it("treats the same link with surrounding whitespace as unchanged", async () => {
      // `.url()` accepts a padded string - the URL constructor strips leading
      // and trailing spaces - and the column loop stores it trimmed. Comparing
      // the raw request value against the stored one would therefore call a
      // stray space "a different tool" and clear a good affirmation.
      const admin = await seedUser();
      const created = await create(admin, {
        ...CREATE_BODY,
        external_consent_confirmed: true,
      }).expect(201);

      await patch(created.body.id, admin, {
        external_link_optional: `  ${CREATE_BODY.external_link_optional}  `,
      }).expect(200);

      const read = await getAsAdmin(created.body.id, admin).expect(200);
      expect(read.body.external_consent_confirmed).toBe(true);
      expect(read.body.external_link_optional).toBe(
        CREATE_BODY.external_link_optional
      );
    });
  });

  /**
   * WHO CAN READ IT, MEASURED RATHER THAN ASSERTED IN A COMMENT.
   *
   * The column's comments in migrate.ts and shared/types say it reaches every
   * admin, not only the owner - and until this arm existed that claim rested
   * on an ad-hoc probe run once by hand. `GET /:id` branches on
   * `isAdminRole(req.user?.role)` alone: ownership does not narrow the payload
   * and neither does status, so a researcher_admin who did not create the
   * study reads the affirmation in full. Under CORTEX_BETA_ALL_ADMIN that is
   * every signed-in employee, which is why the claim is worth pinning.
   */
  describe("the admin payload's reach", () => {
    it("serves the affirmation to an admin who does not own the study", async () => {
      const owner = await seedUser();
      const otherAdmin = await seedUser();
      const created = await create(owner, {
        ...CREATE_BODY,
        external_consent_confirmed: true,
      }).expect(201);

      const read = await getAsAdmin(created.body.id, otherAdmin).expect(200);
      expect(read.body.external_consent_confirmed).toBe(true);
      // The control: this really is the owner/admin payload and not the
      // participant one, which strips owner identity by the same destructure.
      expect(read.body.owner_user_id).toBe(owner);
    });

    it("serves it to a non-owning admin on a published study too", async () => {
      // The arm above reads a DRAFT, which only an admin can see at all. This
      // one covers the other side of that branch, so the claim is about the
      // admin payload rather than about drafts being special.
      const owner = await seedUser();
      const otherAdmin = await seedUser();
      const opportunity = await seedPublishedOpportunity({
        ownerId: owner,
        externalConsentConfirmed: false,
      });

      const read = await getAsAdmin(opportunity, otherAdmin).expect(200);
      expect(read.body.external_consent_confirmed).toBe(false);
      expect(read.body.owner_user_id).toBe(owner);
    });
  });

  describe("the participant payload", () => {
    it("redacts the field entirely from a participant read", async () => {
      const owner = await seedUser();
      const participant = await seedUser("employee");
      const opportunity = await seedPublishedOpportunity({
        ownerId: owner,
        externalConsentConfirmed: true,
      });

      const read = await getAsParticipant(opportunity, participant).expect(200);
      expect(read.body).not.toHaveProperty("external_consent_confirmed");
    });

    it("still redacts it when the recorded value is null", async () => {
      const owner = await seedUser();
      const participant = await seedUser("employee");
      const opportunity = await seedPublishedOpportunity({
        ownerId: owner,
        externalConsentConfirmed: null,
      });

      const read = await getAsParticipant(opportunity, participant).expect(200);
      expect(read.body).not.toHaveProperty("external_consent_confirmed");
    });
  });
});
