import React from 'react';
import { render, waitFor, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, Link, useParams } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, markOpportunityOpened } from '../../api/client';

// cto/AdaptaLabs#168: the opened marker must fire once per study (and per
// signed-in user), not once per component instance. OpportunityDetail can be
// reached from another study's detail page without an unmount in between -
// React Router reuses the element for the same matched Route and only
// `useParams().id` changes - so a->b navigation must mark both a and b, and a
// re-render for the same study must not mark it twice.
const studyA = {
  id: 'opp-a',
  type: 'unmoderated',
  title: 'Study A',
  purpose_one_liner: 'purpose a',
  status: 'published',
  default_duration_minutes: 20,
  participant_type_required: 'any',
  sessions: [],
};
const studyB = {
  id: 'opp-b',
  type: 'unmoderated',
  title: 'Study B',
  purpose_one_liner: 'purpose b',
  status: 'published',
  default_duration_minutes: 20,
  participant_type_required: 'any',
  sessions: [],
};
const fixtures: Record<string, typeof studyA> = { 'opp-a': studyA, 'opp-b': studyB };

let currentUser: { id: string; role: string; name: string } = { id: 'u1', role: 'employee', name: 'E' };
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: currentUser, loading: false }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/CalendarGrid', () => ({
  default: () => null,
  CALENDAR_LEGEND_ITEMS: [],
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(async (id: string) => ({ ...fixtures[id] })),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  markOpportunityOpened: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
  startRecordedStudySession: vi.fn(),
}));

/** A same-instance a->b navigation: both routes match OpportunityDetail on
 * the same Route element, and the Link below is rendered INSIDE it, so
 * clicking it changes only the matched param - the exact shape the real app
 * hits from a related-study link, not a fresh MemoryRouter mount. */
const NextStudyLink = () => {
  const { id } = useParams<{ id: string }>();
  const nextId = id === 'opp-a' ? 'opp-b' : 'opp-a';
  return (
    <Link to={`/opportunities/${nextId}`} data-testid="next-study-link">
      Next study
    </Link>
  );
};

// A FUNCTION, not a shared element constant: passing the literal same React
// element object to `rerender()` a second time lets React bail out of
// re-rendering that subtree entirely (its fast path treats an unchanged
// element reference as "nothing could have changed"), which would silently
// no-op the user-switch test below. A fresh element per call has no such
// shortcut - see the identical fix in Home.new-badge.test.tsx.
const detailTree = () => (
  <MemoryRouter initialEntries={['/opportunities/opp-a']}>
    <Routes>
      <Route
        path="/opportunities/:id"
        element={
          <>
            <NextStudyLink />
            <OpportunityDetail />
          </>
        }
      />
    </Routes>
  </MemoryRouter>
);

const renderDetail = () => render(detailTree());

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: 'u1', role: 'employee', name: 'E' };
});

describe('OpportunityDetail - #168 opened marker, keyed per study id', () => {
  it('marks the second study too after an in-place a->b navigation', async () => {
    renderDetail();
    await waitFor(() => expect(vi.mocked(getOpportunity)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledWith('opp-a');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('next-study-link'));

    await waitFor(() => expect(vi.mocked(getOpportunity)).toHaveBeenCalledTimes(2));

    // The regression: with a boolean ref this stayed at 1, and opp-b's own
    // badge never cleared.
    await waitFor(() => expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(markOpportunityOpened)).toHaveBeenLastCalledWith('opp-b');
  });

  it('marks each leg of an a->b->a navigation once, with no redundant or missing marks', async () => {
    renderDetail();
    await waitFor(() => expect(vi.mocked(getOpportunity)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledTimes(1));

    // Two genuine navigations, not a StrictMode double-invoke of the same
    // effect: each click changes the matched `:id` param (a->b, then b->a),
    // so the per-id ref must recognise both as new and mark both - including
    // the second visit to 'a', which a ref keyed on "have I ever marked this
    // id" rather than "is this the id I most recently marked" would wrongly
    // treat as already done.
    const user = userEvent.setup();
    await user.click(screen.getByTestId('next-study-link'));
    await waitFor(() => expect(vi.mocked(getOpportunity)).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTestId('next-study-link'));
    await waitFor(() => expect(vi.mocked(getOpportunity)).toHaveBeenCalledTimes(3));

    // a -> b -> a: three loads, three distinct (id, previous-id) transitions,
    // three marks - never a fourth from a stray re-render.
    await waitFor(() => expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledTimes(3));
  });

  // markedOpenedKeyRef is keyed on `${user.id}:${id}`, not the study id
  // alone, so a signed-in identity change on the SAME study within the same
  // mounted instance re-asks rather than reading as already marked for
  // whoever is signed in now.
  it('a user switch on the SAME study re-marks it for the new user', async () => {
    const { rerender } = renderDetail();
    await waitFor(() => expect(vi.mocked(getOpportunity)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledWith('opp-a');

    currentUser = { id: 'u2', role: 'employee', name: 'F' };
    rerender(detailTree());

    await waitFor(() => expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(markOpportunityOpened)).toHaveBeenLastCalledWith('opp-a');
  });

  // The other half of the same key: a re-render that hands out a NEW user
  // object for the SAME user and the same study must not mark it again.
  it('a re-render with a new user object for the same user does not re-mark the study', async () => {
    const { rerender } = renderDetail();
    await waitFor(() => expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledTimes(1));

    currentUser = { ...currentUser };
    rerender(detailTree());
    // Effects from the re-render have flushed once act settles; give any
    // stray async follow-up a moment too before asserting the absence.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(vi.mocked(markOpportunityOpened)).toHaveBeenCalledTimes(1);
  });
});
