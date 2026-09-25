import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

// The count itself (which sessions and answers it counts) can only be proved
// against a real database, and is, in
// opportunity-response-totals-postgres.test.ts. This file mocks the reader
// entirely and pins what only a mocked pool can show: which rows the route
// decides are APPLICABLE, what it hands the reader, and how a failure
// degrades.
jest.mock('../../firsthand/opportunity-response-totals', () => ({
  loadOpportunityResponseTotals: jest.fn(),
}));

import opportunitiesRouter from '../opportunities';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { loadOpportunityResponseTotals } from '../../firsthand/opportunity-response-totals';
import { RuntimeDatabaseBusyError } from '../../firsthand/runtime-pool-admission';
import { errorHandler } from '../../utils/errorHandler';

const mockQuery = pool.query as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;
const mockLoadResponseTotals = loadOpportunityResponseTotals as jest.MockedFunction<
  typeof loadOpportunityResponseTotals
>;

/**
 * `responses_total` ON THE ADMIN LIST (cto/AdaptaLabs#162): THE WIRING, WITH
 * A MOCKED POOL AND A MOCKED READER.
 *
 * What the count IS (which sessions and answers it counts) is proved against
 * a real database in `opportunity-response-totals-postgres.test.ts`. This
 * file pins what a mocked pool and a mocked reader CAN show:
 *
 *   - the field is present only for a native poll, survey or question row,
 *     never for an external hand-off or an unmoderated (recorded) row, and
 *     never for a non-admin caller;
 *   - a native row with no linked study reads 0 without ever being sent to
 *     the reader (an empty pair list is never worth a runtime-pool round
 *     trip);
 *   - the reader is handed exactly the SCOPED id/study pairs the listing
 *     query returned - never re-derived - and is skipped altogether when the
 *     page has no applicable row;
 *   - a failed read (a thrown error, or `RuntimeDatabaseBusyError`) leaves
 *     the field ABSENT, never a fabricated 0.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const USERS: Readonly<Record<string, Role>> = {
  'admin-1': 'researcher_admin',
  'user-1': 'employee',
};

const appAs = (role: Role | null, id = 'admin-1', path = '/api/opportunities') => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = role
      ? { user: { id, name: 'A', email: 'a@example.com', role } }
      : {};
    next();
  });
  app.use('/api/opportunities', opportunitiesRouter);
  app.use(errorHandler);
  return request(listening(app)).get(path);
};

type Row = {
  id: string;
  type: string;
  delivery_mode: string | null;
  firsthand_study_id: string | null;
  [key: string]: unknown;
};

const row = (over: Partial<Row> & Pick<Row, 'id' | 'type'>): Row => ({
  title: `Study ${over.id}`,
  status: 'published',
  owner_user_id: 'admin-1',
  owner_name: 'Owner',
  owner_email: 'owner@example.com',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  start_date: null,
  end_date: null,
  delivery_mode: null,
  firsthand_study_id: null,
  ...over,
});

const NATIVE_POLL = row({
  id: '11111111-1111-4111-8111-111111111111',
  type: 'poll',
  delivery_mode: 'native',
  firsthand_study_id: 'study_poll',
});
const NATIVE_SURVEY = row({
  id: '22222222-2222-4222-8222-222222222222',
  type: 'survey',
  delivery_mode: 'native',
  firsthand_study_id: 'study_survey',
});
const NATIVE_QUESTION = row({
  id: '33333333-3333-4333-8333-333333333333',
  type: 'question',
  delivery_mode: 'native',
  firsthand_study_id: 'study_question',
});
const EXTERNAL_SURVEY = row({
  id: '44444444-4444-4444-8444-444444444444',
  type: 'survey',
  delivery_mode: 'external',
  firsthand_study_id: 'study_external',
});
const UNMODERATED = row({
  id: '55555555-5555-4555-8555-555555555555',
  type: 'unmoderated',
  // A native-looking delivery_mode on a type outside QUESTION_CARRYING_TYPES,
  // so a test failure here would show TYPE gates the field, not merely
  // delivery_mode.
  delivery_mode: 'native',
  firsthand_study_id: 'study_unmoderated',
});
const NATIVE_NO_STUDY = row({
  id: '66666666-6666-4666-8666-666666666666',
  type: 'poll',
  delivery_mode: 'native',
  firsthand_study_id: null,
});

const seedListRows = (rows: Row[]) => {
  mockQuery.mockImplementation(async (sql: unknown, params?: unknown) => {
    const text = String(sql);
    if (text.includes('SELECT role FROM users')) {
      const roleFor = USERS[(params as string[])[0]];
      return { rows: roleFor ? [{ role: roleFor }] : [] };
    }
    if (text.includes('FROM opportunities o')) {
      return { rows };
    }
    return { rows: [] };
  });
};

describe('GET /api/opportunities responses_total (mocked pool and reader)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockLoadResponseTotals.mockResolvedValue(new Map());
  });

  it.each([
    ['native poll', NATIVE_POLL],
    ['native survey', NATIVE_SURVEY],
    ['native question', NATIVE_QUESTION],
  ])('carries responses_total for a %s', async (_label, oneRow) => {
    seedListRows([oneRow]);
    mockLoadResponseTotals.mockResolvedValue(new Map([[oneRow.id, 4]]));

    const res = await appAs('researcher_admin').expect(200);

    expect(res.body[0].responses_total).toBe(4);
  });

  it.each([
    ['an external hand-off survey', EXTERNAL_SURVEY],
    ['an unmoderated (recorded) study', UNMODERATED],
  ])('never carries responses_total for %s', async (_label, oneRow) => {
    seedListRows([oneRow]);

    const res = await appAs('researcher_admin').expect(200);

    expect(res.body[0]).not.toHaveProperty('responses_total');
    // THE CONTROL: the reader is never even asked about a row that cannot
    // carry the field, so a leftover pair from another row could not leak a
    // count onto it by accident.
    expect(mockLoadResponseTotals).not.toHaveBeenCalled();
  });

  it.each([
    ['a signed-in participant', 'employee' as Role, 'user-1'],
    ['an anonymous caller', null, 'anon'],
  ])('sends %s no responses_total field on any row, native included', async (_label, role, id) => {
    seedListRows([NATIVE_POLL, EXTERNAL_SURVEY]);

    const res = await appAs(role, id).expect(200);

    // THE CONTROL: both rows really are in the list, so the absences below
    // are about the field and not an empty response.
    expect(res.body).toHaveLength(2);
    for (const opportunity of res.body) {
      expect(opportunity).not.toHaveProperty('responses_total');
    }
    expect(mockLoadResponseTotals).not.toHaveBeenCalled();
  });

  it('reads 0 for a native row with no linked study, and never sends its pair to the reader', async () => {
    seedListRows([NATIVE_NO_STUDY]);

    const res = await appAs('researcher_admin').expect(200);

    // 0 is a real value for a native study with no answers - and here, no
    // study to have answered at all.
    expect(res.body[0].responses_total).toBe(0);
    expect(mockLoadResponseTotals).not.toHaveBeenCalled();
  });

  it('hands the reader exactly the scoped native pairs, in one call, and never a non-applicable row', async () => {
    seedListRows([NATIVE_POLL, EXTERNAL_SURVEY, NATIVE_SURVEY, NATIVE_NO_STUDY]);
    mockLoadResponseTotals.mockResolvedValue(
      new Map([
        [NATIVE_POLL.id, 1],
        [NATIVE_SURVEY.id, 2],
      ])
    );

    const res = await appAs('researcher_admin', 'admin-1', '/api/opportunities?scope=mine').expect(
      200
    );

    expect(mockLoadResponseTotals).toHaveBeenCalledTimes(1);
    const pairs = mockLoadResponseTotals.mock.calls[0][0];
    expect(pairs).toEqual([
      { opportunityId: NATIVE_POLL.id, studyId: NATIVE_POLL.firsthand_study_id },
      { opportunityId: NATIVE_SURVEY.id, studyId: NATIVE_SURVEY.firsthand_study_id },
    ]);
    // The external row never counted toward the call at all, and the
    // no-study native row was excluded from the PAIRS (it is still
    // applicable - see the 0 test above - just never sent).
    const ids = pairs.map((pair: { opportunityId: string }) => pair.opportunityId);
    expect(ids).not.toContain(EXTERNAL_SURVEY.id);
    expect(ids).not.toContain(NATIVE_NO_STUDY.id);

    const byId = new Map(res.body.map((opportunity: Row) => [opportunity.id, opportunity]));
    expect((byId.get(NATIVE_POLL.id) as Row).responses_total).toBe(1);
    expect((byId.get(NATIVE_SURVEY.id) as Row).responses_total).toBe(2);
  });

  it('never calls the reader when the page has no applicable row', async () => {
    seedListRows([EXTERNAL_SURVEY, UNMODERATED]);

    await appAs('researcher_admin').expect(200);

    expect(mockLoadResponseTotals).not.toHaveBeenCalled();
  });

  it('leaves responses_total ABSENT, not 0, when the reader throws', async () => {
    seedListRows([NATIVE_POLL]);
    mockLoadResponseTotals.mockRejectedValue(new Error('simulated runtime-pool failure'));

    const res = await appAs('researcher_admin').expect(200);

    // THE CONTROL: the list itself still arrived.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(NATIVE_POLL.id);
    expect(res.body[0]).not.toHaveProperty('responses_total');
  });

  it('leaves responses_total ABSENT, not 0, when the reader is skipped as busy', async () => {
    seedListRows([NATIVE_POLL]);
    mockLoadResponseTotals.mockRejectedValue(new RuntimeDatabaseBusyError());

    const res = await appAs('researcher_admin').expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0]).not.toHaveProperty('responses_total');
  });
});
