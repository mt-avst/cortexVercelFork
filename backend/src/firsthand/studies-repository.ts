
import type { Pool, PoolClient } from "pg";

import {
  findStepShapeProblem,
  stepTypeSchema,
  type StepConfig,
  type StepShapeProblem,
  type Study,
  type StudyStep
} from "../../../shared/firsthand/contract";
import { resolveConsentTemplate } from "../../../shared/firsthand/consent-templates";
import {
  findStepVocabularyProblem,
  STEP_VOCABULARY_MESSAGES,
  type StudyKind
} from "../../../shared/firsthand/study-input";

import {
  isPostgresRuntimeConfigured,
  withRuntimeDatabaseClient
} from "./runtime-database";

/**
 * Wording for the repository boundary, where the message names the offending
 * step and surfaces to an admin as a failed save. Phrased to complete the
 * sentence `<type> step "<id>" ...`.
 *
 * The single_choice wording is unchanged and must stay that way: a route test
 * and an opportunity-form test both assert on "at least two options".
 */
const REPOSITORY_STEP_SHAPE_MESSAGES: Record<StepShapeProblem["code"], string> = {
  choice_needs_options: "must include at least two options",
  selection_range_inverted:
    "has a maximum number of selections below its minimum",
  selection_min_exceeds_options:
    "requires more selections than it offers options",
  rating_needs_scale: "must include a config.scale_max giving the rating scale",
  rating_scale_out_of_range: "has a config.scale_max outside the usable range",
  nps_scale_not_authorable: "is fixed at 0 to 10 and cannot set config.scale_max",
  nps_takes_no_options: "must not include options"
};

export type StudyStatus = "draft" | "launched" | "archived";

export type StudyRecord = Study & {
  status: StudyStatus;
  /**
   * Which authoring vocabulary the study is written in, and so which runner its
   * participant gets. See migration 0009 for why this is stored rather than
   * derived from the step types present.
   */
  kind: StudyKind;
  // Null for a study created before owners existed and not claimable from an
  // opportunity by migration 0007. See canWriteStudy for what that permits.
  owner_user_id: string | null;
  /**
   * The study this one was copied from. Authoring provenance only, never an
   * authorisation key - see migration 0012. Written once at create; null means
   * authored from blank, or the study predates copy-on-select. Not on
   * UpdateStudyInput: see the comment there for why it is write-once.
   */
  copied_from_study_id: string | null;
  created_at: string;
  /**
   * When the row was last written, and the value the optimistic-concurrency
   * precondition is asserted against - see `updateStudy`. Served to clients so
   * they can echo it back on save.
   */
  updated_at: string;
  // No `updated_by_user_id` here, deliberately, though migration 0014 adds the
  // column and every write sets it. StudyRecord is what the study LIST and the
  // single-study GET serve, and that list is unfiltered by owner - so surfacing
  // it would hand every admin the user id of whoever last touched every other
  // admin's study, which is a wider disclosure than the 409 it was added to
  // support and one nothing in the product asked for. It is written and logged;
  // a surface that needs to show it can join to public.users and decide the
  // question then, on its own merits.
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
/**
 * The optimistic-concurrency refusal.
 *
 * Deliberately NOT folded into `StudyWriteFailure`, which `deleteStudy` shares:
 * a delete has no precondition, and widening the shared type would let a route
 * answer 409 for an operation that can never produce one. Keeping it separate
 * also makes the compiler point at every caller that has to decide what a
 * conflict means for it, rather than letting one fall through a `not_found`
 * branch.
 *
 * `current_updated_at` is the row's value as it stands NOW, and it is here so
 * the loser of a race is not locked out. Without it the client can only re-send
 * the same stale token and lose again, forever; with it, the client can offer a
 * deliberate "I have looked, save mine anyway" that re-sends against what is
 * actually stored. The precondition is a "you have seen this" gate, not a lock.
 *
 * It carries no user identity. See the 409 handling in routes/firsthand.ts for
 * why `updated_by_user_id` is recorded and logged but never returned.
 */
export type StudyStaleWriteFailure = {
  ok: false;
  reason: "stale";
  current_updated_at: string;
};

export type StudyUpdateResult =
  | ({ ok: true; claimed: boolean } & StudyWithSteps)
  | StudyWriteFailure
  | StudyStaleWriteFailure;

export type StudyDeleteResult = { ok: true } | StudyWriteFailure;

export type CreateStudyInput = {
  id?: string;
  title: string;
  intro_text: string;
  consent_text: string;
  brand_name?: string;
  /** null is meaningful: the researcher did not state a duration. */
  estimated_duration_minutes?: number | null;
  locale?: string;
  status?: StudyStatus;
  /**
   * Defaults to `recorded` when absent, which is what every caller predating
   * the survey vocabulary means. Not present on UpdateStudyInput: a study's
   * vocabulary is fixed at create, because changing it would leave the stored
   * steps written for a runner that no longer reads them.
   */
  kind?: StudyKind;
  // The authoring user. Optional in the type only so a caller with no user
  // context (a script, a fixture) can still insert; every HTTP path passes one.
  owner_user_id?: string | null;
  /**
   * The study this one was copied from, taken from the picker at the moment of
   * copy-on-select rather than a live link. See migration 0012. Optional and
   * defaults to null via `?? null` in createStudy - most callers (a blank
   * study, every pre-B3 fixture) have nothing to record here.
   */
  copied_from_study_id?: string | null;
  /**
   * What the caller CLAIMS this consent wording is, not what will be stored.
   *
   * `createStudy` runs the claim through `resolveConsentTemplate` against
   * `consent_text` and stores the verified answer, so a caller sending edited
   * wording under an approved template id gets `custom` written to the row.
   * The claim earns its place only for the version: once a second version of a
   * template ships, a study still carrying the first version's wording resolves
   * to v1 rather than to `custom`, and nothing but the claim can say which
   * version to compare against.
   */
  consent_template_id?: string | null;
  consent_template_version?: number | null;
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
  /**
   * The same claim `CreateStudyInput` documents, and with one extra rule:
   * IGNORED ENTIRELY unless `consent_text` is present in the same request.
   *
   * The classification is a property of the wording, so a request that could
   * set it without sending the wording could assert that a study runs on
   * approved consent while the stored sentence says something else - the one
   * lie this whole feature exists to make impossible. Keeping the two welded
   * together also leaves `claimsOwnership` unchanged in meaning: a consent edit
   * counted as one real edit before, and still does, because these columns are
   * only ever pushed alongside `consent_text`.
   */
  consent_template_id?: string | null;
  consent_template_version?: number | null;
  // No copied_from_study_id here, deliberately. Provenance is write-once at
  // create - see CreateStudyInput - so there is no in-place edit that should
  // ever change it, and the dynamic update builder below has nothing to push
  // it through even if a caller forced one in.
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
  kind: string;
  owner_user_id: string | null;
  copied_from_study_id: string | null;
  consent_template_id: string | null;
  consent_template_version: number | null;
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
  // Per-type question settings for the native survey types. Separate from
  // `options` because that is read as string[] here and by every caller.
  config: StepConfig | null;
};

export function isStudiesPersistenceConfigured() {
  return isPostgresRuntimeConfigured();
}

/**
 * A study as the picker list serves it: every StudyRecord field, plus how many
 * authored steps it holds. See `authored_step_count` on the row type for why
 * that count is list-only rather than part of StudyRecord itself.
 */
export type StudyListItem = StudyRecord & { authored_step_count: number };

type StudyListRow = StudyRow & { authored_step_count: number };

export async function listStudies(): Promise<StudyListItem[]> {
  if (!isPostgresRuntimeConfigured()) {
    return [];
  }

  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query<StudyListRow>(
      `
        SELECT s.id, s.title, s.intro_text, s.consent_text, s.brand_name,
               s.estimated_duration_minutes, s.locale, s.status, s.kind,
               s.owner_user_id, s.copied_from_study_id, s.consent_template_id,
               s.consent_template_version, s.created_at, s.updated_at,
               (SELECT count(*) FILTER (WHERE ss.type <> 'end')
                FROM study_steps ss
                WHERE ss.study_id = s.id)::int AS authored_step_count
        FROM studies s
        ORDER BY s.updated_at DESC, s.title ASC
      `
    );

    return result.rows.map((row) => ({
      ...mapStudyRow(row),
      authored_step_count: row.authored_step_count
    }));
  });
}

/**
 * `existingClient` (cto/AdaptaLabs#159, MR !528 review pass 1 HIGH-1) is
 * additive - omit it and this checks out its own client exactly as before.
 *
 * Passed one, this queries directly on it instead of taking a SECOND
 * checkout from the runtime pool (`RUNTIME_POOL_MAX_CONNECTIONS = 5`).
 * `createSession`'s caller in the survey-session route already holds one
 * connection for the whole locked mint decision
 * (`runSerializedForMintPair`); leaving this as its own pooled read meant
 * every mint under that lock held TWO connections at once, and participant
 * work is not behind the admission cap that would otherwise queue it
 * politely. Proven end to end: 8 different participants minting the same
 * survey concurrently exhausted the pool - every connection ended up held by
 * a request waiting on a 6th, so all 8 timed out at `connectionTimeoutMillis`
 * (10s) and 500'd. Passing the caller's client through removes the second
 * checkout entirely; the same 8 concurrent participants then succeed in
 * milliseconds. (The pool exhaustion, not a data race: `getStudyById` reads
 * `studies`, not `runtime_sessions`, so there was never a correctness reason
 * to serialize it - only a connection-budget one.)
 */
export async function getStudyById(
  studyId: string,
  existingClient?: PoolClient
): Promise<StudyWithSteps | null> {
  if (!isPostgresRuntimeConfigured()) {
    return null;
  }

  if (existingClient) {
    return loadStudyWithSteps(existingClient, studyId);
  }

  return withRuntimeDatabaseClient(async (client) => {
    return loadStudyWithSteps(client, studyId);
  });
}

/**
 * How many tasks a participant will actually be asked to do, or null when the
 * study does not exist.
 *
 * Deliberately NOT `getStudyById(...).steps.length`. This is the only study
 * read reachable without a credential (the recorded-study brief on a published
 * opportunity), and every other consumer of this pool is behind requireAdmin or
 * a session token. Two consequences follow:
 *
 * 1. **Cost.** The runtime pool is `max: 5` and is the same pool serving live
 *    participant sessions - response writes, upload finalisation. Loading a
 *    whole study plus every step, on an anonymous route with no rate limit,
 *    puts a public endpoint in contention with recordings already in progress.
 * 2. **Exposure.** Holding every prompt and target_url in a local variable of a
 *    public handler is a latent leak: one careless spread turns the brief into
 *    a study-prompt dump. The prompts are withheld on purpose - a participant
 *    who reads the tasks up front rehearses the route - so the safest handler
 *    is one that never has them.
 *
 * The terminal `end` marker is appended automatically and never rendered, so
 * counting it would promise one more task than the participant is asked to do.
 */
export async function countStudyTasks(studyId: string): Promise<number | null> {
  if (!isPostgresRuntimeConfigured()) {
    return null;
  }

  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query<{ task_count: string }>(
      `
        SELECT count(*) FILTER (WHERE type <> 'end') AS task_count
        FROM study_steps
        WHERE study_id = $1
      `,
      [studyId]
    );

    // count(*) over no rows is 0, which is indistinguishable from a study that
    // exists and has no steps. Ask the studies table which of the two it is,
    // so a missing study 404s rather than reporting "0 tasks".
    const exists = await client.query<{ one: number }>(
      `SELECT 1 AS one FROM studies WHERE id = $1`,
      [studyId]
    );
    if (exists.rows.length === 0) {
      return null;
    }

    return Number(result.rows[0]?.task_count ?? 0);
  });
}

/**
 * An opportunity's own view of itself, as this repository reports it to a
 * task-list usage caller. See `listStudyUsage`.
 */
export type StudyUsageOpportunity = {
  id: string;
  title: string;
  status: string;
};

/**
 * A caller that can run a parameterised query - the shape `pg.Pool` and
 * `pg.PoolClient` both satisfy, and the only shape `listStudyUsage` needs.
 *
 * Not upgraded to a value import of `pool` from `../config`, deliberately.
 * `../config` calls `getBackendConfig()` - a zod parse of `process.env` with
 * no default on `SESSION_SECRET` - at MODULE SCOPE the instant anything
 * imports it, so importing it here would make every test in this file's own
 * suite (and its `-postgres` sibling, and every other `src/firsthand/**`
 * vitest file) a transitive importer too. None of them set `SESSION_SECRET`;
 * jest's suites do, in `src/__tests__/setup.ts`, which is exactly why
 * `routes/opportunities.ts` and `routes/firsthand.ts` can import `pool`
 * directly and this file cannot. The caller supplies whichever pool it already
 * holds instead.
 */
type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Which opportunities currently serve this task list / question set to
 * participants - the D4 "used by N studies" count and detail rows.
 *
 * `firsthand.studies` (this repository's own table) lives in the FirstHand
 * runtime database; `opportunities` lives in Cortex's own database. The two
 * are linked only by `opportunities.firsthand_study_id`, a bare TEXT column
 * with no foreign key (migration 0007 `firsthand_studies_owner`) - the same
 * column `routes/opportunities.ts`'s `studyIsSharedWithAnotherOpportunity`
 * already reads for its in-editor sharing guard. There is no cross-database
 * join to write, so this is a plain filtered SELECT against whichever pool the
 * caller supplies (Cortex's own), not the runtime pool the rest of this file
 * uses.
 *
 * Returns `[]` for a study id nothing currently references - including one
 * that was never created, in either database - rather than treating either
 * case as an error. "Nobody uses this" and "there is no such id" answer the
 * same question a caller actually has: whether editing this list would change
 * what somebody else's opportunity serves its participants.
 */
export async function listStudyUsage(
  mainDatabase: Queryable,
  studyId: string
): Promise<StudyUsageOpportunity[]> {
  const result = await mainDatabase.query<StudyUsageOpportunity>(
    `
      SELECT id::text AS id, title, status::text AS status
      FROM opportunities
      WHERE firsthand_study_id = $1
      ORDER BY title ASC
    `,
    [studyId]
  );

  return result.rows;
}

export async function createStudy(input: CreateStudyInput): Promise<StudyWithSteps> {
  ensurePostgresConfigured();
  validateSteps(input.steps);

  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      const studyId = input.id ?? `study_${crypto.randomUUID()}`;
      const status = input.status ?? "draft";
      // Verified here rather than taken from the caller: `resolveConsentTemplate`
      // returns the claim only when the wording actually IS that template's
      // wording, and `custom` otherwise. A create therefore cannot mint a study
      // that claims approved consent while carrying something else.
      const consentTemplate = resolveConsentTemplate({
        kind: (input.kind ?? "recorded") === "survey" ? "survey" : "recorded",
        consentText: input.consent_text,
        claimedTemplateId: input.consent_template_id,
        claimedTemplateVersion: input.consent_template_version
      });

      await client.query(
        `
          INSERT INTO studies (
            id, title, intro_text, consent_text, brand_name,
            estimated_duration_minutes, locale, status, kind, owner_user_id,
            copied_from_study_id, consent_template_id, consent_template_version,
            updated_by_user_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
          input.kind ?? "recorded",
          input.owner_user_id ?? null,
          input.copied_from_study_id ?? null,
          consentTemplate.id,
          consentTemplate.version,
          // The creator, taken from `owner_user_id` rather than added as a
          // second parameter, because at create they are the same person by
          // construction: every HTTP caller sets `owner_user_id: req.user!.id`
          // from the session, and the field exists on this input only so a
          // caller with no user context - a script, a fixture - can still
          // insert. Two knobs for one fact would let them disagree.
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

/**
 * @param expectedUpdatedAt
 *   The `updated_at` the caller loaded, echoed back as an optimistic-concurrency
 *   precondition. A mismatch means somebody else wrote the row in between, and
 *   the update is refused with `stale` rather than silently overwriting them.
 *
 *   OPTIONAL, and absence means "no precondition asserted" - the write proceeds.
 *   That is fail-open, and it is chosen rather than defaulted:
 *
 *     - The two HTTP callers both send it. A request that omits it is either an
 *       SPA bundle older than the backend serving it - a real fifteen-to-thirty
 *       minute window on every rolling deploy, which the `id` field on
 *       `updateStudyRequestSchema` already records as a trap worth designing
 *       around - or a script, which has no concurrent editor to race.
 *     - Absence is not a claim. A caller who omits the field is not asserting
 *       freshness, so there is nothing to refuse; failing closed would break
 *       every save for the length of a deploy in exchange for protection
 *       against a race that only two humans in two browsers can create.
 *     - It costs no security. Anyone able to omit the precondition already had
 *       the right to write the row - `canWriteStudy` has passed by then - so
 *       omitting it gains an attacker nothing they did not already have.
 *
 *   The routes log the omission, so a client that silently stopped sending it is
 *   discoverable rather than invisible.
 *
 *   A value that is present but unparseable fails CLOSED - an assertion nobody
 *   can read is not an assertion. Both HTTP callers reject the shape at their
 *   own schema and answer 400 before reaching here; the repository still holds
 *   the line for a direct caller.
 *
 *   An explicit `null` is treated as absence, not as an unreadable claim: it is
 *   what a client with no stored revision has to send through a field typed
 *   `string | null`, and reading it as a failed assertion would refuse every
 *   save on a study whose `updated_at` never reached the form.
 */
export async function updateStudy(
  studyId: string,
  input: UpdateStudyInput,
  requester: StudyRequester,
  expectedUpdatedAt?: string | null
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
      const ownerResult = await client.query<{
        owner_user_id: string | null;
        kind: string;
        updated_at: Date | string;
      }>(
        // `updated_at` rides along on the statement that already takes the lock
        // rather than in a second round trip. Reading it OUTSIDE the lock would
        // make the precondition decorative: the row could be written between the
        // read and the write, which is the exact race this exists to close.
        `SELECT owner_user_id, kind, updated_at FROM studies WHERE id = $1 FOR UPDATE`,
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

      // The optimistic-concurrency precondition, AFTER the ownership decision
      // and before anything else.
      //
      // After, deliberately. A 409 tells the caller that the study exists and
      // that somebody wrote it recently. Answering that ahead of the ownership
      // check would hand both facts to a caller who was refused read-write
      // access to the row, which is the same disclosure the early ownership
      // check in `updateLinkedStudyContent` was added to close. A caller who
      // cannot write the study gets 403 whether their token is fresh or not.
      //
      // Before the vocabulary check, equally deliberately: if the row moved
      // under the caller, the validity of their payload against it is moot, and
      // a conflict is the more actionable answer than a step-shape complaint
      // about content they are about to be told to re-derive.
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null) {
        const storedUpdatedAt = new Date(ownerRow.updated_at).getTime();
        const claimedUpdatedAt = new Date(expectedUpdatedAt).getTime();

        // Compared as epoch MILLISECONDS, not as strings, and this is the
        // difference between a working precondition and one that refuses every
        // save. Both halves of that sentence are load-bearing and each has its
        // own test; a canary entry pins each mutation.
        //
        // NOT AS STRINGS. `ownerRow.updated_at` arrives from node-pg as a JS
        // `Date` - measured, and the reason is that nothing in this repository
        // calls `setTypeParser`, so `timestamptz` takes pg's built-in parser.
        // `String(date)` is therefore a LOCALE string, `Fri Aug 21 2026
        // 10:15:30 GMT+0100 (British Summer Time)`, which can never equal the
        // ISO value the caller was served. A raw string comparison here does
        // not refuse the occasional save; it refuses EVERY save, for ever.
        //
        // An earlier version of this comment blamed microsecond precision -
        // TIMESTAMPTZ is microsecond in Postgres, the caller is served a
        // millisecond ISO string, so the two could never match. Plausible, and
        // not what happens: the extra digits are gone before JavaScript sees
        // them. The microsecond case only arises if a type parser is ever
        // registered, or if this value reaches here as a string by some other
        // route - which is why the type is `Date | string` and why the test
        // for it has to build the row shape by hand. Defensive, not observed.
        //
        // AND MILLISECONDS, not some coarser unit. Both sides going through the
        // same truncation is necessary and NOT sufficient: flooring both to the
        // second is equally symmetric, and makes two saves landing in the same
        // wall-clock second both match their precondition, so the second
        // silently overwrites the first - the lost update this whole mechanism
        // exists to prevent. A review gate measured that mutation passing all
        // 81 tests in the sibling spec before the sub-second test was added.
        //
        // Epoch numbers rather than the ISO strings also means a client that
        // round-tripped the value through its own Date, or serialised `+00:00`
        // where we sent `Z`, still matches.
        //
        // An unparseable claim fails CLOSED, and it falls out of this one
        // comparison rather than needing a guard of its own: `new Date("nonsense")
        // .getTime()` is NaN, and NaN is not equal to anything including
        // itself, so `!==` is already true. An explicit `Number.isNaN` test
        // beside it would be dead code with a comment claiming it did work.
        //
        // Both HTTP callers validate the shape at their own schema and answer
        // 400 first; this covers a direct repository caller. An assertion
        // nobody can read is not an assertion, and writing over somebody on the
        // strength of one is the worst of the available answers.
        if (claimedUpdatedAt !== storedUpdatedAt) {
          await client.query("ROLLBACK");
          return {
            ok: false,
            reason: "stale",
            current_updated_at: toIsoString(ownerRow.updated_at)
          } as const;
        }
      }

      // The vocabulary check that create does from its payload. An update
      // carries no kind - it is fixed at create - so this is the only place
      // that knows which vocabulary applies, and without it `PUT` was simply
      // the way round the create-time rule. Inside the transaction and after
      // the row lock, so the kind cannot change between reading and writing.
      if (input.steps) {
        const problem = findStepVocabularyProblem(
          ownerRow.kind === "survey" ? "survey" : "recorded",
          input.steps
        );

        if (problem) {
          await client.query("ROLLBACK");
          throw new Error(
            `Step "${input.steps[problem.index]?.step_id}" ${STEP_VOCABULARY_MESSAGES[problem.code]}`
          );
        }
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      const push = (column: string, value: unknown) => {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      };

      if (input.title !== undefined) push("title", input.title);
      if (input.intro_text !== undefined) push("intro_text", input.intro_text);
      if (input.consent_text !== undefined) {
        push("consent_text", input.consent_text);

        // Pushed together with the wording, always, and never without it.
        //
        // Together, because a row whose text and classification disagree is
        // worse than one with no classification at all: it states in a column
        // that somebody approved a sentence nobody read. Never without it,
        // because a request able to set the classification alone could assert
        // approval for wording it never sent.
        //
        // `ownerRow.kind` and not the caller's: a study's vocabulary is fixed
        // at create, and letting a request choose which template family it is
        // measured against would let a recorded study be recorded as running on
        // the survey template, whose central claim - "Nothing is recorded" -
        // would be false about it.
        const consentTemplate = resolveConsentTemplate({
          kind: ownerRow.kind === "survey" ? "survey" : "recorded",
          consentText: input.consent_text,
          claimedTemplateId: input.consent_template_id,
          claimedTemplateVersion: input.consent_template_version
        });
        push("consent_template_id", consentTemplate.id);
        push("consent_template_version", consentTemplate.version);
      }
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

      // ONE write site for the row's audit columns, where there used to be two.
      //
      // `updated_at = NOW()` was pushed here for a column edit and bumped again
      // by a separate statement further down for the steps-only case. Nothing in
      // the database maintains either column - firsthand has no BEFORE UPDATE
      // trigger, unlike the app schema - so every write path has to remember
      // them, and two sites means a third path can bump one without the other
      // and leave a row whose "who" and "when" disagree. `updated_by_user_id`
      // arrives in this MR and would have had to be added twice.
      //
      // The condition is exactly what the two old sites covered between them, so
      // a request that changes nothing - a bare `PUT {}` parses, per
      // updateStudyRequestSchema - still bumps nothing. A no-op must not look
      // like an edit to the next person's precondition.
      const touchesTheRow = updates.length > 0 || Boolean(input.steps);

      if (touchesTheRow) {
        // clock_timestamp(), not NOW(). `NOW()` is `transaction_timestamp()` -
        // the moment the transaction OPENED, not the moment it wrote.
        //
        // That was decorative while `updated_at` was only a sort key. It is the
        // correctness primitive now. Under contention writer B can BEGIN before
        // writer A commits, block on A's `FOR UPDATE`, and then stamp a time
        // computed before the wait - so the column can move backwards, and two
        // overlapping writers can land close enough to collide once the value is
        // truncated to milliseconds for the client. Either would make a
        // precondition answer about a write it was not looking at.
        // clock_timestamp() is read when the statement runs, so it cannot.
        updates.push("updated_at = clock_timestamp()");
        // From the authenticated requester, never from the input. A
        // body-supplied editor id would let an author attribute their edit to a
        // colleague, which is worse than recording nothing at all.
        push("updated_by_user_id", requester.userId);
        values.push(studyId);
        await client.query(
          `UPDATE studies SET ${updates.join(", ")} WHERE id = $${values.length}`,
          values
        );
      }

      if (input.steps) {
        await applyStudySteps(client, studyId, input.steps);
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
 *
 * Exported so a read route can DISCLOSE the same decision the write path will
 * take, rather than a second copy of the rule drifting in the client. It is
 * advisory wherever it is read outside a write transaction: the binding check
 * is the one updateStudy and deleteStudy take inside their own `FOR UPDATE`
 * lock, because the owner can change between a read and a write.
 */
export function canWriteStudy(ownerUserId: string | null, requester: StudyRequester) {
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
             estimated_duration_minutes, locale, status, kind, owner_user_id,
             copied_from_study_id, consent_template_id, consent_template_version,
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
             helper_text, is_required, options, config
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

/**
 * Bring a study's stored steps in line with what the caller sent, WITHOUT
 * deleting the ones that survive.
 *
 * This used to be `DELETE FROM study_steps WHERE study_id = $1` followed by a
 * fresh insert of everything, and that is the write half of the defect F2
 * closes. Every save destroyed every step row and minted them again, so a step
 * had no continuous existence at all - its id was whatever the payload happened
 * to derive this time. Now that `participant_responses` has a foreign key to
 * these rows, a blanket delete would also detach every answer on every save,
 * which turns an ordinary edit into data loss.
 *
 * So: rows whose id is no longer in the payload are deleted (and their answers
 * detached, deliberately - see 0015). Rows that survive are UPDATED in place
 * and keep their identity. New ids are inserted.
 *
 * The negation pass exists because of `UNIQUE (study_id, step_order)` from
 * 0004. A pure reorder wants to give step B the position step A currently
 * holds, and the constraint is checked per statement, so writing the new orders
 * directly collides on the first swap. Parking every survivor at a negative
 * order first is enough: incoming orders are always positive (`stepSchema`
 * requires it), so nothing can collide with a parked row, and negating a set of
 * distinct values leaves them distinct.
 *
 * A deferred constraint would express this more directly, but that means
 * dropping and re-adding a constraint on a deployed database by name, which
 * this buys nothing over.
 */
async function applyStudySteps(
  client: PoolClient,
  studyId: string,
  steps: StudyStep[]
) {
  const keptIds = steps.map((step) => step.step_id);

  // `<> ALL` over an empty array is TRUE for every row, so a study whose
  // payload has no steps is emptied - which is right, and unreachable anyway
  // because validateSteps refuses an empty list.
  //
  // A NULL element would be the dangerous input rather than a special
  // character: `x <> ALL(ARRAY[NULL])` is NULL, not TRUE, so the DELETE would
  // remove NOTHING and leave rows parked at a negative step_order that sort
  // ahead of everything on the next read. `stepSchema` types step_id as a
  // non-empty string and validateSteps has already run, so it cannot arrive -
  // but it is the one value that turns this statement into silent corruption
  // rather than an error, which is why it is written down.
  await client.query(
    `DELETE FROM study_steps WHERE study_id = $1 AND id <> ALL($2::text[])`,
    [studyId, keptIds]
  );

  await client.query(
    `UPDATE study_steps SET step_order = -step_order WHERE study_id = $1 AND step_order > 0`,
    [studyId]
  );

  await insertStudySteps(client, studyId, steps);
}

/**
 * Write each step, replacing any row that already holds its id.
 *
 * `ON CONFLICT (study_id, id) DO UPDATE` rather than a plain insert, because
 * `applyStudySteps` calls this over a list that may contain both new steps and
 * ones that already exist. The conflict target is the composite primary key
 * added in 0010. Every column is written, so an updated row is exactly what a
 * freshly inserted one would have been - a partial update here would be a field
 * that silently keeps a stale value across an edit, which is the class of bug
 * `studyRoundTripsCleanly` exists to catch on the other side.
 */
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
          helper_text, is_required, options, config
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (study_id, id) DO UPDATE SET
          step_order = EXCLUDED.step_order,
          type = EXCLUDED.type,
          prompt = EXCLUDED.prompt,
          target_url = EXCLUDED.target_url,
          helper_text = EXCLUDED.helper_text,
          is_required = EXCLUDED.is_required,
          options = EXCLUDED.options,
          config = EXCLUDED.config
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
        step.options ? JSON.stringify(step.options) : null,
        // Serialised like `options`: node-postgres will not infer JSONB from a
        // plain object parameter.
        step.config ? JSON.stringify(step.config) : null
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
    // The column carries a CHECK constraint, so anything else is unreachable
    // through the application. Normalising rather than trusting the string
    // means a row that somehow held one would be served the conservative
    // vocabulary, not offered survey widgets in a runner that cannot draw them.
    kind: row.kind === "survey" ? "survey" : "recorded",
    owner_user_id: row.owner_user_id ?? null,
    copied_from_study_id: row.copied_from_study_id ?? null,
    consent_template_id: row.consent_template_id ?? null,
    consent_template_version: row.consent_template_version ?? null,
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
    options: row.options ?? undefined,
    config: row.config ?? undefined
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

    // Positive, and checked HERE rather than left to the zod boundary.
    // `applyStudySteps` parks surviving rows at a NEGATIVE step_order to get
    // them out of the way of the incoming positive ones, and that only works
    // because incoming orders are all positive. `stepSchema` enforces it for an
    // HTTP caller; this function is the repository's own gate and the one a
    // script reaches, so the invariant belongs beside the code that depends on
    // it rather than one layer away.
    if (!Number.isInteger(step.order) || step.order <= 0) {
      throw new Error(`Step order must be a positive integer: ${step.order}`);
    }

    // The rules come from the contract rather than being restated here. This
    // function held its own copy of the single_choice check, which is exactly
    // the kind of duplicate that goes stale the first time a question type is
    // added. Only the wording is local, because it names the offending step.
    const shapeProblem = findStepShapeProblem(step);

    if (shapeProblem) {
      throw new Error(
        `${step.type} step "${step.step_id}" ${REPOSITORY_STEP_SHAPE_MESSAGES[shapeProblem.code]}.`
      );
    }

    stepIds.add(step.step_id);
    stepOrders.add(step.order);
  }
}

function toIsoString(value: Date | string): string {
  return new Date(value).toISOString();
}
