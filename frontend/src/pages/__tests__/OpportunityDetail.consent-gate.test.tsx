import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { bookSession, getOpportunity } from '../../api/client';
import { MODERATED_CONSENT_TEMPLATE } from '@shared/firsthand/consent-templates';

/**
 * The consent gate at booking (#79 step 1b).
 *
 * The rules, each in both directions:
 *  - an opportunity carrying consent wording books only THROUGH the modal:
 *    clicking a slot shows the wording verbatim and calls nothing yet, and
 *    the grid's await rejects so its optimistic mark unwinds while the
 *    participant reads
 *  - Cancel books nothing, ever
 *  - Accept books with the explicit flag - the only shape the server accepts
 *  - a moderated opportunity with NO wording of its own shows the Cortex-owned
 *    baseline and books only through accepting it (audit row 9) - a live
 *    session never books with no consent shown
 *  - a server-side consent refusal reaches the banner as the server's own
 *    sentence, not a hardcoded guess about which 400 this was
 */

const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const end = new Date(start.getTime() + 60 * 60 * 1000);

const CONSENT_WORDING =
  'This is a live session with a researcher on a video call. The call may be recorded.';

const fixture = (consentText: string | null, type = 'test') => ({
  id: 'opp-1',
  type,
  title: 'Checkout flow walkthrough',
  purpose_one_liner: 'Find out where people stall in the checkout flow',
  status: 'published',
  default_duration_minutes: 60,
  participant_type_required: 'any',
  consent_text: consentText,
  consent_template_id: consentText ? 'custom' : null,
  consent_template_version: null,
  sessions: [
    {
      id: 'sess-1',
      opportunity_id: 'opp-1',
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      capacity: 3,
      remaining: 3,
    },
  ],
});

/** Set by the CalendarGrid stub: what the child saw when it awaited the call. */
let bookOutcome: 'resolved' | 'rejected' | null = null;

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', role: 'employee', name: 'E' },
    loading: false,
    initialAuthCheck: true,
  }),
}));
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false }),
}));

vi.mock('../../components/CalendarGrid', () => ({
  CALENDAR_LEGEND_ITEMS: [],
  default: ({ onBookSession }: { onBookSession: (id: string) => void }) => (
    <button
      type="button"
      onClick={async () => {
        try {
          await onBookSession('sess-1');
          bookOutcome = 'resolved';
        } catch {
          bookOutcome = 'rejected';
        }
      }}
    >
      stub book
    </button>
  ),
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  markOpportunityOpened: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  getMyBookings: vi.fn(async () => ({ upcoming: [], past: [] })),
  getCalendarConnectionStatus: vi.fn(async () => ({ connected: false, connectedAt: null })),
  startRecordedStudySession: vi.fn(),
}));

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/opportunities/opp-1']}>
      <Routes>
        <Route path="/opportunities/:id" element={<OpportunityDetail />} />
      </Routes>
    </MemoryRouter>
  );

let user: ReturnType<typeof userEvent.setup>;

const arrange = (consentText: string | null, type = 'test') => {
  vi.mocked(getOpportunity).mockImplementation(async () => fixture(consentText, type) as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  bookOutcome = null;
  user = userEvent.setup();
});

describe('booking an opportunity that carries consent wording', () => {
  it('shows the wording verbatim, books nothing yet, and unwinds the grid', async () => {
    arrange(CONSENT_WORDING);
    vi.mocked(bookSession).mockResolvedValue({ id: 'booking-1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));

    // The wording itself, not a paraphrase - the participant accepts THIS text.
    expect(await screen.findByText(CONSENT_WORDING)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept and book' })).toBeInTheDocument();
    expect(bookSession).not.toHaveBeenCalled();
    // The grid's optimistic mark unwinds while the participant reads.
    await waitFor(() => expect(bookOutcome).toBe('rejected'));
  });

  it('Cancel closes the gate and books nothing', async () => {
    arrange(CONSENT_WORDING);
    vi.mocked(bookSession).mockResolvedValue({ id: 'booking-1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));
    await screen.findByText(CONSENT_WORDING);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText(CONSENT_WORDING)).not.toBeInTheDocument();
    expect(bookSession).not.toHaveBeenCalled();
  });

  it('Accept books with the explicit flag, the only shape the server accepts', async () => {
    arrange(CONSENT_WORDING);
    vi.mocked(bookSession).mockResolvedValue({ id: 'booking-1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));
    await screen.findByText(CONSENT_WORDING);
    await user.click(screen.getByRole('button', { name: 'Accept and book' }));

    await waitFor(() => {
      expect(bookSession).toHaveBeenCalledWith('sess-1', {
        consentAccepted: true,
        consentTextSeen: CONSENT_WORDING,
      });
    });
    expect(await screen.findByText(/Successfully booked/i)).toBeInTheDocument();
  });

  it("surfaces the server's own refusal sentence on a 400", async () => {
    arrange(CONSENT_WORDING);
    vi.mocked(bookSession).mockRejectedValue({
      response: {
        status: 400,
        data: { error: 'Booking this session requires accepting its consent statement' },
      },
    });

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));
    await screen.findByText(CONSENT_WORDING);
    await user.click(screen.getByRole('button', { name: 'Accept and book' }));

    // The server's sentence, not the hardcoded past-session guess that used to
    // answer for every 400 on this path.
    expect(
      await screen.findByText(/Booking this session requires accepting its consent statement/i)
    ).toBeInTheDocument();
  });
});

describe('booking a moderated opportunity with no wording of its own (audit row 9)', () => {
  it('shows the Cortex baseline and accepts it - a live session never books with no consent', async () => {
    // The bug this fixes: a moderated type with a null consent_text used to
    // book straight through with consentAccepted:false and no modal.
    arrange(null, 'test');
    vi.mocked(bookSession).mockResolvedValue({ id: 'booking-1' } as never);

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Switch to calendar view' }));
    await user.click(await screen.findByRole('button', { name: 'stub book' }));

    // The baseline wording itself, verbatim, before anything is booked.
    expect(await screen.findByText(MODERATED_CONSENT_TEMPLATE.text)).toBeInTheDocument();
    expect(bookSession).not.toHaveBeenCalled();
    await waitFor(() => expect(bookOutcome).toBe('rejected'));

    await user.click(screen.getByRole('button', { name: 'Accept and book' }));
    await waitFor(() => {
      expect(bookSession).toHaveBeenCalledWith('sess-1', {
        consentAccepted: true,
        consentTextSeen: MODERATED_CONSENT_TEMPLATE.text,
      });
    });
  });
});

// The type-scoping - that a non-moderated type resolves to no consent - is a
// pure-function property proven in consent-templates.test.ts (bookingConsentText
// returns '' for survey/poll/question/unmoderated). It is not re-asserted here
// because a non-moderated opportunity does not render the session-booking UI at
// all: every BOOKABLE opportunity is moderated, so the booking path always
// carries consent now.
