import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminSessionManager from '../AdminSessionManager';
import { createSessions } from '../../api/client';
import { navigation } from '../../utils/navigation';

/**
 * The Session Management step, after the commit point moved off it.
 *
 * This file used to test `resolveSaveOutcome`, a pure helper that decided what
 * to do once this component had called its parent back to SAVE the opportunity
 * - chiefly to avoid navigating away announcing a success when the save had
 * returned nothing. C3 deleted that whole path: confirming a time slot is now
 * only confirming a time slot, and the Review step commits, so there is no
 * outcome left to resolve.
 *
 * What replaced it is the behaviour that deletion has to be true for. The step
 * has to be leavable FORWARDS, which it never was while it was terminal, and
 * confirming slots has to stop short of saving or navigating.
 */
vi.mock('../../api/client', () => ({
  // A fresh array per call, matching a real parsed HTTP response: a shared
  // resolved value hands back the same reference every time, which hides the
  // identity churn production actually has.
  getAvailability: vi.fn(async () => ({ available_slots: [] })),
  getMyCalendarEvents: vi.fn(async () => []),
  createSessions: vi.fn().mockResolvedValue([]),
  deleteAllSessions: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../utils/navigation', () => ({
  navigation: { toAdmin: vi.fn() }
}));

/*
 * Typed against the component's own props rather than
 * `Record<string, unknown>` cast to `never`.
 *
 * The cast is what the sibling render test uses, and it works only because
 * that file sits in `tsconfig.test.json`'s exclude backlog - so nothing ever
 * checked that the props it passes exist. This project has already shipped a
 * fixture naming a field the type does not have, which disarmed the very
 * assertion it was written to prove. `Partial<ComponentProps<...>>` makes a
 * misspelled `onContinueLabel` a compile error instead of a silent no-op.
 */
const renderManager = (
  props: Partial<React.ComponentProps<typeof AdminSessionManager>> = {}
) =>
  render(
    <MemoryRouter>
      <AdminSessionManager
        opportunityId="opp-1"
        sessions={[]}
        onSessionsChange={vi.fn()}
        defaultDurationMinutes={30}
        {...props}
      />
    </MemoryRouter>
  );

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/**
 * Put a slot in the selection without driving the calendar.
 *
 * `selectedSlots` is seeded from sessionStorage on mount, under
 * `selectedSlots_{urlId || opportunityId || 'temp'}`. Reaching it this way
 * rather than clicking a cell keeps these tests off the calendar's date window
 * entirely - which depends on today's date, on a weekend filter that is on by
 * default, and on a duration having been chosen. None of that is what this
 * file is about, and a fixture that has to dodge a weekend is a fixture that
 * fails on a Saturday.
 */
const preselectOneSlot = (opportunityId = 'opp-1') => {
  sessionStorage.setItem(
    `selectedSlots_${opportunityId}`,
    JSON.stringify(['2030-01-07T10:00:00.000Z|2030-01-07T10:30:00.000Z'])
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('the forward control names its destination', () => {
  it('says where it is going rather than a bare "Continue"', async () => {
    renderManager({ onContinue: vi.fn(), onContinueLabel: 'Review' });
    await settle();

    /*
     * The same promise the backward control makes. "Continue" alone on four
     * consecutive steps tells the author only that something will happen, and
     * this step in particular used to be the END of the form - so an author
     * who has been here before has to be told it no longer is.
     */
    expect(
      screen.getByRole('button', { name: 'Continue: Review' })
    ).toBeInTheDocument();
  });

  it('moves forward through the callback when it is pressed', async () => {
    const onContinue = vi.fn();
    renderManager({ onContinue, onContinueLabel: 'Review' });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Continue: Review' }));

    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('renders no forward control at all when it was given nowhere to go', async () => {
    renderManager({ onBack: vi.fn(), onBackLabel: 'Content & Details' });
    await settle();

    /*
     * Absent rather than inert. A caller that forgets to wire this should
     * produce a step with no forward control - visibly wrong - rather than a
     * button that looks live and does nothing, which is the failure the whole
     * present-or-absent-pair shape in StepActions exists to refuse.
     */
    expect(
      screen.queryByRole('button', { name: /^Continue/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Previous: Content & Details' })
    ).toBeInTheDocument();
  });

  it('offers BOTH controls when nothing is selected, so the step can still be left forwards', async () => {
    renderManager({
      onBack: vi.fn(),
      onBackLabel: 'Content & Details',
      onContinue: vi.fn(),
      onContinueLabel: 'Review'
    });
    await settle();

    /*
     * The row below the calendar rendered Back and nothing else, because while
     * this step was terminal there was nowhere forward to offer. An author who
     * booked their slots on a previous visit, or who means to come back to
     * them, would have had no way to reach Review at all - the failure is
     * invisible from the selected-slots panel, which is the only other place
     * either control appears.
     */
    expect(
      screen.getByRole('button', { name: 'Previous: Content & Details' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continue: Review' })
    ).toBeInTheDocument();
  });
});

describe('confirming slots is only confirming slots', () => {
  it('offers a control that promises slot confirmation, not an opportunity', async () => {
    preselectOneSlot();
    renderManager({ isTemporary: true, onContinue: vi.fn(), onContinueLabel: 'Review' });
    await settle();

    /*
     * This button said "Create Opportunity" while pressing it did create one.
     * It no longer does, and a control that names an outcome it cannot deliver
     * is worse than one that names nothing: the author presses it, believes
     * the opportunity exists, and leaves.
     */
    expect(
      screen.getByRole('button', { name: 'Confirm selected slots' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Create Opportunity/i })
    ).not.toBeInTheDocument();
  });

  it('navigates nowhere when the slots are confirmed on a new opportunity', async () => {
    preselectOneSlot();
    const onSessionsChange = vi.fn();
    renderManager({
      isTemporary: true,
      sessions: [
        {
          id: 'sess-already-real',
          opportunity_id: 'opp-1',
          start_time: '2030-01-08T09:00:00.000Z',
          end_time: '2030-01-08T09:30:00.000Z',
          capacity: 1,
          booked_count: 0,
          remaining: 1,
          location_or_meet_link_optional: ''
        }
      ] as never,
      onSessionsChange,
      onContinue: vi.fn(),
      onContinueLabel: 'Review'
    });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm selected slots' }));
    await settle();

    /*
     * The regression guard for the whole restructure. This path used to save
     * the opportunity through a parent callback and then navigate to the
     * dashboard, which is what made a test or an interview the only two types
     * whose author never saw a summary of what they were about to create.
     *
     * The slot still has to be CONFIRMED - asserted first, so this cannot pass
     * by the button having stopped working altogether, which would also
     * navigate nowhere.
     */
    expect(onSessionsChange).toHaveBeenCalledTimes(1);
    /*
     * APPENDED to what was already there, not replacing it. A confirm that
     * dropped the existing rows would also "navigate nowhere", and with a
     * single-item fixture the two are indistinguishable.
     */
    const handedUp = onSessionsChange.mock.calls[0][0] as Array<{ id: string }>;
    expect(handedUp).toHaveLength(2);
    expect(handedUp[0].id).toBe('sess-already-real');
    expect(handedUp[1].id).toMatch(/^temp-session-/);
    /*
     * `createSessions` is what the deleted block actually called, so this is
     * the assertion with teeth: `navigation.toAdmin` can no longer be reached
     * by any path, which makes asserting its absence unfalsifiable.
     */
    expect(vi.mocked(createSessions)).not.toHaveBeenCalled();
    expect(vi.mocked(navigation.toAdmin)).not.toHaveBeenCalled();
  });
});
