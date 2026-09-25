import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, getSessions } from '../../api/client';
import { PUBLISH_PROBLEM_MESSAGES } from '@shared/firsthand/publish-readiness';
import { setStatus } from './helpers/review-status';

/**
 * #167: the Status pods keep the publish guard wired the same way the select
 * they replaced did - publishing still runs the existing readiness check,
 * and a refusal still shows its reasons. `OpportunityForm.review.test.tsx`
 * already proves this end to end; this is the standalone proof of the same
 * behaviour through the pods specifically: a study whose readiness fails,
 * edited, walked straight to Review (no wizard-walk needed - the study
 * already has a type), and Published chosen through the pod. The refusal
 * alert has to be the SAME one `findPublishProblem`/`findPublishProblems`
 * produce on the server, not a copy.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

vi.mock('../../components/AdminSessionManager', () => ({
  default: () => <div>stub: session management</div>
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

const POLL_MISSING_LINK = {
  id: 'opp-1',
  type: 'poll',
  title: 'A poll the author already wrote',
  purpose_one_liner: 'A purpose long enough to pass validation',
  description_optional: '',
  product_optional: '',
  status: 'draft',
  default_duration_minutes: 30,
  // The readiness gate this test is about: a poll with no external link.
  external_link_optional: null,
  participant_type_required: 'any',
  can_edit: true
};

const renderEdit = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
      <Routes>
        <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

/** Walk forward to Review - the study already has a type, so no wizard-walk is needed. */
const goToReview = async () => {
  await screen.findByRole('navigation', { name: 'Form steps' });
  const reviewStep = within(
    screen.getByRole('navigation', { name: 'Form steps' })
  ).getByRole('button', { name: /Review/ });
  fireEvent.click(reviewStep);
  await screen.findByTestId('review-step');
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessions).mockResolvedValue([] as never);
  vi.mocked(getOpportunity).mockResolvedValue(POLL_MISSING_LINK as never);
});

describe('the publish refusal renders through the pods, not just the old select (#167)', () => {
  it('choosing Published on the pod shows the same refusal a select used to trigger', async () => {
    renderEdit();
    await goToReview();

    // The plural checklist previews readiness regardless of the status
    // currently chosen (row 4), so the alert is already up on Draft - the
    // pod under test is Published, not whether an alert exists at all.
    expect(screen.getByRole('alert')).toHaveTextContent('This study cannot be published yet:');

    setStatus('published');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(PUBLISH_PROBLEM_MESSAGES.external_link_required);

    const link = within(alert).getByRole('button', { name: /^Go to /i });
    fireEvent.click(link);
    // The refusal names the step that fixes it and actually opens it.
    const steps = within(screen.getByRole('navigation', { name: 'Form steps' })).getAllByRole(
      'button'
    );
    const current = steps.find((step) => step.getAttribute('aria-current') === 'step');
    // The step's own name in the strip - "Your link" - not the alert's prose.
    expect(current?.textContent).toMatch(/Your link/i);
  });

  it('never blocks the commit control while refusing - the server is the authority', async () => {
    renderEdit();
    await goToReview();

    setStatus('published');

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });
});
