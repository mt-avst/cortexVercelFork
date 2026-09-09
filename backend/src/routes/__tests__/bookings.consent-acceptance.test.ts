import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { createHash } from 'crypto';

import { listening } from '../../__tests__/helpers/listening';

/**
 * Consent acceptance at booking (#79, step 1b).
 *
 * The rules under test, each in both directions:
 *  - an opportunity carrying consent_text REFUSES a booking whose body does
 *    not carry explicit acceptance, by the exact exported sentence, with no
 *    INSERT built - a refusal after the write is a rollback pretending to be
 *    a gate
 *  - acceptance writes the moment, the template pair and a sha256 of the
 *    TRIMMED text onto the booking row - the acceptance pins WHAT was
 *    accepted, which the runtime path never does
 *  - an opportunity without consent text books exactly as before, acceptance
 *    flag or not - there is nothing to accept, so nothing is recorded
 *  - both participant projections carry the acceptance columns deliberately:
 *    the participant accepted it, it is their record too
 */

jest.mock('../../middleware/authenticate');

jest.mock('../../config', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(async () => true),
}));

jest.mock('../../services/email', () => ({
  __esModule: true,
  default: { sendEmail: jest.fn(async () => ({ success: true, messageId: 'test' })) },
  EmailService: {
    getBookingConfirmationTemplate: jest.fn(() => ({})),
    getBookingCancellationTemplate: jest.fn(() => ({})),
    getAdminNotificationTemplate: jest.fn(() => ({})),
  },
}));

// redactSensitiveUrl included because errorHandler imports it from the same
// module: a factory holding only `logger` makes the ERROR HANDLER throw on the
// refusal path, and every 400 in this file becomes a bodiless 500.
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  redactSensitiveUrl: (url: string | undefined) => url,
}));

import bookingsRouter, { CONSENT_ACCEPTANCE_REQUIRED, CONSENT_WORDING_CHANGED } from '../bookings';
import { pool } from '../../config';
import { errorHandler } from '../../utils/errorHandler';
import {
  MODERATED_CONSENT_TEMPLATE,
  MODERATED_CONSENT_TEMPLATE_ID,
} from '../../../../shared/firsthand/consent-templates';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

// Padded on purpose: the hash must be of the TRIMMED text, so a fixture that
// is already trimmed could not tell hash(text) from hash(text.trim()).
const CONSENT_TEXT = '  You are agreeing to a live call that may be recorded.  ';
const CONSENT_TEXT_TRIMMED = CONSENT_TEXT.trim();
const EXPECTED_HASH = createHash('sha256').update(CONSENT_TEXT_TRIMMED).digest('hex');
const ACCEPTED_AT = new Date('2026-08-28T10:00:00Z');

const appAs = (id: string) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user: { id: string; name: string; email: string; role: string } } }).session = {
      user: { id, name: 'Ada', email: 'ada@example.com', role: 'employee' },
    };
    next();
  });
  app.use('/api/bookings', bookingsRouter);
  app.use(errorHandler);
  return app;
};

/** A transaction client whose locked session row carries the given consent. */
const bookingClient = (consent: {
  opportunity_type: string;
  consent_text: string | null;
  consent_template_id: string | null;
  consent_template_version: number | null;
}) => ({
  query: jest.fn(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('FROM sessions')) {
      return {
        rows: [
          {
            id: 's1',
            opportunity_id: 'opp-1',
            start_time: FUTURE,
            end_time: FUTURE,
            capacity: 5,
            booked_count: 0,
            opportunity_status: 'published',
            opportunity_title: 'A live session study',
            owner_user_id: null,
            purpose_one_liner: 'A study',
            location_or_meet_link_optional: 'Room 3B',
            ...consent,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes('INSERT INTO bookings')) {
      // The RETURNING row carries the consent columns POPULATED. A bare
      // {id, session_id, status} fixture made the 201 snapshot-exclusion pin
      // vacuous: `not.toHaveProperty('consent_text_snapshot')` asserted the
      // absence of a property the row could never produce, and a review gate
      // PROVED it by spreading `...booking` into the 201 - the exact
      // researcher_notes-leak regression shape - past 1122 green tests.
      return {
        rows: [{
          id: 'b1',
          session_id: 's1',
          status: 'booked',
          consent_accepted_at: consent.consent_text ? ACCEPTED_AT : null,
          consent_template_id: consent.consent_template_id,
          consent_template_version: consent.consent_template_version,
          consent_text_snapshot_hash: consent.consent_text ? EXPECTED_HASH : null,
          consent_text_snapshot: consent.consent_text
            ? consent.consent_text.trim()
            : null,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: jest.fn(),
});

const statementsOn = (client: { query: jest.Mock }) =>
  client.query.mock.calls.map((call: unknown[]) => String(call[0]));

const insertCallOn = (client: { query: jest.Mock }) =>
  client.query.mock.calls.find((call: unknown[]) =>
    String(call[0]).includes('INSERT INTO bookings')
  );

// A moderated opportunity carrying its OWN wording (a researcher typed it).
const WITH_CONSENT = {
  opportunity_type: 'test',
  consent_text: CONSENT_TEXT,
  consent_template_id: 'moderated-default',
  consent_template_version: 1,
};

// A moderated opportunity carrying NO wording of its own. Before audit row 9
// this booked with no consent step at all; now the Cortex-owned baseline
// applies, resolved at booking time from the type - no server-side seeding.
const BASELINE_CONSENT = {
  opportunity_type: 'test',
  consent_text: null,
  consent_template_id: null,
  consent_template_version: null,
};

// A non-moderated type has nothing to accept at booking - the control that the
// gate is TYPE-scoped, not "any opportunity with a null consent_text".
const WITHOUT_CONSENT = {
  opportunity_type: 'survey',
  consent_text: null,
  consent_template_id: null,
  consent_template_version: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

describe('POST /sessions/:id/book on an opportunity carrying consent', () => {
  it('refuses a body without acceptance, by the exact sentence, before any INSERT', async () => {
    const client = bookingClient(WITH_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CONSENT_ACCEPTANCE_REQUIRED);
    expect(insertCallOn(client)).toBeUndefined();
    expect(statementsOn(client)).toContain('ROLLBACK');
  });

  it('refuses consent_accepted: false the same way - only true is acceptance', async () => {
    const client = bookingClient(WITH_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({ consent_accepted: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CONSENT_ACCEPTANCE_REQUIRED);
    expect(insertCallOn(client)).toBeUndefined();
  });

  it('refuses a truthy non-boolean too - "yes" is not acceptance', async () => {
    const client = bookingClient(WITH_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({ consent_accepted: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CONSENT_ACCEPTANCE_REQUIRED);
  });

  it('books on acceptance and records the moment, the pair and the trimmed-text hash', async () => {
    const client = bookingClient(WITH_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({ consent_accepted: true, consent_text_seen: CONSENT_TEXT });

    expect(res.status).toBe(201);
    const insert = insertCallOn(client)!;
    const sql = String(insert[0]);
    expect(sql).toContain('consent_accepted_at');
    expect(sql).toContain('consent_template_id');
    expect(sql).toContain('consent_template_version');
    expect(sql).toContain('consent_text_snapshot_hash');
    expect(sql).toContain('consent_text_snapshot');
    // The timestamp is the DATABASE's clock, derived in SQL from the snapshot
    // param - an app-host Date here could precede the row's own created_at
    // under skew, and a legal record must not argue with itself.
    expect(sql).toContain('NOW()');

    const values = insert[1] as unknown[];
    expect(values.some((value) => value instanceof Date)).toBe(false);
    expect(values).toContain('moderated-default');
    expect(values).toContain(1);
    // The wording ITSELF travels, trimmed - the hash can prove a later edit
    // happened but can never produce the sentence the participant agreed to.
    expect(values).toContain(CONSENT_TEXT_TRIMMED);
    // The hash of the TRIMMED text, computed independently here. A hash of the
    // padded fixture would fail this - which is the point.
    expect(values).toContain(EXPECTED_HASH);
  });

  it('echoes the acceptance record on the 201, snapshot text excluded', async () => {
    const client = bookingClient(WITH_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({ consent_accepted: true, consent_text_seen: CONSENT_TEXT });

    expect(res.status).toBe(201);
    // VALUES from the RETURNING row, not property presence - presence pins
    // pass against a map hardcoding four nulls. And the exclusion now bites:
    // the mocked row CARRIES consent_text_snapshot, so a `...booking` spread
    // into this response - the researcher_notes-leak shape - fails here.
    expect(res.body.consent_accepted_at).toBe(ACCEPTED_AT.toISOString());
    expect(res.body.consent_template_id).toBe('moderated-default');
    expect(res.body.consent_template_version).toBe(1);
    expect(res.body.consent_text_snapshot_hash).toBe(EXPECTED_HASH);
    expect(res.body).not.toHaveProperty('consent_text_snapshot');
  });

  it('refuses an acceptance whose echoed wording differs, by its own sentence', async () => {
    // Accept-what-you-saw: a researcher edit between page load and Accept must
    // not record acceptance of wording the participant never read.
    const client = bookingClient(WITH_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({ consent_accepted: true, consent_text_seen: 'Older wording from before the edit.' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CONSENT_WORDING_CHANGED);
    expect(insertCallOn(client)).toBeUndefined();
  });

  it('refuses an acceptance with no echo at all - unseen is unproven', async () => {
    const client = bookingClient(WITH_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({ consent_accepted: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CONSENT_WORDING_CHANGED);
    expect(insertCallOn(client)).toBeUndefined();
  });

  it('compares the echo TRIMMED - whitespace drift is not a wording change', async () => {
    const client = bookingClient(WITH_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({ consent_accepted: true, consent_text_seen: `\n${CONSENT_TEXT_TRIMMED}  ` });

    expect(res.status).toBe(201);
    expect(insertCallOn(client)).toBeDefined();
  });
});

describe('POST /sessions/:id/book on a non-moderated opportunity (nothing to accept)', () => {
  it('books exactly as before, with nothing recorded', async () => {
    const client = bookingClient(WITHOUT_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({});

    expect(res.status).toBe(201);
    const values = insertCallOn(client)![1] as unknown[];
    // user_id and session_id travel; every consent value is null.
    expect(values.filter((value) => value === null).length).toBeGreaterThanOrEqual(4);
    expect(values.some((value) => value instanceof Date)).toBe(false);
  });

  it('records nothing even when the body volunteers acceptance - there is nothing to accept', async () => {
    const client = bookingClient(WITHOUT_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({ consent_accepted: true });

    expect(res.status).toBe(201);
    const values = insertCallOn(client)![1] as unknown[];
    expect(values.filter((value) => value === null).length).toBeGreaterThanOrEqual(4);
    expect(values.some((value) => value instanceof Date)).toBe(false);
  });

  it('the locked session SELECT reads the consent columns it gates on', async () => {
    // The gate reads consent off the SAME locked row as every other guard. If
    // the join stops selecting these, the gate sees undefined and every
    // booking sails through - this pins the SELECT text itself.
    const client = bookingClient(WITHOUT_CONSENT);
    mockConnect.mockImplementation(async () => client);

    await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({});

    const sessionSelect = statementsOn(client).find((sql) => sql.includes('FROM sessions'));
    expect(sessionSelect).toBeDefined();
    // o.type rides too: the baseline gate resolves off the opportunity type,
    // so a join that stops selecting it would blind the gate to a moderated
    // session with a null consent_text and book it silently again.
    expect(sessionSelect).toContain('o.type');
    expect(sessionSelect).toContain('o.consent_text');
    expect(sessionSelect).toContain('o.consent_template_id');
    expect(sessionSelect).toContain('o.consent_template_version');
  });
});

describe('POST /sessions/:id/book on a moderated opportunity with no wording of its own (baseline)', () => {
  const BASELINE_TEXT = MODERATED_CONSENT_TEMPLATE.text;
  const BASELINE_HASH = createHash('sha256').update(BASELINE_TEXT).digest('hex');

  it('refuses a body without acceptance - the baseline is consent to accept, before any INSERT', async () => {
    const client = bookingClient(BASELINE_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CONSENT_ACCEPTANCE_REQUIRED);
    expect(insertCallOn(client)).toBeUndefined();
    expect(statementsOn(client)).toContain('ROLLBACK');
  });

  it('refuses an acceptance echoing anything but the baseline wording', async () => {
    const client = bookingClient(BASELINE_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({ consent_accepted: true, consent_text_seen: 'Some other wording.' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(CONSENT_WORDING_CHANGED);
    expect(insertCallOn(client)).toBeUndefined();
  });

  it('books on acceptance of the baseline, recording moderated-default and the baseline-text hash', async () => {
    const client = bookingClient(BASELINE_CONSENT);
    mockConnect.mockImplementation(async () => client);

    const res = await request(listening(appAs('u1')))
      .post('/api/bookings/sessions/s1/book')
      .send({ consent_accepted: true, consent_text_seen: BASELINE_TEXT });

    expect(res.status).toBe(201);
    const values = insertCallOn(client)![1] as unknown[];
    // The template pair is the baseline's, resolved from the type - NOT the
    // opportunity's null columns.
    expect(values).toContain(MODERATED_CONSENT_TEMPLATE_ID);
    expect(values).toContain(MODERATED_CONSENT_TEMPLATE.version);
    // The wording itself and its hash are the BASELINE, not empty.
    expect(values).toContain(BASELINE_TEXT);
    expect(values).toContain(BASELINE_HASH);
    expect(values.some((value) => value instanceof Date)).toBe(false);
  });
});

describe('the participant projections carry the acceptance columns, deliberately', () => {
  // The roster (researcher view) reads `b.*`, so the columns ride there by
  // construction. These two are explicit allow-list projections, so the
  // columns appear only on purpose - the participant accepted the wording,
  // and their own record must say so.
  // BOTH halves per route, because they fail differently: the SQL-text pin
  // sees the SELECT narrow, and the loaded-row pin sees the field-by-field
  // response map drop what the SELECT read. The first version of this file
  // had only the SQL pins, and a review gate PROVED the columns never left
  // the server - both routes serialise explicitly, and neither map named
  // them. A projection test that never loads a row cannot see the map.
  const CONSENT_ROW_FIELDS = {
    consent_accepted_at: ACCEPTED_AT,
    consent_template_id: 'moderated-default',
    consent_template_version: 1,
    consent_text_snapshot_hash: EXPECTED_HASH,
  };

  it('GET /my/bookings sends the acceptance record to the wire', async () => {
    const start = new Date('2030-01-07T10:00:00Z');
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'b1',
          user_id: 'u1',
          session_id: 's1',
          status: 'booked',
          completion_status: null,
          completed_at: null,
          gcal_event_id: null,
          reminder_sent_at: null,
          session_capacity: 1,
          session_location: null,
          opportunity_title: 'A live session study',
          opportunity_type: 'test',
          opportunity_purpose: 'A study',
          owner_name: 'R',
          owner_email: 'r@example.com',
          session_start_time: start,
          session_end_time: start,
          cancelled_at: null,
          created_at: start,
          updated_at: start,
          ...CONSENT_ROW_FIELDS,
        },
      ],
      rowCount: 1,
    } as never);

    const res = await request(listening(appAs('u1'))).get('/api/bookings/my/bookings');

    expect(res.status).toBe(200);
    const booking = res.body.upcoming[0];
    expect(booking.consent_accepted_at).toBe(ACCEPTED_AT.toISOString());
    expect(booking.consent_template_id).toBe('moderated-default');
    expect(booking.consent_template_version).toBe(1);
    expect(booking.consent_text_snapshot_hash).toBe(EXPECTED_HASH);
  });

  it('GET /my/bookings/all sends the acceptance record to the wire', async () => {
    const created = new Date('2030-01-07T10:00:00Z');
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'b1',
          session_id: 's1',
          status: 'booked',
          created_at: created,
          cancelled_at: null,
          opportunity_title: 'A live session study',
          opportunity_type: 'test',
          session_start_time: created,
          session_end_time: created,
          cursor_at: created,
          ...CONSENT_ROW_FIELDS,
        },
      ],
      rowCount: 1,
    } as never);

    const res = await request(listening(appAs('u1'))).get('/api/bookings/my/bookings/all');

    expect(res.status).toBe(200);
    const booking = res.body.bookings[0];
    expect(booking.consent_accepted_at).toBe(ACCEPTED_AT.toISOString());
    expect(booking.consent_template_id).toBe('moderated-default');
    expect(booking.consent_template_version).toBe(1);
    expect(booking.consent_text_snapshot_hash).toBe(EXPECTED_HASH);
  });

  it.each([
    ['GET /my/bookings', '/api/bookings/my/bookings'],
    ['GET /my/bookings/all', '/api/bookings/my/bookings/all'],
  ])('%s selects the acceptance columns but never the snapshot text', async (_name, path) => {
    await request(listening(appAs('u1'))).get(path);

    const projected = mockQuery.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((sql: string) => /FROM\s+bookings\s+b/i.test(sql));

    expect(projected.length).toBeGreaterThan(0);
    for (const sql of projected) {
      expect(sql).toContain('b.consent_accepted_at');
      expect(sql).toContain('b.consent_template_id');
      expect(sql).toContain('b.consent_template_version');
      expect(sql).toContain('b.consent_text_snapshot_hash');
      // The snapshot TEXT stays off the participant lists on purpose: the
      // reader is already looking at the live wording, and repeating up to
      // 10k chars per row is weight without a reader. The negative lookahead
      // matters - the hash column CONTAINS this name as a prefix.
      expect(sql).not.toMatch(/b\.consent_text_snapshot(?!_hash)/);
    }
  });
});
