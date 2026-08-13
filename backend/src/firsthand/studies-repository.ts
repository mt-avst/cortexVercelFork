
import type { PoolClient } from "pg";

import { stepTypeSchema, type Study, type StudyStep } from "../../../shared/firsthand/contract";
import {
  isPostgresRuntimeConfigured,
  withRuntimeDatabaseClient
} from "./runtime-database";

export type StudyStatus = "draft" | "launched" | "archived";

export type StudyRecord = Study & {
  status: StudyStatus;
  // Null for a study created before owners existed and not claimable from an
  // opportunity by migration 0007. See canWriteStudy for what that permits.
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type StudyWithSteps = {
  study: StudyRecord;
  steps: StudyStep[];
};

/**
 * Who is asking. Mirrors the opportunities ownership check
 * (routes/opportunities.ts: `if (!isSuperadmin && !isOwner) throw Forbidden`),
 * except that the decision is taken inside the repository transaction so the
 * owner cannot change between the check and the write.
 */
export type StudyRequester = {
  userId: string;
  isSuperadmin: boolean;
};

export type StudyWriteFailure = { ok: false; reason: "not_found" | "forbidden" };

/**
 * `claimed` reports that this update gave an unowned legacy study an owner.
 * Returned rather than logged here so the repository stays free of request
 * context, and so the transfer is visible to a test without a logger mock.
 */
export type StudyUpdateResult =
  | ({ ok: true; claimed: boolean } & StudyWithSteps)
  | StudyWriteFailure;

export type StudyDeleteResult = { ok: true } | StudyWriteFailure;

export type CreateStudyInput = {
  id?: string;
  title: string;
  intro_text: string;
  consent_text: string;
  brand_name?: string;
  estimated_duration_minutes?: number;
  locale?: string;
  status?: StudyStatus;
  // The authoring user. Optional in the type only so a caller with no user
  // context (a script, a fixture) can still insert; every HTTP path passes one.
  owner_user_id?: string | null;
  steps: StudyStep[];
};

export type UpdateStudyInput = {
  title?: string;
  intro_text?: string;
  consent_text?: string;
  brand_name?: string | null;
  estimated_duration_minutes?: number | null;
  locale?: string | null;
  status?: StudyStatus;
  // Superadmin-only reassignment. Rejected as forbidden for anyone else, and
  // deliberately not nullable - see updateStudy.
  owner_user_id?: string;
  steps?: StudyStep[];
};

type StudyRow = {
  id: string;
  title: string;
  intro_text: string;
  consent_text: string;
  brand_name: string | null;
  estimated_duration_minutes: number | null;
  locale: string | null;
  status: string;
  owner_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type StudyStepRow = {
  id: string;
  study_id: string;
  step_order: number;
  type: string;
  prompt: string;
  target_url: string | null;
  helper_text: string | null;
  is_required: boolean;
  options: string[] | null;
};

export function isStudiesPersistenceConfigured() {
  return isPostgresRuntimeConfigured();
}

export async function listStudies(): Promise<StudyRecord[]> {
  if (!isPostgresRuntimeConfigured()) {
    return [];
  }

  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query<StudyRow>(
      `
        SELECT id, title, intro_text, consent_text, brand_name,
               estimated_duration_minutes, locale, status, owner_user_id,
               created_at, updated_at
        FROM studies
        ORDER BY updated_at DESC, title ASC
      `
    );

    return result.rows.map(mapStudyRow);
  });
}

export async function getStudyById(studyId: string): Promise<StudyWithSteps | null> {
  if (!isPostgresRuntimeConfigured()) {
    return null;
  }

  return withRuntimeDatabaseClient(async (client) => {
    return loadStudyWithSteps(client, studyId);
  });
}

export async function createStudy(input: CreateStudyInput): Promise<StudyWithSteps> {
  ensurePostgresConfigured();
  validateSteps(input.steps);

  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      const studyId = input.id ?? `study_${crypto.randomUUID()}`;
      const status = input.status ?? "draft";

      await client.query(
        `
          INSERT INTO studies (
            id, title, intro_text, consent_text, brand_name,
            estimated_duration_minutes, locale, status, owner_user_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          studyId,
          input.title,
          input.intro_text,
          input.consent_text,
          input.brand_name ?? null,
          input.estimated_duration_minutes ?? null,
          input.locale ?? null,
          status,
          input.owner_user_id ?? null
        ]
      );

      await insertStudySteps(client, studyId, input.steps);

      const stored = await loadStudyWithSteps(client, studyId);

      if (!stored) {
        throw new Error("Study was inserted but could not be re-loaded.");
      }

      await client.query("COMMIT");
      return stored;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function updateStudy(
  studyId: string,
  input: UpdateStudyInput,
  requester: StudyRequester
): Promise<StudyUpdateResult> {
  ensurePostgresConfigured();

  if (input.steps) {
    validateSteps(input.steps);
  }

  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      // FOR UPDATE, not a plain read: without the row lock two admins editing
      // the same unowned study would both see NULL and both claim it, and the
      // loser's authorisation decision would have been taken against an owner
      // that no longer holds by the time their UPDATE lands.
      const ownerResult = await client.query<{ owner_user_id: string | null }>(
        `SELECT owner_user_id FROM studies WHERE id = $1 FOR UPDATE`,
        [studyId]
      );
      const ownerRow = ownerResult.rows[0];

      if (!ownerRow) {
        await client.query("COMMIT");
        return { ok: false, reason: "not_found" } as const;
      }

      if (!canWriteStudy(ownerRow.owner_user_id, requester)) {
        // ROLLBACK rather than COMMIT: nothing was written, and releasing the
        // FOR UPDATE lock promptly matters more than the empty transaction.
        await client.query("ROLLBACK");
        return { ok: false, reason: "forbidden" } as const;
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      const push = (column: string, value: unknown) => {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      };

      if (input.title !== undefined) push("title", input.title);
      if (input.intro_text !== undefined) push("intro_text", input.intro_text);
      if (input.consent_text !== undefined) push("consent_text", input.consent_text);
      if (input.brand_name !== undefined) push("brand_name", input.brand_name);
      if (input.estimated_duration_minutes !== undefined) {
        push("estimated_duration_minutes", input.estimated_duration_minutes);
      }
      if (input.locale !== undefined) push("locale", input.locale);
      if (input.status !== undefined) push("status", input.status);

      // An explicit reassignment wins over the adopt-on-write claim below, and
      // is superadmin-only. This is the ONLY way to correct an owner - notably
      // one migration 0007 inferred from an opportunity that a different admin
      // happened to create first - and there is no database console to do it
      // by hand, so without it a mis-attributed study is unfixable. Null is
      // not accepted: handing a row back to the fail-open is not a repair.
      const reassigningOwner = input.owner_user_id !== undefined;
      if (reassigningOwner && !requester.isSuperadmin) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "forbidden" } as const;
      }

      const claimed = claimsOwnership(
        ownerRow.owner_user_id,
        requester,
        input,
        updates.length
      );

      if (reassigningOwner) {
        push("owner_user_id", input.owner_user_id);
      } else if (claimed) {
        push("owner_user_id", requester.userId);
      }

      if (updates.length > 0) {
        updates.push("updated_at = NOW()");
        values.push(studyId);
        await client.query(
          `UPDATE studies SET ${updates.join(", ")} WHERE id = $${values.length}`,
          values
        );
      }

      if (input.steps) {
        await client.query(`DELETE FROM study_steps WHERE study_id = $1`, [studyId]);
        await insertStudySteps(client, studyId, input.steps);

        if (updates.length === 0) {
          await client.query(`UPDATE studies SET updated_at = NOW() WHERE id = $1`, [
            studyId
          ]);
        }
      }

      const stored = await loadStudyWithSteps(client, studyId);

      if (!stored) {
        // Unreachable while the FOR UPDATE lock above is held, so treat it as
        // a broken invariant rather than reporting a 404 the caller cannot act
        // on.
        throw new Error("Study was updated but could not be re-loaded.");
      }

      await client.query("COMMIT");
      return { ok: true, claimed, ...stored } as const;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/**
 * Owner-gated delete for the HTTP route.
 *
 * Note the asymmetry with updateStudy: a delete cannot adopt the row it is
 * removing, so an unowned legacy study stays deletable by any admin. That is
 * the pre-existing behaviour, not a new hole - and migration 0007 gave an
 * owner to every study an opportunity points at, which is the population where
 * a delete does real damage (it breaks a published opportunity).
 */
export async function deleteStudy(
  studyId: string,
  requester: StudyRequester
): Promise<StudyDeleteResult> {
  ensurePostgresConfigured();

  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      const ownerResult = await client.query<{ owner_user_id: string | null }>(
        `SELECT owner_user_id FROM studies WHERE id = $1 FOR UPDATE`,
        [studyId]
      );
      const ownerRow = ownerResult.rows[0];

      if (!ownerRow) {
        await client.query("COMMIT");
        return { ok: false, reason: "not_found" } as const;
      }

      if (!canWriteStudy(ownerRow.owner_user_id, requester)) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "forbidden" } as const;
      }

      await client.query(`DELETE FROM studies WHERE id = $1`, [studyId]);
      await client.query("COMMIT");
      return { ok: true } as const;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/**
 * Unauthorised delete, for the compensating rollback in the opportunity
 * create/update handlers: those delete a study THEY just created, moments
 * earlier, because the opportunity insert failed - studies live on the
 * FirstHand runtime pool and opportunities on the app pool, so no single
 * transaction spans both and this delete is the only thing standing between a
 * failed request and an orphaned launched study.
 *
 * It deliberately skips the ownership check. That rollback must not be
 * blocked, and the ownership of a study created two statements ago is not a
 * meaningful question. Never reach for this from a route handler.
 */
export async function deleteStudyUnchecked(studyId: string): Promise<boolean> {
  ensurePostgresConfigured();

  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query(`DELETE FROM studies WHERE id = $1`, [studyId]);
    return (result.rowCount ?? 0) > 0;
  });
}

/**
 * Give an unowned study an owner at the moment it is attached to an
 * opportunity. Returns true when this call was the one that claimed it.
 *
 * Without this, the write boundary is still crossable end to end. A legacy
 * study left unowned by migration 0007 - a standalone study no opportunity
 * referenced, which is exactly what the studies UI produces - can be picked
 * from the reuse list by its author, published, and THEN rewritten by any
 * other researcher_admin through the null fail-open in canWriteStudy: new
 * consent copy, new task target_url, served to employees under recording. A
 * study only ever reaches a participant through an opportunity, so claiming at
 * link time is what closes that path.
 *
 * `AND owner_user_id IS NULL` makes this atomic and idempotent in one
 * statement: linking a study someone already owns leaves their ownership
 * alone, and two concurrent linkers cannot both claim.
 */
export async function claimStudyIfUnowned(
  studyId: string,
  userId: string
): Promise<boolean> {
  ensurePostgresConfigured();

  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query(
      `UPDATE studies SET owner_user_id = $2 WHERE id = $1 AND owner_user_id IS NULL`,
      [studyId, userId]
    );

    return (result.rowCount ?? 0) > 0;
  });
}

/**
 * Adopt on write: the first admin to make a real edit to an unowned legacy row
 * becomes its owner. That is what stops the null-owner population from being
 * permanent - it can only shrink, since every create sets an owner - and it is
 * why the fail-open in canWriteStudy is not a standing hole. The claim rides
 * the same UPDATE as the edit, in the same transaction, so an edit that rolls
 * back leaves no claim behind.
 *
 * Two things it deliberately does NOT do:
 *
 * - A superadmin never claims. They can already write every study, so claiming
 *   buys no access, and it would take a legacy study away from the researcher
 *   who wrote it the moment a superadmin fixed a typo on it. The cost is that
 *   a row only ever touched by superadmins stays unowned; that is the weaker
 *   failure, and a superadmin can assign an owner explicitly instead.
 * - A request that changes nothing never claims. Every field in
 *   updateStudyRequestSchema is optional, so a bare `PUT {}` parses, and
 *   without this a rogue admin could enumerate the study list - which now
 *   carries every study's id and owner - and loop empty PUTs to take every
 *   unowned study, locking out the people who wrote them.
 */
function claimsOwnership(
  ownerUserId: string | null,
  requester: StudyRequester,
  input: UpdateStudyInput,
  fieldChangeCount: number
) {
  if (ownerUserId !== null || requester.isSuperadmin) {
    return false;
  }

  return fieldChangeCount > 0 || Boolean(input.steps);
}

/**
 * The authorisation rule, in one place.
 *
 * Superadmin writes anything. An owner writes their own. A study with NO owner
 * is writable by any admin: those are rows created before owners existed, and
 * a guard that locked them would make legacy studies permanently uneditable by
 * the very people who authored them, with no API to hand them back. Fail-open
 * here matches today's behaviour exactly rather than adding new exposure, and
 * updateStudy closes each row the first time it is touched.
 */
function canWriteStudy(ownerUserId: string | null, requester: StudyRequester) {
  return (
    requester.isSuperadmin || ownerUserId === null || ownerUserId === requester.userId
  );
}

async function loadStudyWithSteps(
  client: PoolClient,
  studyId: string
): Promise<StudyWithSteps | null> {
  const studyResult = await client.query<StudyRow>(
    `
      SELECT id, title, intro_text, consent_text, brand_name,
             estimated_duration_minutes, locale, status, owner_user_id,
             created_at, updated_at
      FROM studies
      WHERE id = $1
    `,
    [studyId]
  );
  const studyRow = studyResult.rows[0];

  if (!studyRow) {
    return null;
  }

  const stepResult = await client.query<StudyStepRow>(
    `
      SELECT id, study_id, step_order, type, prompt, target_url,
             helper_text, is_required, options
      FROM study_steps
      WHERE study_id = $1
      ORDER BY step_order ASC
    `,
    [studyId]
  );

  return {
    study: mapStudyRow(studyRow),
    steps: stepResult.rows.map(mapStudyStepRow)
  };
}

async function insertStudySteps(
  client: PoolClient,
  studyId: string,
  steps: StudyStep[]
) {
  for (const step of steps) {
    await client.query(
      `
        INSERT INTO study_steps (
          id, study_id, step_order, type, prompt, target_url,
          helper_text, is_required, options
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        step.step_id,
        studyId,
        step.order,
        step.type,
        step.prompt,
        step.target_url ?? null,
        step.helper_text ?? null,
        step.is_required ?? false,
        step.options ? JSON.stringify(step.options) : null
      ]
    );
  }
}

function mapStudyRow(row: StudyRow): StudyRecord {
  return {
    id: row.id,
    title: row.title,
    intro_text: row.intro_text,
    consent_text: row.consent_text,
    brand_name: row.brand_name ?? undefined,
    estimated_duration_minutes: row.estimated_duration_minutes ?? undefined,
    locale: row.locale ?? undefined,
    status: normalizeStudyStatus(row.status),
    owner_user_id: row.owner_user_id ?? null,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at)
  };
}

function mapStudyStepRow(row: StudyStepRow): StudyStep {
  const stepType = stepTypeSchema.parse(row.type);

  return {
    step_id: row.id,
    order: row.step_order,
    type: stepType,
    prompt: row.prompt,
    target_url: row.target_url ?? undefined,
    helper_text: row.helper_text ?? undefined,
    is_required: row.is_required,
    options: row.options ?? undefined
  };
}

function normalizeStudyStatus(status: string): StudyStatus {
  if (status === "launched" || status === "archived") {
    return status;
  }

  return "draft";
}

function ensurePostgresConfigured() {
  if (!isPostgresRuntimeConfigured()) {
    throw new Error(
      "FirstHand studies require a configured PostgreSQL database. Set DATABASE_URL or POSTGRES_URL."
    );
  }
}

function validateSteps(steps: StudyStep[]) {
  if (steps.length === 0) {
    throw new Error("Study must include at least one step.");
  }

  const stepIds = new Set<string>();
  const stepOrders = new Set<number>();

  for (const step of steps) {
    if (stepIds.has(step.step_id)) {
      throw new Error(`Duplicate step_id: ${step.step_id}`);
    }

    if (stepOrders.has(step.order)) {
      throw new Error(`Duplicate step order: ${step.order}`);
    }

    if (step.type === "single_choice" && (!step.options || step.options.length < 2)) {
      throw new Error(
        `single_choice step "${step.step_id}" must include at least two options.`
      );
    }

    stepIds.add(step.step_id);
    stepOrders.add(step.order);
  }
}

function toIsoString(value: Date | string): string {
  return new Date(value).toISOString();
}
