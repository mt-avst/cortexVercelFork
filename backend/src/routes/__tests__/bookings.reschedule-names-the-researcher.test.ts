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

jest.mock('../../services/email', () => ({
  __esModule: true,
  default: { sendEmail: jest.fn() },
  EmailService: {
    getBookingConfirmationTemplate: jest.fn(),
    getAdminNotificationTemplate: jest.fn(),
    getBookingCancellationTemplate: jest.fn(),
  },
}));

import bookingsRouter from '../bookings';
import { pool } from '../../config';
import { isDatabaseAvailable } from '../../utils/database';
import { errorHandler } from '../../utils/errorHandler';
import emailService, { EmailService } from '../../services/email';

const mockQuery = pool.query as unknown as jest.Mock;
const mockConnect = pool.connect as unknown as jest.Mock;
const mockIsDatabaseAvailable = isDatabaseAvailable as unknown as jest.Mock;
const mockSendEmail = emailService.sendEmail as unknown as jest.Mock;
const mockConfirmation = EmailService.getBookingConfirmationTemplate as unknown as jest.Mock;

/**
 * THE RESCHEDULE CONFIRMATION NAMED NO RESEARCHER, AND NOTHING COULD SEE IT.
 *
 * `POST /api/bookings/:id/reschedule` passed `targetSession.owner_name` and
 * `targetSession.owner_email` into `getBookingConfirmationTemplate`. Neither
 * column exists: `targetSession` comes from a SELECT over `sessions` joined to
 * `opportunities`, and `sessions` has no owner columns - the string
 * `owner_name` appears nowhere in db/migrate.ts. Both arguments were
 * `undefined` at runtime.
 *
 * The handler had ALREADY resolved the right values, forty lines above, into
 * `targetOwnerName` / `targetOwnerEmail` - and passed them to the calendar
 * attendee list and never to the email.
 *
 * IT DEGRADED SILENTLY, which is why it survived. The template guards with
 * `${ownerName ? ... : ''}` and `generateICSFile` guards `organizerEmail`, so
 * nothing rendered "undefined" - a participant who rescheduled simply got a
 * confirmation with no researcher on it and a calendar file with no organiser.
 *
 * Found by a review gate reading the handlers BESIDE the cancellation fix, and
 * it is the same defect class: an email argument sourced from a row that never
 * carried it. Proved inert by mutation before the fix - replacing both
 * arguments with a literal `undefined` changed nothing across all 973 tests.
 *
 * This file is the arm that makes the fix fail by name if it is reverted.
 */
const PARTICIPANT = { id: 'participant-1', name: 'Pat Participant', email: 'pat@example.com' };
const OWNER = { id: 'admin-1', name: 'Olive Owner', email: 'olive@example.com' };

const PATH = '/api/bookings/b1/reschedule';
const START = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const END = new Date(START.getTime() + 60 * 60 * 1000);

const app = () => {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      user: { ...PARTICIPANT, role: 'employee' },
    };
    next();
  });
  a.use('/api/bookings', bookingsRouter);
  a.use(errorHandler);
  return a;
};

/**
 * The transaction client. Both loads happen ON THE CLIENT, inside the
 * transaction; the owner lookup that produces the correct values happens on the
 * POOL afterwards, which is why the two are mocked separately.
 */
const makeClient = () => ({
  query: jest.fn(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('FROM bookings b')) {
      return {
        rows: [{
          id: 'b1',
          user_id: PARTICIPANT.id,
          session_id: 's-old',
          status: 'booked',
          gcal_event_id: null,
          current_opportunity_id: 'opp-1',
          opportunity_title: 'A study',
        }],
      };
    }
    if (text.includes('FROM sessions s')) {
      return {
        rows: [{
          id: 's-new',
          opportunity_id: 'opp-1',
          opportunity_status: 'published',
          opportunity_title: 'A study',
          purpose_one_liner: 'To learn how people book things',
          owner_user_id: OWNER.id,
          start_time: START,
          end_time: END,
          capacity: 5,
          booked_count: 0,
          location_or_meet_link_optional: 'https://meet.example.com/x',
          // DELIBERATELY ABSENT: `owner_name` and `owner_email`. This fixture is
          // the shape `sessions JOIN opportunities` actually returns, and the
          // whole defect was reading two columns that are not in it. Adding
          // them here to be helpful would hand the handler data no database
          // could give it, and this file would stop being able to see the bug.
        }],
      };
    }
    return { rows: [] };
  }),
  release: jest.fn(),
});

describe('POST /api/bookings/:id/reschedule names the researcher', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockIsDatabaseAvailable.mockResolvedValue(true as never);
    mockConnect.mockResolvedValue(makeClient() as never);
    mockSendEmail.mockResolvedValue({ success: true } as never);
    mockConfirmation.mockReturnValue({ subject: 'confirmation', html: '', text: '' });
    // The owner lookup, which runs on the POOL after the commit. This is the
    // only place the researcher's name and address are available at all.
    mockQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('SELECT name, email FROM users')) {
        return { rows: [{ name: OWNER.name, email: OWNER.email }] };
      }
      return { rows: [] };
    });
  });

  it('puts the researcher on the confirmation, not undefined', async () => {
    await request(listening(app()))
      .post(PATH)
      .send({ target_session_id: 's-new' })
      .expect(200);

    expect(mockConfirmation).toHaveBeenCalledWith(
      'A study',
      PARTICIPANT.name,
      START,
      END,
      'https://meet.example.com/x',
      OWNER.name,
      OWNER.email
    );
  });

  it('never passes undefined where the researcher belongs', async () => {
    // Named separately from the equality above because it is the assertion
    // that survives a fixture change. The defect was not a WRONG researcher,
    // it was NO researcher, and the template renders nothing at all for that -
    // so an arm that only checked "not the participant" would have passed
    // against the bug.
    await request(listening(app()))
      .post(PATH)
      .send({ target_session_id: 's-new' })
      .expect(200);

    const [, , , , , ownerName, ownerEmail] = mockConfirmation.mock.calls[0] as unknown[];
    expect(ownerName).toBeDefined();
    expect(ownerEmail).toBeDefined();
  });

  // THE CONTROL. Without it, a handler that threw before reaching the email
  // block would satisfy nothing above but would also report no failure that
  // named this file - and the two arms would simply never run their
  // assertions.
  it('sends the confirmation to the participant', async () => {
    await request(listening(app()))
      .post(PATH)
      .send({ target_session_id: 's-new' })
      .expect(200);

    expect(mockSendEmail).toHaveBeenCalledWith(
      { email: PARTICIPANT.email, name: PARTICIPANT.name },
      { subject: 'confirmation', html: '', text: '' }
    );
  });
});
