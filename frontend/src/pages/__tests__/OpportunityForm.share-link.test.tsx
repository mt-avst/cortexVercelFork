import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, getSessions } from '../../api/client';

/**
 * #108: the participant share link, threaded from OpportunityForm into
 * ReviewStep.
 *
 * `ReviewStep.test.tsx` covers what the component does with `shareLink` and
 * `role` once it has them. This file covers what OpportunityForm computes
 * for those two props - which is the part a component test cannot see: a
 * brand new opportunity has no id to link at all, and `shareLinkStartable`
 * mirrors a rule (`OpportunityDetail`'s own "can a participant actually
 * start this") that lives in this file, not in ReviewStep.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

/**
 * A real forward control on the session step, the same shape as
 * `OpportunityForm.review.test.tsx` uses - not mocked to `null`, or the
 * test-type path would have no way past this step at all.
 */
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

const renderCreate = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <Routes>
        <Route path="/admin/opportunities/new" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessions).mockResolvedValue([] as never);
});

describe('OpportunityForm - the share link OpportunityForm computes for Review (#108)', () => {
  it('is null before the opportunity has ever been saved', () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText(/Research Study Type/i), {
      target: { value: 'poll' }
    });
    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'A study with a long enough title' }
    });
    fireEvent.change(screen.getByLabelText(/^Purpose/i), {
      target: { value: 'A purpose long enough to pass validation' }
    });
    walkToReview();

    // No id exists yet - ReviewStep must not be handed one to link to.
    expect(screen.queryByText('Share this study')).not.toBeInTheDocument();
  });

  it('carries the route id once the opportunity exists (edit mode)', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY() as never);
    renderEdit();
    await screen.findByDisplayValue('A poll the author already wrote');
    walkToReview();

    // Draft, so the hint renders rather than the live link - but the block
    // exists at all, which is the thing `shareLink !== null` controls.
    expect(screen.getByText('Share this study')).toBeInTheDocument();
    expect(screen.getByText(/Publish to share this link/i)).toBeInTheDocument();
  });

  it('resolves to the live link, with this opportunity\'s id, once published', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({ status: 'published' }) as never
    );
    renderEdit();
    await screen.findByDisplayValue('A poll the author already wrote');
    walkToReview();

    expect(
      screen.getByText(`${window.location.origin}/opportunities/opp-1`)
    ).toBeInTheDocument();
  });

  describe('shareLinkStartable', () => {
    it('is false for a published test with no sessions', async () => {
      vi.mocked(getOpportunity).mockResolvedValue(
        OPPORTUNITY({ type: 'test', status: 'published' }) as never
      );
      vi.mocked(getSessions).mockResolvedValue([] as never);
      renderEdit();
      // Test and interview land on Session Management, not Basic Information,
      // on load (see the `landedForRef` comment in OpportunityForm.tsx) - so
      // there is no title field to wait on here, unlike the poll cases above.
      await screen.findByText('stub: session management');
      walkToReview();

      expect(screen.getByText(/Participants cannot start this yet/i)).toBeInTheDocument();
    });

    it('is true for the same published test once it has one session', async () => {
      vi.mocked(getOpportunity).mockResolvedValue(
        OPPORTUNITY({ type: 'test', status: 'published' }) as never
      );
      vi.mocked(getSessions).mockResolvedValue([
        {
          id: 'sess-1',
          opportunity_id: 'opp-1',
          start_time: '2030-01-07T10:00:00.000Z',
          end_time: '2030-01-07T10:30:00.000Z',
          capacity: 1,
          booked_count: 0,
          remaining: 1,
          location_or_meet_link_optional: ''
        }
      ] as never);
      renderEdit();
      await screen.findByText('stub: session management');
      walkToReview();

      expect(screen.queryByText(/Participants cannot start this yet/i)).not.toBeInTheDocument();
    });

    it('is true for a published interview once it has one session, mirroring test', async () => {
      vi.mocked(getOpportunity).mockResolvedValue(
        OPPORTUNITY({ type: 'interview', status: 'published' }) as never
      );
      vi.mocked(getSessions).mockResolvedValue([
        {
          id: 'sess-1',
          opportunity_id: 'opp-1',
          start_time: '2030-01-07T10:00:00.000Z',
          end_time: '2030-01-07T10:30:00.000Z',
          capacity: 1,
          booked_count: 0,
          remaining: 1,
          location_or_meet_link_optional: ''
        }
      ] as never);
      renderEdit();
      await screen.findByText('stub: session management');
      walkToReview();

      expect(screen.queryByText(/Participants cannot start this yet/i)).not.toBeInTheDocument();
    });

    it('is true for a published poll regardless of sessions - it has no session surface at all', async () => {
      // The control: a type where the rule does not apply must never show the
      // unstartable warning, session count notwithstanding - proving the
      // gate above is scoped to test/interview and not accidentally global.
      vi.mocked(getOpportunity).mockResolvedValue(
        OPPORTUNITY({ type: 'poll', status: 'published' }) as never
      );
      vi.mocked(getSessions).mockResolvedValue([] as never);
      renderEdit();
      await screen.findByDisplayValue('A poll the author already wrote');
      walkToReview();

      expect(screen.queryByText(/Participants cannot start this yet/i)).not.toBeInTheDocument();
      expect(
        screen.getByText(`${window.location.origin}/opportunities/opp-1`)
      ).toBeInTheDocument();
    });
  });
});
