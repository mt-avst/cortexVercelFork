import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, getSessions } from '../../api/client';

/**
 * Code review LOW (fail-closed): `stepForPublishProblem` resolving a code to
 * `null` used to make `OpportunityForm.tsx`'s `.flatMap` drop that problem
 * silently - shrinking `publishProblems`, which both `shareLinkStartable`
 * and `ReviewStep`'s "Published, not working" pill gate on. A single
 * unresolvable code (unreachable today; not unreachable forever, the day a
 * new `PublishProblemCode` is added to the type without a matching entry in
 * `STEP_KEY_FOR_PROBLEM`) would therefore have RE-EXPOSED the copyable share
 * link and hidden the warning on a study the server would still refuse to
 * publish.
 *
 * `stepForPublishProblem` is mocked here - and ONLY here, in its own file -
 * to always return `null`, simulating exactly that unresolvable code on a
 * study that genuinely has an unmet requirement (an external poll with no
 * link). Every other test in this suite needs the REAL step-resolution
 * logic for its own "Go to {step}" assertions, so this could not live in
 * the shared `OpportunityForm.review.test.tsx` without breaking them.
 */
vi.mock('../../lib/opportunity-authoring/review-summary', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/opportunity-authoring/review-summary')>()),
  stepForPublishProblem: vi.fn(() => null)
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

vi.mock('../../api/client', () => ({
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

/** Walk forward to Review, whatever the shape's step count. */
const walkToReview = () => {
  for (let guard = 0; guard <= 6; guard += 1) {
    const forward = screen.queryByRole('button', { name: /^Continue: /i });
    if (!forward) return;
    fireEvent.click(forward);
  }
  throw new Error('walkToReview never reached a step with no forward control');
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessions).mockResolvedValue([] as never);
});

describe('a publish problem that cannot be resolved to a step still counts (fail-closed)', () => {
  it('keeps the share link hidden even though its step cannot be found', async () => {
    // A published poll with no external link and nothing linked: a real,
    // genuine `external_link_required` problem - but `stepForPublishProblem`
    // is mocked to return null for it, standing in for a future code the
    // step map has not caught up with yet.
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-1',
      type: 'poll',
      title: 'A poll with an unresolvable publish problem',
      purpose_one_liner: 'A purpose long enough to pass validation',
      status: 'published',
      default_duration_minutes: 30,
      external_link_optional: '',
      participant_type_required: 'any',
      can_edit: true
    } as never);
    renderEdit();
    // Study type - the landing step since D5 - carries no Title field any
    // more, so the strip itself is the load anchor.
    await screen.findByRole('navigation', { name: 'Form steps' });
    walkToReview();

    // The checklist still renders - via the tabs[0] fallback - rather than
    // silently disappearing because its step could not be found.
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // The whole point: the share link must NOT come back just because this
    // one problem's step was unresolvable.
    expect(
      screen.getByText(/Participants cannot start this yet/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
  });
});
