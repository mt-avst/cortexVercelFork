import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// #14: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts);
// the real gate now re-reads the DB role, which their positional pool mock cannot satisfy.
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

/**
 * THE ONE MOCK THAT MATTERS, AND WHY IT IS NOT CHEATING.
 *
 * `PATCH /api/opportunities/:id` mounts `validateRequest(UpdateOpportunitySchema)`,
 * and that middleware does `req.body = schema.parse(req.body)`. The schema is a
 * bare `z.object`, so TODAY an unknown key is stripped before the handler runs
 * and the allow-list can never fire on live traffic.
 *
 * That is precisely the state this fix exists to survive. The security gate on
 * the sessions injection measured the counterfactual: change that one schema to
 * `.passthrough()` and 958 of 958 tests still passed while the injection came
 * back, driving the real handler and capturing
 *
 *   UPDATE opportunities SET title = (SELECT email FROM users ...) ... RETURNING *
 *
 * So this file mounts the REAL router with the REAL handler and neutralises
 * only the stripping - which is the same body the handler would see under
 * `.passthrough()`, a `.catchall()`, a migration off zod, or a future route
 * that reuses this builder without a schema in front of it. Every other layer
 * is the production one.
 *
 * The strip layer keeps its own tests, at
 * `validation/__tests__/update-opportunity-schema-strips.test.ts`. The two fail
 * for different reasons on purpose: flip the schema and that file fails, delete
 * the allow-list and this one does. Neither is coverage of the other.
 *
 * The real module is SPREAD rather than listed, because the router imports four
 * more names from it and a factory that enumerates exports breaks the moment a
 * fifth is added.
 */
jest.mock('../../validation/schemas', () => {
  const actual = jest.requireActual('../../validation/schemas') as Record<string, unknown>;
  return {
    ...actual,
    validateRequest: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import opportunitiesRouter, {
  resetParticipantRouteLimits,
  UPDATABLE_OPPORTUNITY_COLUMNS,
  SERVER_DERIVED_OPPORTUNITY_COLUMNS,
  NON_COLUMN_OPPORTUNITY_BODY_KEYS,
} from '../opportunities';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';
import { UpdateOpportunitySchema } from '../../validation/schemas';
import { wireConnectThroughQuery } from '../../__tests__/helpers/pooled-client-mock';
import { getMockOpportunity, updateMockOpportunity } from '../../../../demo/mock-data';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

const CALLER = 'admin-1';
const PATH = '/api/opportunities/opp-1';

const appAs = (role: 'employee' | 'researcher_admin' | 'superadmin') => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { id: CALLER, name: 'A', email: 'a@example.com', role },
    };
    next();
  });
  app.use('/api/opportunities', opportunitiesRouter);
  app.use(errorHandler);
  return app;
};

/** Every statement the handler actually ran, matched in one place. */
const statements = () => mockQuery.mock.calls.map((call: unknown[]) => String(call[0]));
const updateStatements = () => statements().filter((sql) => sql.includes('UPDATE opportunities'));

/**
 * A pool that would happily run whatever SQL the handler builds, and an
 * opportunity the caller owns - so the ownership gate is SATISFIED and the
 * update path is genuinely reachable. Without that, every refusal below would
 * pass on a handler that had 403'd instead.
 */
const arrangeOwnedOpportunity = () => {
  // #151: the handler now runs its opportunities-table statements on a
  // client from `pool.connect()` rather than on `pool.query` directly.
  wireConnectThroughQuery(mockConnect, mockQuery);
  mockQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('SELECT owner_user_id FROM opportunities')) {
      return { rows: [{ owner_user_id: CALLER }], rowCount: 1 };
    }
    if (text.includes('SELECT type, title, purpose_one_liner')) {
      return {
        rows: [{
          type: 'interview',
          title: 'An interview study',
          purpose_one_liner: 'To learn how people book things',
          status: 'draft',
          external_link_optional: null,
          firsthand_study_id: null,
          participant_type_required: 'any',
          delivery_mode: 'external',
        }],
        rowCount: 1,
      };
    }
    // The UPDATE's RETURNING row. The handler calls .toISOString() on four of
    // these, so they must be Dates or the success path 500s and the control
    // arms below stop being controls.
    return {
      rows: [{
        id: 'opp-1',
        type: 'interview',
        title: 'An interview study',
        status: 'draft',
        owner_user_id: CALLER,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-02T00:00:00Z'),
        start_date: null,
        end_date: null,
      }],
      rowCount: 1,
    };
  });
};

/**
 * A schema-valid value for every column the allow-list permits.
 *
 * A TABLE rather than one assertion per name, because the failure this guards
 * against is an allow-list that is too NARROW - a fix that drops a field the
 * authoring form actually sends, which then 400s in the browser and nowhere
 * else. Both directions are asserted below.
 */
const PERMITTED: Record<string, unknown> = {
  type: 'interview',
  title: 'A retitled study',
  purpose_one_liner: 'To learn how people book things',
  description_optional: 'Some description',
  product_optional: 'Cortex',
  meeting_location_optional: 'Room 3B',
  default_duration_minutes: 45,
  external_link_optional: 'https://example.com/study',
  delivery_mode: 'external',
  firsthand_study_id: 'study-1',
  participant_type_required: 'internal',
  participant_type_specific_details: 'Finance team only',
  // Eligibility screener (JSONB). The PATCH loop emits `screener = $n::jsonb`.
  screener: {
    questions: [
      {
        id: 'q1',
        prompt: 'Which team are you in?',
        options: [
          { id: 'o1', label: 'Engineering', disqualifies: false },
          { id: 'o2', label: 'Sales', disqualifies: true },
        ],
      },
    ],
  },
  // Roles/skills wanted (JSONB, display-only). The PATCH loop emits
  // `target_roles = $n::jsonb`, the same handling as the screener.
  target_roles: ['Product Manager', 'ScriptRunner admin'],
  // External-delivery consent affirmation (cto/AdaptaLabs#136). A plain
  // boolean - no special branch in the PATCH loop, unlike screener/target_roles.
  external_consent_confirmed: true,
  status: 'draft',
  start_date: '2030-01-01T10:00:00.000Z',
  end_date: '2030-01-02T10:00:00.000Z',
  // Moderated consent (#79). The arranged opportunity is type 'interview', so
  // the type gate in resolveModeratedConsentWrite is satisfied and these reach
  // the allow-list rather than being refused a layer earlier - which is the
  // layer this file is NOT about.
  consent_text: 'You are agreeing to a live call that may be recorded.',
  consent_template_id: 'moderated-default',
  consent_template_version: 1,
};

/**
 * Extra keys a column needs beside it to be a LEGAL save. The template pair
 * may never travel without consent_text - a lone claim, nulls included, is
 * refused by sentence (CONSENT_CLAIM_WITHOUT_TEXT) - so the census sends each
 * half with the smallest body the write path accepts, and still asserts the
 * column under test reaches the SET clause. The text is anything non-empty:
 * resolution decides the stored pair, which is a different file's business.
 */
const COMPANIONS: Record<string, Record<string, unknown>> = {
  consent_template_id: {
    consent_text: 'You are agreeing to a live call that may be recorded.',
    consent_template_version: 1,
  },
  consent_template_version: {
    consent_text: 'You are agreeing to a live call that may be recorded.',
    consent_template_id: 'moderated-default',
  },
};

describe('PATCH /api/opportunities/:id column allow-list', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    arrangeOwnedOpportunity();
    // The write limiter's counter is per process and outlives a test, and this
    // file sends more than its ceiling of 30 as one user.
    resetParticipantRouteLimits(CALLER);
  });

  // THE EXPLOIT, as the gate captured it. Without the allow-list this produced
  //   UPDATE opportunities
  //   SET title = (SELECT email FROM users ORDER BY created_at LIMIT 1),
  //       purpose_one_liner = $1
  //   WHERE id = $2 RETURNING *
  // and handed the result back through RETURNING *.
  it('refuses a body key carrying a subquery, and builds no SQL for it', async () => {
    const res = await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({
        'title = (SELECT email FROM users ORDER BY created_at LIMIT 1), purpose_one_liner': 'x',
      })
      .expect(400);

    expect(res.body.error).toBe('Validation failed');
    // The refusal must happen before anything is built OR run. A status-only
    // assertion would pass on a handler that ran the injection and then failed
    // for some later reason.
    expect(updateStatements()).toHaveLength(0);
    // Refused before the ownership lookup too - nothing about this request
    // reached the database at all.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // THE MIXED BODY, and it is the shape the exploit above actually has: one
  // permitted key alongside one that is not. Every other refusal arm in this
  // file sends a body of EXACTLY ONE key, and a review gate proved what that
  // costs - narrowing the check to fire only when every key is unknown
  // (`unknownFields.length === Object.keys(req.body).length`, the shape a
  // well-meaning "do not 400 a mostly-valid save" refactor produces) survived
  // all 987 tests and let this straight through as
  //   SET title = $1, purpose_one_liner = (SELECT email FROM users ...), ...
  // answering 200. Checking only the first key survived too.
  it('refuses a mixed body, and builds no SQL for the permitted key either', async () => {
    await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({
        title: 'A retitled study',
        'purpose_one_liner = (SELECT email FROM users ORDER BY created_at LIMIT 1), product_optional': 'x',
      })
      .expect(400);

    // The permitted half must not survive either. A handler that dropped the
    // unknown key and wrote the rest would answer 200 and pass a status-only
    // assertion.
    expect(updateStatements()).toHaveLength(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses mass assignment of real columns the caller does not own', async () => {
    // The weaker half of the same hole, and the half that needs no injection:
    // all three are real columns on `opportunities`, so naming them was enough.
    // `owner_user_id` would hand another researcher's study to the caller.
    for (const body of [
      { owner_user_id: 'someone-else' },
      { id: 'another-opportunity' },
      { created_at: '1970-01-01T00:00:00.000Z' },
    ]) {
      jest.clearAllMocks();
      arrangeOwnedOpportunity();
      resetParticipantRouteLimits(CALLER);

      await request(listening(appAs('researcher_admin'))).patch(PATH).send(body).expect(400);

      expect(updateStatements()).toHaveLength(0);
      expect(mockQuery).not.toHaveBeenCalled();
    }
  });

  it('never echoes the offending key back to the caller', async () => {
    // Reflecting attacker-chosen text into a response body is one careless
    // render away from being a second vulnerability.
    const marker = 'title, evil_marker_9f3a';
    const res = await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({ [marker]: 1 })
      .expect(400);

    expect(JSON.stringify(res.body)).not.toContain('evil_marker_9f3a');
    // The control: the response is not empty, so the assertion above is about
    // the marker's absence rather than about there being nothing to search.
    expect(JSON.stringify(res.body).length).toBeGreaterThan(20);
  });

  // THE CONTROL FOR EVERY REFUSAL ABOVE. Without it a handler that refused
  // every PATCH would satisfy all of them and pin nothing.
  it('still updates a permitted column', async () => {
    await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({ title: 'A retitled study' })
      .expect(200);

    const updates = updateStatements();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/title = \$\d/);
  });

  // THE ASSERTION ABOUT THE STATEMENT ITSELF, rather than about the body that
  // produced it. Everything else in this file watches the door; this watches
  // what got written.
  //
  // A security gate showed why that is a different question. This handler
  // MUTATES `data` after the entry check - `data.firsthand_study_id = ...` at
  // three sites - and the builder is ~660 lines further on. One added line
  // writing an injected key into `data` for an ORDINARY body, with no hostile
  // input in the request at all, survived all 987 tests and rebuilt the entire
  // original vulnerability, returning the exfiltrated address through
  // `RETURNING *`. No arm anywhere asked what the SET clause named.
  //
  // A column is legitimate in the SET clause iff the body could name it (the
  // allow-list) OR the handler writes it itself (`SERVER_DERIVED_...`). The
  // second set exists because a status write now appends `auto_closed = false`
  // - a column no body may name. It widens what may APPEAR in the statement,
  // never what a body may REQUEST: the arms further down prove a body naming
  // `auto_closed` is still refused at the door, and the literal pins below
  // prove the server-derived set cannot quietly grow into a second allow-list.
  //
  // The arranged row is a DRAFT, so `status: 'closed'` is a real change of
  // status - the only write that derives the flag (see the same-status arm
  // below).
  it('emits a SET clause naming only allow-listed or server-derived columns', async () => {
    await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({ title: 'A retitled study', product_optional: 'Cortex', status: 'closed' })
      .expect(200);

    const [sql] = updateStatements();
    const setClause = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf('WHERE'));
    const named = setClause.split(',').map((f) => f.trim().split(/\s*=/)[0]);

    // THE CONTROL, and now a literal. Without it an empty or unparsed SET
    // clause makes the loop below vacuous, and a test that iterates nothing
    // passes forever. Pinned as the exact list rather than a length, so a
    // fifth column appearing - derived or injected - fails here by name.
    expect(named).toEqual(['title', 'product_optional', 'status', 'auto_closed']);
    named.forEach((column) => {
      expect(
        UPDATABLE_OPPORTUNITY_COLUMNS.has(column) || SERVER_DERIVED_OPPORTUNITY_COLUMNS.has(column)
      ).toBe(true);
    });
  });

  // THE SERVER-DERIVED FRAGMENT IS A LITERAL, NOT A PARAMETER. Nothing from the
  // request may reach it, so it must not consume a `$n` placeholder or push a
  // value: the parameter list is exactly the three body values plus the id.
  it('writes auto_closed as the literal false, taking no value from the request', async () => {
    await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({ title: 'A retitled study', product_optional: 'Cortex', status: 'closed' })
      .expect(200);

    const updateCall = mockQuery.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('UPDATE opportunities')
    ) as unknown[];
    expect(String(updateCall[0])).toMatch(/auto_closed = false/);
    expect(updateCall[1]).toEqual(['A retitled study', 'Cortex', 'closed', 'opp-1']);
  });

  // A WRITE OF THE STATUS THE ROW ALREADY HAS IS NOT A DECISION. An admin
  // pressing Close on a stale "published" row after the sweep closed it must
  // not relabel that sweep close as manual, so the flag is derived only on a
  // real change. The arranged row is a draft; this body writes draft again.
  it('leaves auto_closed out of the SET clause when the status written is the one the row has', async () => {
    await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({ title: 'A retitled study', product_optional: 'Cortex', status: 'draft' })
      .expect(200);

    const [sql] = updateStatements();
    const setClause = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf('WHERE'));
    const named = setClause.split(',').map((f) => f.trim().split(/\s*=/)[0]);

    // Literal, so the absence below is read from a parsed clause and not from
    // an empty string.
    expect(named).toEqual(['title', 'product_optional', 'status']);
    expect(sql).not.toContain('auto_closed');
  });

  // THE CONTROL FOR THE DERIVATION: only a STATUS write says how the study
  // closed. A title-only save must leave `auto_closed` alone, or retitling an
  // auto-closed study would silently rewrite why it closed.
  it('does not touch auto_closed on a save that writes no status', async () => {
    await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({ title: 'A retitled study' })
      .expect(200);

    const [sql] = updateStatements();
    expect(sql).toMatch(/title = \$1/);
    expect(sql).not.toContain('auto_closed');
  });

  describe('auto_closed is server-derived and never client-writable', () => {
    // Pinned as a LITERAL for the reason the allow-list's own pin gives below:
    // a test that derives its expectation from the set cannot see the set
    // grow. A second name here would be a column the handler writes with no
    // test saying why.
    it('names exactly one server-derived column, auto_closed', () => {
      expect([...SERVER_DERIVED_OPPORTUNITY_COLUMNS]).toEqual(['auto_closed']);
    });

    // A name in both sets would be client-writable AND server-derived, and the
    // body's value would race the handler's literal in one SET clause.
    it('never overlaps the client allow-list or the consumed non-columns', () => {
      expect(
        [...SERVER_DERIVED_OPPORTUNITY_COLUMNS].filter((c) => UPDATABLE_OPPORTUNITY_COLUMNS.has(c))
      ).toEqual([]);
      expect(
        [...SERVER_DERIVED_OPPORTUNITY_COLUMNS].filter((c) => NON_COLUMN_OPPORTUNITY_BODY_KEYS.has(c))
      ).toEqual([]);
      // And the schema does not declare it, so `validateRequest` strips it
      // from every live body before the handler runs.
      expect(Object.keys(UpdateOpportunitySchema.shape)).not.toContain('auto_closed');
      // THE CONTROL: the overlap filter is not vacuous - the set it iterates
      // is non-empty, so an empty result means "no overlap", not "nothing read".
      expect(SERVER_DERIVED_OPPORTUNITY_COLUMNS.size).toBe(1);
    });

    // With the strip neutralised (as everywhere in this file), a body naming
    // `auto_closed` reaches the allow-list and must be refused there like any
    // other column the caller does not own - alone, and riding beside a
    // legitimate status write. The live-stack answer with the strip in place
    // ("No fields to update", and a stored false) is asserted against a real
    // database in `opportunities.auto-closed-postgres.test.ts`.
    it.each([
      ['alone', { auto_closed: true }],
      ['beside a status write', { status: 'closed', auto_closed: true }],
    ])('refuses a body carrying auto_closed %s, and builds no SQL', async (_label, body) => {
      const res = await request(listening(appAs('researcher_admin')))
        .patch(PATH)
        .send(body)
        .expect(400);

      expect(res.body.error).toBe('Validation failed');
      expect(updateStatements()).toHaveLength(0);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('the allow-list is exactly the columns the schema declares', () => {
    // DIRECTION ONE: nothing the editor legitimately sends is refused, proved
    // through the route. A table rather than one `it` per column, so adding a
    // field to the schema without adding it to the allow-list fails HERE and
    // not in the browser.
    it.each(Object.keys(PERMITTED))('accepts %s and puts it in the SET clause', async (column) => {
      await request(listening(appAs('researcher_admin')))
        .patch(PATH)
        .send({ ...(COMPANIONS[column] ?? {}), [column]: PERMITTED[column] })
        .expect(200);

      const updates = updateStatements();
      expect(updates).toHaveLength(1);
      expect(updates[0]).toContain(`${column} = $`);
    });

    // DIRECTION TWO: the table above is the WHOLE permitted set. This reads the
    // PRODUCTION set rather than restating it, and that is the entire point:
    // the first draft of this test listed the fifteen names locally and
    // compared them to the schema, so a mutation that added a sixteenth name to
    // the real allow-list passed all 22 tests. A pin that restates a policy
    // cannot see the policy change.
    it('permits exactly the twenty-one columns, and no more', () => {
      expect([...UPDATABLE_OPPORTUNITY_COLUMNS].sort()).toEqual(Object.keys(PERMITTED).sort());
    });

    // Every name in the allow-list is a column, and every schema key is one or
    // the other. Widening either set fails here; so does adding a field to the
    // schema and forgetting both sets, which would 400 a legitimate save.
    it('accounts for every schema key as either a column or a consumed non-column', () => {
      const declared = Object.keys(UpdateOpportunitySchema.shape).sort();

      expect(
        [...UPDATABLE_OPPORTUNITY_COLUMNS, ...NON_COLUMN_OPPORTUNITY_BODY_KEYS].sort()
      ).toEqual(declared);
      // The two sets must not overlap: a name in both would be permitted for
      // the wrong reason, and removing it from one would look harmless.
      expect(
        [...UPDATABLE_OPPORTUNITY_COLUMNS].filter((c) => NON_COLUMN_OPPORTUNITY_BODY_KEYS.has(c))
      ).toEqual([]);
    });

    /**
     * The three non-columns, pinned as a literal for the same reason. Naming
     * one of these in `UPDATABLE_OPPORTUNITY_COLUMNS` would emit
     * `SET expected_study_updated_at = $n` against a column that does not
     * exist the moment the handler stopped destructuring it out.
     */
    it('treats exactly three declared keys as consumed rather than written', () => {
      expect([...NON_COLUMN_OPPORTUNITY_BODY_KEYS].sort()).toEqual(
        ['expected_study_updated_at', 'inline_study', 'inline_survey']
      );
    });
  });

  it('still refuses a non-admin outright', async () => {
    await request(listening(appAs('employee')))
      .patch(PATH)
      .send({ title: 'A retitled study' })
      .expect(403);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  // THE MOCK-DATA PATH. Every arm above sets `isDatabaseAvailable` true, so
  // none of them reached the `!dbAvailable` branch - and the gate on the
  // sessions fix proved that gap by making that allow-list database-only, which
  // survived all 958 tests. The branch needs the check as much as the SQL path
  // does: `updateMockOpportunity` spreads the body into the stored object, so
  // an unknown key there is unrestricted mass assignment with no SQL involved.
  it('refuses an unknown column with no database, where there is no SQL to inject', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(false as never);

    await request(listening(appAs('researcher_admin')))
      .patch(PATH)
      .send({ owner_user_id: 'someone-else' })
      .expect(400);

    expect(mockQuery).not.toHaveBeenCalled();
  });

  // THE MOCK-DATA PATH derives the flag the same way: only a real change of
  // status writes `auto_closed: false`. `mock-3` is a published demo study,
  // given a sweep's `true` first so both directions are observable.
  describe('with no database, auto_closed follows the same rule', () => {
    const MOCK_ID = 'mock-3';
    const patchMock = (body: Record<string, unknown>) =>
      request(listening(appAs('superadmin'))).patch(`/api/opportunities/${MOCK_ID}`).send(body);

    beforeEach(() => {
      mockIsDatabaseAvailable.mockResolvedValue(false as never);
      updateMockOpportunity(MOCK_ID, { status: 'published', auto_closed: true });
    });

    it('leaves auto_closed alone when the status written is the one the study has', async () => {
      const res = await patchMock({ status: 'published' }).expect(200);

      expect(res.body.auto_closed).toBe(true);
      expect(getMockOpportunity(MOCK_ID)?.auto_closed).toBe(true);
    });

    it('writes auto_closed false on a real change of status', async () => {
      const res = await patchMock({ status: 'closed' }).expect(200);

      expect(res.body.status).toBe('closed');
      expect(res.body.auto_closed).toBe(false);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
