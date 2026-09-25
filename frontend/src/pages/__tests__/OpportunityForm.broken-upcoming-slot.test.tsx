import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, getSessions, updateOpportunity } from '../../api/client';
import { PUBLISH_PROBLEM_MESSAGES } from '@shared/firsthand/publish-readiness';

/**
 * cto/AdaptaLabs#164: the Review side of `OpportunityForm.tsx`.
 *
 * `OpportunityForm.review.test.tsx` and `OpportunityForm.share-link.test.tsx`
 * already cover the SLOTLESS case (a published test/interview with zero
 * sessions) and the general shape of `shareLinkStartable`. This file is
 * scoped to the #164 differential specifically: a study that HAS a session,
 * but every one of them has already ended - `sessionCount > 0` alone reads
 * this as fine, and `hasUpcomingSlot(sessions, now)` does not. Every session
 * fixture below is built relative to the pinned clock, never a literal date,
 * so nothing here can silently start passing (or failing) as the calendar
 * moves on.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

// Not mocked to null: Review's own "no forward control on Session Management"
// case is not what this file is about, and a real onContinue keeps the strip
// navigable the same way `OpportunityForm.share-link.test.tsx` relies on.
vi.mock('../../components/AdminSessionManager', () => ({
  default: ({
    onContinue,
    onContinueLabel
  }: {
    onContinue?: () => void;
    onContinueLabel?: string;
  }) => (
    <div>
      <span>stub: session management</span>
      {onContinue && (
        <button type="button" onClick={onContinue}>
          Continue: {onContinueLabel}
        </button>
      )}
    </div>
  )
}));

vi.mock('../../api/client', () => ({
  getAiDraftingAvailable: vi.fn().mockResolvedValue(false),
  draftOpportunityFromBrief: vi.fn(),
  createOpportunity: vi.fn().mockResolvedValue({ id: 'opp-new' }),
  updateOpportunity: vi.fn().mockResolvedValue({ id: 'opp-1' }),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([]),
  createSessions: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/firsthand-studies', () => ({
  getFirstHandStudy: vi.fn()
}));

const renderEdit = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
      <Routes>
        <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

const strip = () =>
  within(screen.getByRole('navigation', { name: 'Form steps' })).getAllByRole('button');

/** Jump straight to Review, the way `OpportunityForm.share-link.test.tsx` does
 * for a study whose Session Management step refuses to advance via Continue. */
const goToReview = async () => {
  await screen.findByRole('navigation', { name: 'Form steps' });
  fireEvent.click(strip()[strip().length - 1]);
};

const currentStepName = () =>
  strip()
    .find((step) => step.getAttribute('aria-current') === 'step')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim() ?? '(no current step)';

const sessionStepText = () =>
  strip()
    .find((step) => /Session Management/.test(step.textContent ?? ''))
    ?.textContent?.replace(/\s+/g, ' ')
    .trim() ?? '(Session Management step not found)';

const commitControl = () => screen.queryByRole('button', { name: 'Save changes' });

/** The `<dd>` for one Review row, found through its `<dt>` - same helper as
 * `OpportunityForm.review.test.tsx`'s `valueFor`. */
const valueFor = (label: string): HTMLElement => {
  const term = within(screen.getByTestId('review-step')).getByText(label, { selector: 'dt' });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement) || value.tagName !== 'DD') {
    throw new Error(`No <dd> follows the <dt> for "${label}"`);
  }
  return value;
};

const OPPORTUNITY = (over: Record<string, unknown> = {}) => ({
  id: 'opp-1',
  type: 'test',
  title: 'A study with a long enough title',
  purpose_one_liner: 'A purpose long enough to pass validation',
  description_optional: '',
  product_optional: '',
  status: 'draft',
  default_duration_minutes: 30,
  meeting_location_optional: 'Zoom',
  participant_type_required: 'any',
  can_edit: true,
  ...over
});

/**
 * Every session fixture is built off ONE pinned instant, `NOW`, rather than a
 * literal calendar date - the exact trap the existing suite's own comments
 * warn about (`OpportunityForm.review.test.tsx`'s `FUTURE_SESSION_TIMES`,
 * `OpportunityForm.stepper.test.tsx`'s `STUB_SESSION_TIME`): a fixed future
 * year quietly becomes "already ended" once the real calendar catches up
 * with it, which would flip these proofs' meaning without anyone touching
 * this file. `vi.setSystemTime` below pins `Date` (and only `Date` -
 * `toFake: ['Date']`, matching `Admin.row-actions-filters.test.tsx`) to this
 * exact instant for the lifetime of each test.
 */
const NOW = new Date('2026-09-25T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const sessionAt = (
  id: string,
  endOffsetMs: number,
  over: Record<string, unknown> = {}
) => ({
  id,
  opportunity_id: 'opp-1',
  start_time: new Date(NOW.getTime() + endOffsetMs - 30 * 60 * 1000).toISOString(),
  end_time: new Date(NOW.getTime() + endOffsetMs).toISOString(),
  capacity: 1,
  booked_count: 0,
  remaining: 1,
  location_or_meet_link_optional: '',
  ...over
});

/** Ended a day ago - the exact shape #164 is about: a slot that EXISTS but
 * cannot be booked. */
const endedSession = (id: string) => sessionAt(id, -DAY_MS);

/** Ends at exactly `NOW` - the boundary. `end_time > now`, strictly, so this
 * is not upcoming either. */
const boundarySession = (id: string) => sessionAt(id, 0);

/** A day from now, and FULL - fullness is a different question from #164's. */
const fullFutureSession = (id: string) =>
  sessionAt(id, DAY_MS, { capacity: 1, booked_count: 1, remaining: 0 });

/** A day from now, with room - the control used where the test needs "a slot
 * exists and is bookable" to isolate a DIFFERENT gate (the venue). */
const upcomingSession = (id: string) => sessionAt(id, DAY_MS);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('#164 on Review: a PUBLISHED test/interview whose only slot has ended', () => {
  it.each(['test', 'interview'])(
    'names the server\'s own wording, flags Session Management and Time slots, and blocks Save (%s)',
    async (type) => {
      vi.mocked(getOpportunity).mockResolvedValue(
        OPPORTUNITY({ type, status: 'published' }) as never
      );
      vi.mocked(getSessions).mockResolvedValue([endedSession('sess-1')] as never);
      renderEdit();
      await goToReview();

      expect(currentStepName()).toMatch(/Review/);

      // The banner names the SAME string the server's own publish gate
      // throws - imported, not restated, so the two cannot drift apart.
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(PUBLISH_PROBLEM_MESSAGES.bookable_slot_required);

      // The stepper's own verdict on the step that owns the slots.
      expect(sessionStepText()).toMatch(/Needs attention/i);
      expect(sessionStepText()).not.toMatch(/Completed/i);

      // The Time slots review row itself, flagged the same way every other
      // missing value on this screen is: never colour alone.
      const timeSlots = valueFor('Time slots');
      expect(timeSlots).toHaveClass('validation-error');
      expect(timeSlots.querySelector('svg')).not.toBeNull();
      expect(timeSlots).toHaveTextContent(/upcoming slot/i);

      // And Save is actually refused, client-side, before any request -
      // not merely warned about. `commitControl`'s click calls the async
      // `handleSubmit`, which awaits any in-flight autosave before it does
      // anything else - so a synchronous assertion right here would still
      // pass on a broken Save check, because nothing has run yet either way.
      // Wait for the refusal's own visible effect - the error summary a
      // refused Save always opens - before checking the request never went
      // out.
      fireEvent.click(commitControl() as HTMLElement);
      await screen.findByText(/There is a problem|There are \d+ problems/);
      expect(vi.mocked(updateOpportunity)).not.toHaveBeenCalled();
    }
  );

  it('previews the same problem on a DRAFT, but does not block Save (row 4 parity)', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({ type: 'test', status: 'draft' }) as never
    );
    vi.mocked(getSessions).mockResolvedValue([endedSession('sess-1')] as never);
    renderEdit();
    await goToReview();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(PUBLISH_PROBLEM_MESSAGES.bookable_slot_required);

    fireEvent.click(commitControl() as HTMLElement);
    await waitFor(() => expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(1));
  });

  it('is not a problem anywhere when the only upcoming slot is FULL (control: fullness is a different question)', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({ type: 'test', status: 'published' }) as never
    );
    vi.mocked(getSessions).mockResolvedValue([fullFutureSession('sess-1')] as never);
    renderEdit();
    await goToReview();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sessionStepText()).not.toMatch(/Needs attention/i);

    const timeSlots = valueFor('Time slots');
    expect(timeSlots).not.toHaveClass('validation-error');
    expect(timeSlots.querySelector('svg')).toBeNull();

    fireEvent.click(commitControl() as HTMLElement);
    await waitFor(() => expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(1));
  });

  it('a slot ending exactly at now is not upcoming: strictly greater than, not greater-or-equal (boundary)', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({ type: 'test', status: 'published' }) as never
    );
    vi.mocked(getSessions).mockResolvedValue([boundarySession('sess-1')] as never);
    renderEdit();
    await goToReview();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(PUBLISH_PROBLEM_MESSAGES.bookable_slot_required);

    // Same wait as the row above - the click runs the same async
    // `handleSubmit`, so this assertion needs to wait on its visible effect
    // too rather than checking synchronously.
    fireEvent.click(commitControl() as HTMLElement);
    await screen.findByText(/There is a problem|There are \d+ problems/);
    expect(vi.mocked(updateOpportunity)).not.toHaveBeenCalled();
  });
});

/**
 * cto/AdaptaLabs#164: the stepper's live verdict must not go stale while
 * Review sits open. `liveErrorSteps` is deliberately NOT memoised
 * (`OpportunityForm.tsx` ~2578) - it used to be keyed on
 * `[computeValidationErrors]`, whose own dependencies (~2513) are `formData`,
 * `sessions` and a few other form fields, never the clock. So a memoised
 * version kept its answer from the render that last touched one of those,
 * however long Review went on re-rendering for some OTHER reason (a step
 * change) in the meantime - the exact gap between "the slot ended" and "the
 * chip says so" this test pins.
 */
describe('#164: the stepper does not go stale while Review sits open', () => {
  it('a slot that ends while Review is open reads Needs attention after stepping away and back, with no edit', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({ type: 'test', status: 'published' }) as never
    );
    // Ends an hour from NOW - upcoming at the moment Review is opened.
    vi.mocked(getSessions).mockResolvedValue([sessionAt('sess-1', HOUR_MS)] as never);
    renderEdit();
    await goToReview();

    // Baseline: the slot has not ended yet, so the step reads Completed -
    // without this the assertion below could not tell "went stale" from
    // "was always wrong".
    expect(sessionStepText()).toMatch(/Completed/i);
    expect(sessionStepText()).not.toMatch(/Needs attention/i);

    // The clock moves two hours - the slot ended an hour ago now - but
    // nothing on the page is touched: no field edited, no session changed.
    vi.setSystemTime(new Date(NOW.getTime() + 2 * HOUR_MS));

    // Step away, and back, without editing anything. The state change is
    // the stepper's OWN (`activeTab`), not a change to `formData` or
    // `sessions`, so only a live (non-memoised) read of the clock can
    // notice.
    fireEvent.click(strip()[0]);
    fireEvent.click(strip()[strip().length - 1]);
    expect(currentStepName()).toMatch(/Review/);

    expect(sessionStepText()).toMatch(/Needs attention/i);
    expect(sessionStepText()).not.toMatch(/Completed/i);
  });
});

/**
 * cto/AdaptaLabs#164: the share block's type-specific "Add an upcoming
 * session before sharing." must only show when the missing slot is actually
 * among the reasons the study cannot start - not merely because the type is
 * test/interview. `ShareOpportunityLink.tsx` derives the reason from the
 * publish problem codes rather than branching on type alone.
 *
 * The "venue only" case has a venue-specific reason of its own ("Add a
 * meeting location before sharing.") rather than falling through to the
 * generic sentence, since venue is one of the two things this block can
 * actually name. The test below pins that copy; its intent - the slot is not
 * blamed when the slot is not the reason - is what the describe title says.
 */
describe('#164 share block: names the slot only when the slot is actually the reason', () => {
  it('says "upcoming session" when the slot is why it cannot start', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({ type: 'test', status: 'published', meeting_location_optional: 'Zoom' }) as never
    );
    vi.mocked(getSessions).mockResolvedValue([endedSession('sess-1')] as never);
    renderEdit();
    await goToReview();

    expect(
      screen.getByText(/Add an upcoming session before sharing\./i)
    ).toBeInTheDocument();
  });

  it('does NOT blame the slot when only the venue is missing, a slot exists and is upcoming', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({ type: 'test', status: 'published', meeting_location_optional: '' }) as never
    );
    vi.mocked(getSessions).mockResolvedValue([upcomingSession('sess-1')] as never);
    renderEdit();
    await goToReview();

    // The banner names the real reason (venue), not the slot.
    expect(screen.getByRole('alert')).toHaveTextContent(
      PUBLISH_PROBLEM_MESSAGES.meeting_location_required
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      PUBLISH_PROBLEM_MESSAGES.bookable_slot_required
    );

    // And the share block's copy must not say the slot is the problem either
    // - it has an honest venue-specific reason instead of the generic
    // sentence, since the slot itself is fine here.
    expect(
      screen.queryByText(/Add an upcoming session before sharing\./i)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Add a meeting location before sharing\./i)
    ).toBeInTheDocument();
  });
});

/**
 * cto/AdaptaLabs#164 venue parity: a published live session or interview
 * with an upcoming slot but no venue reads "Broken" on the table and
 * unshareable on Review - the slot and the venue are independent
 * requirements. This describe is the Review half of that parity proof (see
 * `OpportunityDetail.broken-upcoming-slot.test.tsx` for the detail-page
 * half).
 */
describe('#164 venue parity: Review names a missing venue same as a missing slot', () => {
  it('an upcoming slot with no venue shows no share link and "Add a meeting location before sharing."', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({ type: 'interview', status: 'published', meeting_location_optional: '' }) as never
    );
    vi.mocked(getSessions).mockResolvedValue([upcomingSession('sess-1')] as never);
    renderEdit();
    await goToReview();

    expect(screen.getByRole('alert')).toHaveTextContent(
      PUBLISH_PROBLEM_MESSAGES.meeting_location_required
    );

    expect(
      screen.queryByText(`${window.location.origin}/opportunities/opp-1`)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Add a meeting location before sharing\./i)
    ).toBeInTheDocument();
  });

  it('names BOTH the slot and the venue in one sentence when neither is there', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({ type: 'test', status: 'published', meeting_location_optional: '' }) as never
    );
    vi.mocked(getSessions).mockResolvedValue([]);
    renderEdit();
    await goToReview();

    expect(
      screen.queryByText(`${window.location.origin}/opportunities/opp-1`)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Add an upcoming session and a meeting location before sharing\./i)
    ).toBeInTheDocument();
  });
});
