import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

// #14: route suites use the session-trusting auth double (see middleware/__mocks__/authenticate.ts).
jest.mock('../../middleware/authenticate');
jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

import opportunitiesRouter, {
  resetParticipantRouteLimits,
  CONSENT_FIELDS_WRONG_TYPE,
  CONSENT_CLAIM_WITHOUT_TEXT,
} from '../opportunities';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';
import {
  DEFAULT_MODERATED_CONSENT_TEXT,
  MODERATED_CONSENT_TEMPLATE_ID,
  CUSTOM_CONSENT_TEMPLATE_ID,
} from '../../../../shared/firsthand/consent-templates';
import { DEFAULT_CONSENT_TEXT } from '../../../../shared/firsthand/inline-study';
import { toPublicOpportunity } from '../../utils/publicOpportunity';
import { addMockOpportunity } from '../../../../demo/mock-data';
import { wireConnectThroughQuery } from '../../__tests__/helpers/pooled-client-mock';

/**
 * Moderated consent on the opportunity write path (#79, step 1a).
 *
 * The rules under test, each with both directions:
 *  - consent fields are REFUSED on every type outside test/interview, by the
 *    exact exported sentence - a matcher on a word has lied here before
 *  - the stored template pair comes from RESOLUTION, never the request: the
 *    approved wording resolves to moderated-default v1, edited wording to
 *    custom, and a claim naming another kind's template is downgraded even
 *    when its text matches that template verbatim
 *  - clearing (consent_text: null) nulls the pair with the text
 *  - a template claim travelling without consent_text is refused - explicit
 *    nulls included, or the raw nulls bypass the resolver into the SET clause
 *  - a type change out of the moderated pair strips consent in the same UPDATE
 *  - POST /:id/duplicate COPIES the three columns - the review gate on the
 *    plan found the duplicate INSERT list silently dropping them
 *  - the public projection keeps consent_text, deliberately (the participant
 *    must read it before booking)
 */

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;

const CALLER = 'admin-1';

const appAs = (role: 'researcher_admin' | 'superadmin' = 'researcher_admin') => {
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

const RETURNING_ROW = {
  id: 'opp-1',
  type: 'test',
  title: 'A live session study',
  status: 'draft',
  owner_user_id: CALLER,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-02T00:00:00Z'),
  start_date: null,
  end_date: null,
};

/** An owned opportunity of the given type, reachable through every gate. */
const arrangeOwnedOpportunity = (type: string) => {
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
          type,
          title: 'A study',
          purpose_one_liner: 'To learn how people do things',
          status: 'draft',
          external_link_optional: null,
          firsthand_study_id: null,
          participant_type_required: 'any',
          delivery_mode: 'external',
        }],
        rowCount: 1,
      };
    }
    if (text.includes('SELECT * FROM opportunities')) {
      return {
        rows: [{
          ...RETURNING_ROW,
          type,
          purpose_one_liner: 'To learn how people do things',
          description_optional: null,
          product_optional: null,
          default_duration_minutes: 30,
          external_link_optional: null,
          participant_type_required: 'any',
          participant_type_specific_details: null,
          consent_text: 'Stored consent wording for the original.',
          consent_template_id: CUSTOM_CONSENT_TEMPLATE_ID,
          consent_template_version: null,
        }],
        rowCount: 1,
      };
    }
    return { rows: [{ ...RETURNING_ROW, type }], rowCount: 1 };
  });
};

const insertCall = () =>
  mockQuery.mock.calls.find((call: unknown[]) =>
    String(call[0]).includes('INSERT INTO opportunities')
  );

const updateCall = () =>
  mockQuery.mock.calls.find((call: unknown[]) =>
    String(call[0]).includes('UPDATE opportunities')
  );

beforeEach(() => {
  jest.resetAllMocks();
  mockIsDatabaseAvailable.mockResolvedValue(true as never);
  resetParticipantRouteLimits(CALLER);
});

describe('consent fields are for the moderated types only', () => {
  it.each(['unmoderated', 'poll', 'survey', 'question'])(
    'refuses consent_text on a %s PATCH, by the exact sentence',
    async (type) => {
      arrangeOwnedOpportunity(type);

      const res = await request(listening(appAs()))
        .patch('/api/opportunities/opp-1')
        .send({ consent_text: 'Some wording' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(CONSENT_FIELDS_WRONG_TYPE);
      // The refusal must precede the write, or it is a rollback pretending to
      // be a gate.
      expect(updateCall()).toBeUndefined();
    }
  );

  it('refuses consent_text on a non-moderated CREATE, same sentence', async () => {
    arrangeOwnedOpportunity('unmoderated');

    const res = await request(listening(appAs()))
      .post('/api/opportunities')
      .send({
        type: 'unmoderated',
        title: 'A recorded study',
        purpose_one_liner: 'To learn how people do things',
        consent_text: 'Some wording',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CONSENT_FIELDS_WRONG_TYPE);
    expect(insertCall()).toBeUndefined();
  });

  it('accepts consent_text on both moderated types', async () => {
    for (const type of ['test', 'interview']) {
      jest.resetAllMocks();
      mockIsDatabaseAvailable.mockResolvedValue(true as never);
      resetParticipantRouteLimits(CALLER);
      arrangeOwnedOpportunity(type);

      const res = await request(listening(appAs()))
        .patch('/api/opportunities/opp-1')
        .send({ consent_text: 'You are agreeing to a live call.' });

      expect(res.status).toBe(200);
      expect(updateCall()).toBeDefined();
    }
  });
});

describe('the stored template pair comes from resolution, never the request', () => {
  it('recognises the approved moderated wording with no claim at all', async () => {
    arrangeOwnedOpportunity('test');

    await request(listening(appAs()))
      .patch('/api/opportunities/opp-1')
      .send({ consent_text: DEFAULT_MODERATED_CONSENT_TEXT })
      .expect(200);

    const call = updateCall()!;
    const values = call[1] as unknown[];
    expect(values).toContain(MODERATED_CONSENT_TEMPLATE_ID);
    expect(values).toContain(1);
  });

  it('downgrades edited wording to custom, whatever the claim says', async () => {
    arrangeOwnedOpportunity('test');

    await request(listening(appAs()))
      .patch('/api/opportunities/opp-1')
      .send({
        consent_text: 'Wording somebody typed over the approved sentence.',
        consent_template_id: MODERATED_CONSENT_TEMPLATE_ID,
        consent_template_version: 1,
      })
      .expect(200);

    const values = updateCall()![1] as unknown[];
    expect(values).toContain(CUSTOM_CONSENT_TEMPLATE_ID);
    expect(values).not.toContain(MODERATED_CONSENT_TEMPLATE_ID);
  });

  it("refuses to record another kind's template even when the text matches it verbatim", async () => {
    // The recorded template's central claim - this product records your screen -
    // is false copy for a live session. resolveConsentTemplate's kind check is
    // what stops it; this pins that the route actually goes through it.
    arrangeOwnedOpportunity('test');

    await request(listening(appAs()))
      .patch('/api/opportunities/opp-1')
      .send({
        consent_text: DEFAULT_CONSENT_TEXT,
        consent_template_id: 'recorded-default',
        consent_template_version: 1,
      })
      .expect(200);

    const values = updateCall()![1] as unknown[];
    expect(values).toContain(CUSTOM_CONSENT_TEMPLATE_ID);
    expect(values).not.toContain('recorded-default');
  });

  it('clearing consent nulls the pair with the text', async () => {
    arrangeOwnedOpportunity('interview');

    await request(listening(appAs()))
      .patch('/api/opportunities/opp-1')
      .send({ consent_text: null })
      .expect(200);

    const call = updateCall()!;
    const sql = String(call[0]);
    expect(sql).toContain('consent_text');
    expect(sql).toContain('consent_template_id');
    expect(sql).toContain('consent_template_version');
    const values = call[1] as unknown[];
    // Three nulls travel: the row must not keep claiming a template for
    // wording it no longer holds.
    expect(values.filter((value) => value === null).length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a template claim travelling without consent_text, by the exact sentence', async () => {
    arrangeOwnedOpportunity('test');

    const res = await request(listening(appAs()))
      .patch('/api/opportunities/opp-1')
      .send({ consent_template_id: MODERATED_CONSENT_TEMPLATE_ID, consent_template_version: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CONSENT_CLAIM_WITHOUT_TEXT);
    expect(updateCall()).toBeUndefined();
  });

  it.each([
    ['a lone null template id', { consent_template_id: null }],
    ['a lone null version', { consent_template_version: null }],
    ['both halves null', { consent_template_id: null, consent_template_version: null }],
  ])(
    'refuses %s travelling without consent_text - nulls are a claim too',
    async (_shape, body) => {
      // These shapes used to answer 200 while the raw nulls bypassed the
      // resolver and reached the SET clause directly: a lone null id on a row
      // holding (moderated-default, 1) left (NULL, 1), which the shape
      // constraint rejects - a 500 mid-request instead of this sentence.
      arrangeOwnedOpportunity('test');

      const res = await request(listening(appAs()))
        .patch('/api/opportunities/opp-1')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe(CONSENT_CLAIM_WITHOUT_TEXT);
      expect(updateCall()).toBeUndefined();
    }
  );

  it('still clears when the pair rides along as nulls with a null text', async () => {
    // The one legal all-null shape: an explicit clear naming every column it
    // clears. The refusal above must not catch it.
    arrangeOwnedOpportunity('interview');

    await request(listening(appAs()))
      .patch('/api/opportunities/opp-1')
      .send({ consent_text: null, consent_template_id: null, consent_template_version: null })
      .expect(200);

    const call = updateCall()!;
    expect(String(call[0])).toContain('consent_text');
    expect((call[1] as unknown[]).filter((value) => value === null).length).toBeGreaterThanOrEqual(3);
  });
});

describe('a type change out of the moderated pair strips consent with it', () => {
  it('nulls all three consent columns when a moderated row becomes unmoderated', async () => {
    // Without the strip, the wording stays on the row - and public - on a type
    // whose every consent PATCH is refused by CONSENT_FIELDS_WRONG_TYPE, so
    // nobody could clear it without flipping the type back.
    arrangeOwnedOpportunity('test');

    await request(listening(appAs()))
      .patch('/api/opportunities/opp-1')
      .send({ type: 'unmoderated' })
      .expect(200);

    const call = updateCall()!;
    const sql = String(call[0]);
    expect(sql).toContain('consent_text');
    expect(sql).toContain('consent_template_id');
    expect(sql).toContain('consent_template_version');
    expect((call[1] as unknown[]).filter((value) => value === null).length).toBeGreaterThanOrEqual(3);
  });

  it('leaves consent untouched when the type moves within the pair', async () => {
    arrangeOwnedOpportunity('test');

    await request(listening(appAs()))
      .patch('/api/opportunities/opp-1')
      .send({ type: 'interview' })
      .expect(200);

    const call = updateCall()!;
    expect(String(call[0])).not.toContain('consent_text');
  });
});

describe('POST /:id/duplicate carries consent with the copy', () => {
  it('copies all three consent columns into the duplicate INSERT', async () => {
    // Duplicating is how a researcher runs a repeat study. A copy that dropped
    // consent would recruit and ingest recordings with no consent text at all -
    // the review gate found the duplicate INSERT list doing exactly that.
    arrangeOwnedOpportunity('test');

    const res = await request(listening(appAs()))
      .post('/api/opportunities/opp-1/duplicate')
      .send({});

    expect(res.status).toBe(201);
    const call = insertCall()!;
    expect(String(call[0])).toContain('consent_text');
    const values = call[1] as unknown[];
    expect(values).toContain('Stored consent wording for the original.');
    expect(values).toContain(CUSTOM_CONSENT_TEMPLATE_ID);
  });
});

describe('the consent length cap is pinned as a literal', () => {
  // 10000 written as a NUMBER, not derived from the constant: a test that
  // reads MAX_MODERATED_CONSENT_CHARS cannot see the constant change. The
  // constant's own docblock names this file as the pin - a security audit
  // found that claim false, so here is the test it promised.
  it('refuses 10001 characters on PATCH', async () => {
    arrangeOwnedOpportunity('test');

    const res = await request(listening(appAs()))
      .patch('/api/opportunities/opp-1')
      .send({ consent_text: 'a'.repeat(10001) });

    expect(res.status).toBe(400);
    expect(updateCall()).toBeUndefined();
  });

  it('accepts exactly 10000 characters on PATCH - the cap, not less', async () => {
    arrangeOwnedOpportunity('test');

    await request(listening(appAs()))
      .patch('/api/opportunities/opp-1')
      .send({ consent_text: 'a'.repeat(10000) })
      .expect(200);

    expect(updateCall()).toBeDefined();
  });

  it('refuses 10001 characters on CREATE too', async () => {
    arrangeOwnedOpportunity('test');

    const res = await request(listening(appAs()))
      .post('/api/opportunities')
      .send({
        type: 'test',
        title: 'A live session study',
        purpose_one_liner: 'To learn how people do things',
        consent_text: 'a'.repeat(10001),
      });

    expect(res.status).toBe(400);
    expect(insertCall()).toBeUndefined();
  });
});

describe('the mock branch enforces the same consent rules (no database)', () => {
  // The db branch's rules are pinned above through captured SQL; these pin the
  // MOCK branch (isDatabaseAvailable false), which a round-2 review gate found
  // asserted in a commit message but demonstrated by nothing. Dev-only, but a
  // dev path that strands or drops consent rehearses the production defect.
  const seedMockModerated = (id: string) => {
    addMockOpportunity({
      id,
      type: 'test',
      title: 'A mock live session',
      purpose_one_liner: 'To learn how people do things',
      status: 'draft',
      owner_user_id: CALLER,
      default_duration_minutes: 30,
      participant_type_required: 'any',
      consent_text: 'Mock consent wording.',
      consent_template_id: CUSTOM_CONSENT_TEMPLATE_ID,
      consent_template_version: null,
      created_at: new Date(),
      updated_at: new Date(),
      sessions: [],
    });
  };

  beforeEach(() => {
    mockIsDatabaseAvailable.mockResolvedValue(false as never);
  });

  it('strips consent when the type leaves the moderated pair', async () => {
    seedMockModerated('mock-consent-strip');

    const res = await request(listening(appAs()))
      .patch('/api/opportunities/mock-consent-strip')
      .send({ type: 'unmoderated' });

    expect(res.status).toBe(200);
    expect(res.body.consent_text).toBeNull();
    expect(res.body.consent_template_id).toBeNull();
    expect(res.body.consent_template_version).toBeNull();
  });

  it('resolves the stored pair on a mock consent write', async () => {
    seedMockModerated('mock-consent-resolve');

    const res = await request(listening(appAs()))
      .patch('/api/opportunities/mock-consent-resolve')
      .send({ consent_text: DEFAULT_MODERATED_CONSENT_TEXT });

    expect(res.status).toBe(200);
    expect(res.body.consent_template_id).toBe(MODERATED_CONSENT_TEMPLATE_ID);
    expect(res.body.consent_template_version).toBe(1);
  });

  it('copies all three consent columns into a mock duplicate', async () => {
    seedMockModerated('mock-consent-dup');

    const res = await request(listening(appAs()))
      .post('/api/opportunities/mock-consent-dup/duplicate')
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.consent_text).toBe('Mock consent wording.');
    expect(res.body.consent_template_id).toBe(CUSTOM_CONSENT_TEMPLATE_ID);
    expect(res.body.consent_template_version).toBeNull();
  });
});

describe('the public projection keeps consent, deliberately', () => {
  it('leaves consent_text and the template pair on the anonymous payload', () => {
    // A VERDICT pinned, not an oversight tolerated: a participant must read a
    // moderated opportunity's consent wording BEFORE booking, so it is
    // participant-facing by construction, and the template pair is non-secret
    // provenance. publicOpportunity is a deny-list, so this test fails only if
    // somebody starts stripping these - which is the moment to re-read the
    // verdict in publicOpportunity.ts, not to widen this expectation.
    const publicRow = toPublicOpportunity({
      id: 'opp-1',
      owner_user_id: 'someone',
      owner_name: 'S',
      owner_email: 's@example.com',
      consent_text: 'You are agreeing to a live call.',
      consent_template_id: MODERATED_CONSENT_TEMPLATE_ID,
      consent_template_version: 1,
    } as never) as Record<string, unknown>;

    expect(publicRow.consent_text).toBe('You are agreeing to a live call.');
    expect(publicRow.consent_template_id).toBe(MODERATED_CONSENT_TEMPLATE_ID);
    expect(publicRow.consent_template_version).toBe(1);
    // The control: the deny-list still denies what it exists to deny.
    expect(publicRow.owner_user_id).toBeUndefined();
    expect(publicRow.owner_email).toBeUndefined();
  });
});
