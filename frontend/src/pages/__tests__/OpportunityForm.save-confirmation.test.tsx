import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, getSessions, updateOpportunity } from '../../api/client';
import { setStatus as reviewSetStatus } from './helpers/review-status';

/**
 * #109: a save that gave no acknowledgement read as a dead end.
 *
 * `StepActions.test.tsx` covers what the row does with `justSaved` once it
 * has it. This file covers where OpportunityForm gets that value from: the
 * literal 1500ms (published) / 3000ms (draft) windows already in the source
 * (the `successTimerRef` timeout, `isDraft ? 3000 : 1500`), a save that
 * fails, a save that overlaps a later edit, and the timer's lifetime - a
 * second save restarts it and unmounting clears it.
 *
 * The windows are asserted as LITERALS here, not derived from an import - a
 * test that reads the constant back from the source cannot see the source
 * change.
 *
 * Driven from Review's terminal control ("Save changes"), not the per-step
 * "Save Changes" shortcut. The shortcut only renders while
 * `isEdit && hasChanges()` is true - and a successful save re-reads the
 * opportunity and refreshes the baseline `hasChanges()` compares against, so
 * the shortcut disappears in the very same update that would show "Saved" on
 * it. Review's control carries no such condition, which is what makes it the
 * one place the confirmation is actually observable start to finish.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn().mockResolvedValue({ id: 'opp-new' }),
  updateOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/firsthand-studies', () => ({
  getFirstHandStudy: vi.fn()
}));

const OPPORTUNITY = (over: Record<string, unknown> = {}) => ({
  id: 'opp-1',
  type: 'poll',
  title: 'A poll the author already wrote',
  purpose_one_liner: 'A purpose long enough to pass validation',
  description_optional: '',
  product_optional: '',
  status: 'draft',
  default_duration_minutes: 30,
  external_link_optional: 'https://example.com/poll',
  participant_type_required: 'any',
  can_edit: true,
  ...over
});

const renderEdit = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
      <Routes>
        <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

/** Walk forward to Review, whatever the shape's step count. */
const walkToReview = () => {
  for (let guard = 0; guard <= 6; guard += 1) {
    const forward = screen.queryByRole('button', { name: /^Continue: /i });
    if (!forward) return;
    fireEvent.click(forward);
  }
  throw new Error('walkToReview never reached a step with no forward control');
};

/**
 * Review's terminal control, found by a stable structural class rather than
 * its name OR its colour - the name is the whole point under test
 * ("Save changes" / "Saved" / "Updating...") and D9 made the colour a moving
 * target too (btn-success -> btn-primary, "one commit colour"). StepActions
 * gives this control `.step-actions__submit` for exactly this reason - it is
 * never applied to Previous, Continue or the per-step Save Changes shortcut.
 */
const commitButton = () => document.querySelector('.step-actions__submit') as HTMLButtonElement;

/**
 * Title lives on the Basic Info step now, split out of the Study type
 * landing step (D1/D3 reshape), so reaching it - to prove hydration, and to
 * edit it - means walking the strip there first.
 */
const goToBasicInfo = async () => {
  fireEvent.click(
    within(await screen.findByRole('navigation', { name: 'Form steps' })).getAllByRole(
      'button'
    )[1]
  );
  return screen.findByDisplayValue('A poll the author already wrote');
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessions).mockResolvedValue([] as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OpportunityForm - the Saved confirmation is pinned to the exact window (#109)', () => {
  it('reads Saved for 3000ms on a draft, and reverts the instant it elapses', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY({ status: 'draft' }) as never);
    vi.mocked(updateOpportunity).mockResolvedValue(
      OPPORTUNITY({ status: 'draft', title: 'Renamed' }) as never
    );

    renderEdit();
    await goToBasicInfo();
    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Renamed' } });
    walkToReview();

    vi.useFakeTimers();
    try {
      fireEvent.click(commitButton());

      // Flushes the update, the re-read (loadOpportunity) and the state
      // update that arms the confirmation - all mocked, so this is well
      // inside the 3000ms window whatever it turns out to be.
      await vi.advanceTimersByTimeAsync(50);
      expect(commitButton()).toHaveTextContent('Saved');

      await vi.advanceTimersByTimeAsync(2949); // total elapsed since arming: 2999ms
      expect(commitButton()).toHaveTextContent('Saved');

      await vi.advanceTimersByTimeAsync(1); // total elapsed: 3000ms - the literal itself
      expect(commitButton()).not.toHaveTextContent('Saved');
      expect(commitButton()).toHaveTextContent('Save changes');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads Saved for only 1500ms once published, half the draft window', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY({ status: 'published' }) as never);
    vi.mocked(updateOpportunity).mockResolvedValue(
      OPPORTUNITY({ status: 'published', title: 'Renamed' }) as never
    );

    renderEdit();
    await goToBasicInfo();
    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Renamed' } });
    walkToReview();

    vi.useFakeTimers();
    try {
      fireEvent.click(commitButton());

      await vi.advanceTimersByTimeAsync(50);
      expect(commitButton()).toHaveTextContent('Saved');

      await vi.advanceTimersByTimeAsync(1449); // total elapsed since arming: 1499ms
      expect(commitButton()).toHaveTextContent('Saved');

      await vi.advanceTimersByTimeAsync(1); // total elapsed: 1500ms - the literal itself
      expect(commitButton()).not.toHaveTextContent('Saved');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OpportunityForm - editing during the Saved window clears it immediately (#109)', () => {
  it('drops "Saved" the instant a field changes, long before the 3000ms draft timer elapses', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY({ status: 'draft' }) as never);
    vi.mocked(updateOpportunity).mockResolvedValue(
      OPPORTUNITY({ status: 'draft', title: 'Renamed' }) as never
    );

    renderEdit();
    await goToBasicInfo();
    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Renamed' } });
    walkToReview();

    vi.useFakeTimers();
    try {
      fireEvent.click(commitButton());

      await vi.advanceTimersByTimeAsync(50);
      expect(commitButton()).toHaveTextContent('Saved');

      // A second edit, made on Review's own control (#111) so nothing needs
      // navigating away and back to reach it. Only 550ms have elapsed since
      // the confirmation armed - nowhere near the 3000ms literal the draft
      // window uses - so if this clears it, the edit did it, not the timer.
      reviewSetStatus('published');

      expect(commitButton()).not.toHaveTextContent('Saved');
      expect(commitButton()).toHaveTextContent('Save changes');

      // Advancing all the way past the 3000ms literal changes nothing further
      // - the confirmation was already cleared by the edit, not merely hidden
      // until the timer caught up.
      await vi.advanceTimersByTimeAsync(3000);
      expect(commitButton()).not.toHaveTextContent('Saved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops "Saved" the instant a field changes, long before the 1500ms published timer elapses', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY({ status: 'published' }) as never);
    vi.mocked(updateOpportunity).mockResolvedValue(
      OPPORTUNITY({ status: 'published', title: 'Renamed' }) as never
    );

    renderEdit();
    await goToBasicInfo();
    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Renamed' } });
    walkToReview();

    vi.useFakeTimers();
    try {
      fireEvent.click(commitButton());

      await vi.advanceTimersByTimeAsync(50);
      expect(commitButton()).toHaveTextContent('Saved');

      // Only 300ms elapsed since arming - well inside the 1500ms literal the
      // published window uses.
      await vi.advanceTimersByTimeAsync(250);
      expect(commitButton()).toHaveTextContent('Saved');

      reviewSetStatus('draft');

      expect(commitButton()).not.toHaveTextContent('Saved');
      expect(commitButton()).toHaveTextContent('Save changes');

      await vi.advanceTimersByTimeAsync(1500);
      expect(commitButton()).not.toHaveTextContent('Saved');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OpportunityForm - a save that fails never says Saved', () => {
  it('leaves the ordinary label on a rejected update', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY() as never);
    vi.mocked(updateOpportunity).mockRejectedValueOnce(new Error('500 from the server'));

    renderEdit();
    await goToBasicInfo();
    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Renamed' } });
    walkToReview();

    fireEvent.click(commitButton());
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));

    // Failed, so there is nothing to confirm - the control must still read
    // its ordinary label, never "Saved".
    await waitFor(() => expect(commitButton()).toHaveTextContent('Save changes'));
    expect(commitButton()).not.toHaveTextContent('Saved');
  });
});

describe('OpportunityForm - a save that overlaps a later edit', () => {
  it('sends only what was on screen when Save was pressed, not a mid-flight edit', async () => {
    // Status is mutated here rather than Title, deliberately: it is the one
    // field Review itself owns (#111), so the mid-flight edit needs no
    // navigation away and back - which would risk the assertion proving
    // something about remounting rather than about the in-flight request.
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY({ status: 'draft' }) as never);

    let resolveUpdate: (value: ReturnType<typeof OPPORTUNITY>) => void = () => {};
    vi.mocked(updateOpportunity).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }) as never
    );

    renderEdit();
    await goToBasicInfo();
    walkToReview();

    fireEvent.click(commitButton());

    // In flight - proven, so the mid-flight edit below is not a race with a
    // save that had already finished.
    expect(commitButton()).toHaveTextContent('Updating...');

    // A second decision, made while the first save is still on the wire and
    // the request already carries `status: 'draft'`.
    reviewSetStatus('published');

    // The server's own account of what it actually stored - still draft,
    // since that is what the in-flight request carried.
    resolveUpdate(OPPORTUNITY({ status: 'draft' }));
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1));

    // The whole point: the payload sent is the snapshot taken when Save was
    // pressed, not the status chosen afterwards.
    expect(vi.mocked(updateOpportunity).mock.calls[0][1]).toEqual(
      expect.objectContaining({ status: 'draft' })
    );

    // And the confirmation still lands on the control the author actually
    // pressed - the overlap does not silently swallow the acknowledgement.
    await waitFor(() => expect(commitButton()).toHaveTextContent('Saved'));
  });
});

describe('OpportunityForm - the Saved confirmation timer dies with the form', () => {
  /*
   * The timer that clears the confirmation used to be fire-and-forget. Leave
   * the page inside its window - or let a test file tear down inside it - and
   * it still fired, calling a state setter on a form that no longer existed.
   * In a full vitest run that surfaced as an unhandled `window is not defined`
   * from this timer after the jsdom environment had gone: every test green,
   * the run exit 1.
   *
   * The control assertion (a timer IS pending while the form is up) is what
   * stops the zero below passing just because nothing was ever armed.
   */
  it.each([
    ['draft', 3000],
    ['published', 1500]
  ])('leaves no timer pending once a %s form unmounts inside its %ims window', async (status, windowMs) => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY({ status }) as never);
    vi.mocked(updateOpportunity).mockResolvedValue(
      OPPORTUNITY({ status, title: 'Renamed' }) as never
    );

    const { unmount } = renderEdit();
    await goToBasicInfo();
    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Renamed' } });
    walkToReview();

    vi.useFakeTimers();
    try {
      const armTimer = vi.spyOn(globalThis, 'setTimeout');
      const clearTimer = vi.spyOn(globalThis, 'clearTimeout');

      fireEvent.click(commitButton());
      await vi.advanceTimersByTimeAsync(50);
      expect(commitButton()).toHaveTextContent('Saved');

      // ATTRIBUTABLE control. `vi.getTimerCount()` is global, so "some timer is
      // pending" is satisfied by any unrelated timer in the tree - a mutation
      // that never armed THIS timer would sail through a bare count, and the
      // zero after unmount would mean nothing. So the control names the banner
      // timer by its own window, and the assertion is that this id was cleared.
      const armed = armTimer.mock.calls
        .map((call, i) => ({ delay: call[1], id: armTimer.mock.results[i].value }))
        .filter((entry) => entry.delay === windowMs);
      expect(armed).toHaveLength(1);

      unmount();

      expect(clearTimer).toHaveBeenCalledWith(armed[0].id);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second save inside the window gets its own full 3000ms, not the remainder of the first', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY({ status: 'draft' }) as never);
    vi.mocked(updateOpportunity).mockResolvedValue(
      OPPORTUNITY({ status: 'draft', title: 'Renamed' }) as never
    );

    renderEdit();
    await goToBasicInfo();
    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Renamed' } });
    walkToReview();

    vi.useFakeTimers();
    try {
      fireEvent.click(commitButton());
      await vi.advanceTimersByTimeAsync(50);
      expect(commitButton()).toHaveTextContent('Saved');

      // An edit re-enables the control (it drops "Saved"), so a second save
      // can land 1000ms into the first one's window.
      await vi.advanceTimersByTimeAsync(950);
      reviewSetStatus('published');
      reviewSetStatus('draft');
      fireEvent.click(commitButton());
      await vi.advanceTimersByTimeAsync(50);
      expect(commitButton()).toHaveTextContent('Saved');
      expect(updateOpportunity).toHaveBeenCalledTimes(2);

      // 3000ms after the FIRST save armed - where its timer would have fired
      // and cut the second confirmation short.
      await vi.advanceTimersByTimeAsync(2000);
      expect(commitButton()).toHaveTextContent('Saved');

      // 3000ms after the second armed.
      await vi.advanceTimersByTimeAsync(1000);
      expect(commitButton()).not.toHaveTextContent('Saved');
    } finally {
      vi.useRealTimers();
    }
  });
});
