import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

jest.mock('../../config', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../../utils/database', () => ({
  isDatabaseAvailable: jest.fn(),
}));

// The real module is SPREAD, not listed. errorHandler imports
// `redactSensitiveUrl` from here as well as `logger`, so a factory that
// enumerates exports turned every 403 in this file into a 500 - a mock is a
// contract too, and this one was missing half of it.
jest.mock('../../utils/logger', () => {
  const actual = jest.requireActual('../../utils/logger') as Record<string, unknown>;
  return {
    ...actual,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  };
});

jest.mock('../../services/email', () => ({
  __esModule: true,
  default: { sendEmail: jest.fn() },
  EmailService: {
    getBookingCancellationTemplate: jest.fn(),
    getAdminNotificationTemplate: jest.fn(),
  },
}));

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';
import emailService, { EmailService } from '../../services/email';
import { logger } from '../../utils/logger';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;
const mockSendEmail = emailService.sendEmail as unknown as jest.Mock;
const mockCancellationTemplate = EmailService.getBookingCancellationTemplate as unknown as jest.Mock;
const mockAdminTemplate = EmailService.getAdminNotificationTemplate as unknown as jest.Mock;
const mockLogError = logger.error as unknown as jest.Mock;

/**
 * THE CANCELLATION NOTICE WENT TO WHOEVER PRESSED THE BUTTON.
 *
 * `POST /api/bookings/:id/cancel` loaded its booking with one join onto
 * `users`, on `o.owner_user_id`. It never joined `b.user_id`, so the
 * PARTICIPANT'S IDENTITY WAS NOT IN SCOPE - and `req.user` was the only
 * identity the email block could reach. A participant cancelling their own
 * booking therefore looked correct and hid the defect for as long as that was
 * the only path anyone exercised.
 *
 * A researcher cancelling somebody out of a session produced, before this fix:
 *   - the participant hearing NOTHING. Their slot was gone, the calendar event
 *     was deleted, and the first they would know of it is turning up.
 *   - the RESEARCHER receiving the participant's copy - "Hello <researcher>,
 *     your booking has been cancelled ... Cancelled by: <researcher>".
 *   - the OWNER'S copy naming the researcher as the participant, so a
 *     "participant cancelled" notice reported the wrong person entirely.
 *
 * Three separate records described the behaviour the code could not perform -
 * a canary `why`, and two docblocks in bookings.cancel-ownership.test.ts. None
 * of them was wrong about the INTENT. That is what a missing join costs: every
 * reader downstream describes the join they assume is there.
 *
 * WHAT THIS FILE CAN AND CANNOT SEE. `pool` is mocked, so no SQL is executed
 * and nothing here proves the join is CORRECT against a real schema. What the
 * fixture does instead is model the database's contract: `bookingRow` returns
 * `participant_name` / `participant_email` / `start_time` ONLY IF the statement
 * the handler sent actually asked for them, so the recipient assertions fail by
 * name rather than passing on a fixture handing over data the query never
 * requested.
 *
 * THE ORACLE IS A PARSER, NOT A SUBSTRING TEST, AND THAT COST TWO GATE
 * FINDINGS. The first draft asked `sql.includes('JOIN users pu ON b.user_id =
 * pu.id')`, which is a test over SQL TEXT rather than SQL MEANING, and it was
 * wrong in both directions:
 *
 *   - COMMENTING the join out - `-- JOIN users pu ON ...` - left the substring
 *     intact and passed all 54 tests, including the one named
 *     `joins the participant and selects the columns the email block reads`.
 *     In production that is byte-for-byte the pre-fix defect.
 *   - Three SEMANTICALLY IDENTICAL rewrites failed 7 tests each: renaming the
 *     alias `pu` to `p`, putting the ON clause on its own line, and writing
 *     `AS` instead of `as`. That is not hypothetical house style -
 *     `services/reminders.ts:59-66` is the correct precedent for this very
 *     join in this very repo and writes `pu.name AS participant_name` with
 *     `ON pu.id = b.user_id`. Copying the good example would have reddened
 *     seven tests on an unchanged query.
 *
 * So the oracle now strips comments, anchors the join at a line start, binds
 * the alias with a backreference and accepts either operand order and either
 * case. It models what Postgres would put in scope; the INNER-vs-LEFT choice
 * the handler comment reasons about is asserted separately and by name, since
 * a LEFT JOIN would also bring the columns into scope.
 */
type Role = 'employee' | 'researcher_admin' | 'superadmin';

const OWNER = { id: 'admin-1', name: 'Olive Owner', email: 'olive@example.com' };
const PARTICIPANT = { id: 'participant-1', name: 'Pat Participant', email: 'pat@example.com' };
const OTHER_ADMIN = { id: 'admin-2', name: 'Adam Admin', email: 'adam@example.com' };

const appAs = (role: Role, user: { id: string; name: string; email: string }) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { user: { ...user, role } };
    next();
  });
  app.use('/api/bookings', bookingsRouter);
  app.use(errorHandler);
  return app;
};

const PATH = '/api/bookings/b1/cancel';

/** Far enough ahead that the "cannot cancel past sessions" check never fires. */
const START = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const END = new Date(START.getTime() + 60 * 60 * 1000);

/**
 * The loaded booking, built from what the statement ACTUALLY SELECTED.
 *
 * A plain fixture would return every column regardless, which makes a missing
 * join invisible: the handler would read `booking.participant_email`, get a
 * value the query never asked for, and every assertion below would pass while
 * production sent mail to `undefined`. So each column the fix added is gated on
 * the statement naming it, and the participant columns are additionally gated
 * on the join that brings them into scope.
 */
/** SQL with `--` comments removed, because a commented-out clause does nothing. */
const executable = (sql: string) => sql.replace(/--[^\n]*/g, '');

/**
 * The alias a join onto `users` keyed on `b.user_id` was given, or undefined if
 * there is no such join. Anchored at a line start so a commented clause cannot
 * match, and the alias is bound by backreference so the name itself is free.
 */
const participantJoinAlias = (sql: string): string | undefined =>
  /(^|\n)\s*(?:LEFT\s+|INNER\s+)?JOIN\s+users\s+(\w+)\s+ON\s+(?:b\.user_id\s*=\s*\2\.id|\2\.id\s*=\s*b\.user_id)/i
    .exec(executable(sql))?.[2];

/** Whether the statement selects `<alias>.<column> AS <output>`, in any case. */
const selectsAs = (sql: string, alias: string, column: string, output: string) =>
  new RegExp(`\\b${alias}\\.${column}\\s+AS\\s+${output}\\b`, 'i').test(executable(sql));

const bookingRow = (sql: string) => {
  const alias = participantJoinAlias(sql);
  return {
    id: 'b1',
    user_id: PARTICIPANT.id,
    session_id: 's1',
    status: 'booked',
    gcal_event_id: null,
    opportunity_id: 'opp-1',
    owner_user_id: OWNER.id,
    opportunity_title: 'A study',
    owner_name: OWNER.name,
    owner_email: OWNER.email,
    end_time: END,
    ...(/\bs\.start_time\b/.test(executable(sql)) ? { start_time: START } : {}),
    ...(alias
      ? {
        ...(selectsAs(sql, alias, 'name', 'participant_name') ? { participant_name: PARTICIPANT.name } : {}),
        ...(selectsAs(sql, alias, 'email', 'participant_email') ? { participant_email: PARTICIPANT.email } : {}),
      }
      : {}),
  };
};

/** `preferencesFail` drives the catch-branch copy of the owner notification. */
const arrange = ({ preferencesFail = false } = {}) => {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('FROM bookings b')) {
      return { rows: [bookingRow(text)] };
    }
    if (text.includes('notification_preferences')) {
      if (preferencesFail) throw new Error('preferences unavailable');
      return { rows: [] };
    }
    return { rows: [] };
  });
};

const makeClient = () => ({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn() });

/**
 * Who received the message built from a given template.
 *
 * Paired rather than taken from the recipient list alone, because the handler
 * sends TWO messages and the owner is a legitimate recipient of one of them.
 * "The cancellation did not go to the caller" is only meaningful about the
 * cancellation notice specifically - asserting on recipients in aggregate
 * cannot express it, and an earlier draft of this file got that wrong and
 * failed against a correct handler.
 */
const recipientsOf = (subject: string) =>
  mockSendEmail.mock.calls
    .filter((call: unknown[]) => (call[1] as { subject?: string })?.subject === subject)
    .map((call: unknown[]) => call[0]);

describe('POST /api/bookings/:id/cancel notifies the participant', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockConnect.mockResolvedValue(makeClient() as never);
    // Distinguishable objects, so an assertion cannot pass by both templates
    // being the same value.
    mockCancellationTemplate.mockReturnValue({ subject: 'cancellation', html: '', text: '' });
    mockAdminTemplate.mockReturnValue({ subject: 'admin notice', html: '', text: '' });
    // `sendEmail` RESOLVES to `{ success, messageId?, error? }` and never
    // throws - it catches internally. A bare `jest.fn()` resolves to undefined,
    // which is not that contract, and the handler now reads `.success`. Left
    // under-specified it threw a TypeError into the surrounding catch and the
    // OWNER'S notification silently stopped being sent, in the test only. Same
    // lesson as the SQL oracle above: model the real contract or the mock
    // becomes the thing under test.
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'm-1' } as never);
    arrange();
  });

  describe('when the owner cancels somebody else out of a session', () => {
    const cancel = () =>
      request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

    it('sends the cancellation to the participant and not to the caller', async () => {
      await cancel();

      // Exactly one cancellation notice, and it goes to the participant. The
      // length assertion is the half that catches the pre-fix behaviour of
      // mailing the caller: before the fix this arm found one message, and it
      // was addressed to Olive.
      expect(recipientsOf('cancellation')).toEqual([
        { email: PARTICIPANT.email, name: PARTICIPANT.name },
      ]);
    });

    it('names the participant as the participant and the caller as who cancelled', async () => {
      await cancel();

      // The template has always taken these separately; both arguments were
      // `req.user!.name`, which collapsed the two into one name.
      expect(mockCancellationTemplate).toHaveBeenCalledWith(
        'A study',
        PARTICIPANT.name,
        START,
        END,
        OWNER.name
      );
    });

    it("tells the owner who booked, not who pressed cancel", async () => {
      await cancel();

      expect(mockAdminTemplate).toHaveBeenCalledWith(
        'A study',
        PARTICIPANT.name,
        PARTICIPANT.email,
        START,
        END,
        'cancelled'
      );
      // The owner's copy still reaches the owner - the recipient was never the
      // broken half of this one, and a fix that redirected it would be a
      // regression this file has to be able to see.
      expect(recipientsOf('admin notice')).toEqual([{ email: OWNER.email, name: OWNER.name }]);
    });

    it('gives the real session window rather than the end time twice', async () => {
      // A second defect in the same block: both arguments were
      // `booking.end_time`, so the notice read "15:00 - 15:00". It went
      // unnoticed because the only person receiving it already knew the time.
      await cancel();

      const [, , start, end] = mockCancellationTemplate.mock.calls[0] as unknown[];
      expect(start).toEqual(START);
      expect(end).toEqual(END);
      expect(start).not.toEqual(end);
    });
  });

  describe('when a superadmin who owns the opportunity cancels', () => {
    it('still addresses the participant', async () => {
      await request(listening(appAs('superadmin', OWNER))).post(PATH).expect(200);

      expect(recipientsOf('cancellation')).toEqual([
        { email: PARTICIPANT.email, name: PARTICIPANT.name },
      ]);
    });
  });

  describe('when the participant cancels their own booking', () => {
    it('addresses them and names them as the canceller', async () => {
      // The path that hid the defect: with `req.user` on both sides this arm
      // passed before the fix and must keep passing after it.
      await request(listening(appAs('employee', PARTICIPANT))).post(PATH).expect(200);

      expect(recipientsOf('cancellation')).toEqual([
        { email: PARTICIPANT.email, name: PARTICIPANT.name },
      ]);
      expect(mockCancellationTemplate).toHaveBeenCalledWith(
        'A study',
        PARTICIPANT.name,
        START,
        END,
        PARTICIPANT.name
      );
    });

    // THE ONLY ARM WHERE THE CALLER IS NOT THE OWNER, which is what makes it
    // the only arm that can see the owner's recipient at all.
    //
    // A security gate proved that: every other `recipientsOf('admin notice')`
    // assertion runs as the owner, and the fixture's owner_name/owner_email are
    // the caller's own values, so the assertion is an identity on its own
    // fixture. Redirecting the owner's copy to `req.user` at BOTH call sites
    // survived all 973 tests - the exact req.user-versus-loaded-row confusion
    // this whole commit exists to fix, left unpinned on the sibling call. An
    // earlier draft of this file claimed in a comment that it would catch it.
    it("sends the owner's copy to the owner, who here is not the caller", async () => {
      await request(listening(appAs('employee', PARTICIPANT))).post(PATH).expect(200);

      expect(recipientsOf('admin notice')).toEqual([{ email: OWNER.email, name: OWNER.name }]);
    });
  });

  describe('when the notification-preferences read fails', () => {
    it('still names the participant in the fallback copy to the owner', async () => {
      // The handler has TWO `getAdminNotificationTemplate` call sites and the
      // second is inside `catch (prefError)`. Fixing one and not the other
      // would leave a copy of the defect on a path nothing else reaches.
      arrange({ preferencesFail: true });

      await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

      expect(mockAdminTemplate).toHaveBeenCalledWith(
        'A study',
        PARTICIPANT.name,
        PARTICIPANT.email,
        START,
        END,
        'cancelled'
      );
      expect(recipientsOf('admin notice')).toEqual([{ email: OWNER.email, name: OWNER.name }]);
    });
  });

  describe('the statement the recipients depend on', () => {
    const loadStatement = () =>
      mockQuery.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .find((sql) => sql.includes('FROM bookings b')) as string;

    it('joins the participant and selects the columns the email block reads', async () => {
      // Stated explicitly as well as modelled by the fixture, so that removing
      // the join fails HERE with a legible name rather than only as six
      // "expected pat@example.com, received undefined" further up.
      await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

      const load = loadStatement();
      const alias = participantJoinAlias(load);

      expect(alias).toBeDefined();
      expect(selectsAs(load, alias as string, 'name', 'participant_name')).toBe(true);
      expect(selectsAs(load, alias as string, 'email', 'participant_email')).toBe(true);
      expect(executable(load)).toMatch(/\bs\.start_time\b/);
      // The control: the OWNER join is still there and is a different join.
      // Without this, a rewrite that repointed the existing join at the
      // participant would satisfy everything above while breaking the owner's
      // copy - and `alias` would happily be `u`.
      expect(executable(load)).toMatch(
        /(^|\n)\s*JOIN\s+users\s+(\w+)\s+ON\s+o\.owner_user_id\s*=\s*\2\.id/i
      );
      expect(alias).not.toBe('u');
    });

    it('joins the participant with an INNER join, not a LEFT one', async () => {
      // Asserted separately from the oracle above, which accepts either: a LEFT
      // JOIN brings the same columns into scope, so the fixture cannot tell
      // them apart and should not pretend to.
      //
      // The choice is deliberate and the handler comment reasons about it -
      // `bookings.user_id` is NOT NULL and cascades on user delete, so an inner
      // join cannot drop a row that would otherwise have been found, and a LEFT
      // JOIN would only add a null branch that cannot occur. Pinned so that
      // "widen it to LEFT, just in case" is a decision rather than a reflex.
      await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

      expect(executable(loadStatement())).not.toMatch(/LEFT\s+(OUTER\s+)?JOIN\s+users/i);
    });
  });

  // THE CONTROL FOR EVERY ASSERTION IN THIS FILE. `sendEmail` is mocked and the
  // whole email block sits inside `try`/`catch`, so a handler that threw before
  // sending anything would satisfy every `not.toContainEqual` above and pin
  // nothing at all.
  it('sends exactly two messages: one to the participant, one to the owner', async () => {
    await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockCancellationTemplate).toHaveBeenCalledTimes(1);
    expect(mockAdminTemplate).toHaveBeenCalledTimes(1);
  });

  // THE DELIVERY FAILURE PATH. `sendEmail` returns `{ success: false }` rather
  // than throwing, so before this commit a failed cancellation was invisible:
  // the surrounding try/catch never fired and the handler answered
  // "Booking cancelled successfully" with nothing logged. Survivable while the
  // mail went to the person pressing the button, who could see it had not
  // arrived. Not survivable now that the reader is somebody not in the room.
  it('records a failed cancellation, and still notifies the owner', async () => {
    mockSendEmail.mockResolvedValueOnce({ success: false, error: 'smtp refused' } as never);

    await request(listening(appAs('researcher_admin', OWNER))).post(PATH).expect(200);

    expect(mockLogError).toHaveBeenCalledWith(
      'Participant cancellation email failed',
      expect.objectContaining({ error: 'smtp refused' })
    );
    // The failure must not swallow the owner's copy. Reading the result is a
    // log, not a throw, and this arm is what stops a future `throw` there from
    // quietly taking the second message with it.
    expect(recipientsOf('admin notice')).toEqual([{ email: OWNER.email, name: OWNER.name }]);
  });

  it('refuses an admin who owns nothing, and sends no mail at all', async () => {
    // The ownership gate is pinned in bookings.cancel-ownership.test.ts; what
    // this arm adds is that a REFUSED cancellation does not notify anyone -
    // otherwise the fix would have handed an unentitled caller a way to mail a
    // colleague's participant.
    await request(listening(appAs('researcher_admin', OTHER_ADMIN))).post(PATH).expect(403);

    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
