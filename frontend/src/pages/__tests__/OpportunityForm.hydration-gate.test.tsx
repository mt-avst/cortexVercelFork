import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, updateOpportunity } from '../../api/client';

/**
 * The edit form must not be interactive before its data arrives.
 *
 * `loadingOpportunity` started as `false` and only became `true` inside the
 * effect, so the first render produced a fully interactive, EMPTY form. Anything
 * typed or selected in that window was replaced wholesale when loadOpportunity()
 * resolved and called setFormData - silently, with no error, and the next save
 * then reported success while sending the loaded values rather than the ones the
 * author had just chosen.
 *
 * Found via an e2e flake: selecting status=published immediately on arrival was
 * reverted to draft about half the time, so the study never published.
 *
 * These assertions are about what the author can REACH before hydration, not
 * about a spinner's markup - a spinner that renders alongside a live form would
 * satisfy the latter and not fix anything.
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
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn().mockResolvedValue({ id: 'opp-1' }),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/firsthand-studies', () => ({
  getFirstHandStudy: vi.fn()
}));

const OPPORTUNITY = {
  id: 'opp-1',
  type: 'poll',
  title: 'A poll the author already wrote',
  purpose_one_liner: 'A purpose long enough to pass validation',
  description_optional: '',
  product_optional: '',
  status: 'draft',
  default_duration_minutes: 30,
  external_link_optional: 'https://example.com/poll',
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

/**
 * Status moved off Basic Information onto Review (#111), so reaching it now
 * means walking every step's forward control first. `OPPORTUNITY` already
 * satisfies every step's validation for the poll shape it fixtures, so no
 * field needs filling along the way - only advancing.
 */
const advanceToReview = () => {
  for (let guard = 0; guard <= 6; guard += 1) {
    const forward = screen.queryByRole('button', { name: /^Continue: /i });
    if (!forward) return;
    fireEvent.click(forward);
  }
  throw new Error('advanceToReview never reached a step with no forward control');
};

/**
 * Review's Status control (#111) has no `<label htmlFor="status">` - it sits
 * under an `<h3>Status</h3>` heading instead, unlike its old Basic
 * Information home, which did have one (see `git show 1b744f5 --
 * BasicInfoTab.tsx`). `getByLabelText` therefore cannot find it post-move;
 * it is the only `<select>` Review renders, so `getByRole('combobox')`,
 * scoped to the review step, finds it without relying on a name that does
 * not exist. Filed as a real accessibility regression worth a follow-up
 * fix - not something a test file can correct.
 */
const statusControl = () =>
  within(screen.getByTestId('review-step')).getByRole('combobox') as HTMLSelectElement;

describe('OpportunityForm edit-mode hydration gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the spinner on the FIRST paint, before any effect has run', () => {
    // Deliberately NOT @testing-library's render: it wraps in act(), which
    // flushes useEffect before any assertion can run, so the first-paint window
    // is invisible to it. A test written that way passes with or without the
    // fix. renderToStaticMarkup runs render only - no effects - which is
    // precisely the frame the browser paints and the author can interact with.
    vi.mocked(getOpportunity).mockImplementation(() => new Promise(() => {}));

    const firstPaint = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    expect(firstPaint).toContain('Loading study');
    // The controls the author could otherwise reach and have silently discarded.
    expect(firstPaint).not.toContain('id="status"');
    expect(firstPaint).not.toContain('id="title"');
    expect(firstPaint).not.toContain('Save Changes');
  });

  it('does not render form controls while the opportunity is still loading', async () => {
    vi.mocked(getOpportunity).mockImplementation(() => new Promise(() => {}));

    renderEdit();

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByLabelText(/status/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument();
  });

  it('renders the form with the study loaded once hydration completes', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY as never);

    renderEdit();

    // The title is the proof that what renders is hydrated, not empty.
    const title = (await screen.findByLabelText(/title/i)) as HTMLInputElement;
    expect(title.value).toBe(OPPORTUNITY.title);

    // Status (#111) now lives on Review, not Basic Information - reach it
    // before reading it.
    advanceToReview();
    expect(statusControl().value).toBe('draft');
  });

  it('a status chosen after hydration survives to the save payload', async () => {
    // The end-to-end shape of the original defect, expressed as a unit test:
    // choose a status, save, and assert the REQUEST BODY carries it. Asserting
    // the rendered value would pass even if the payload had reverted.
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY as never);

    renderEdit();

    // Status (#111) now lives on Review, not Basic Information - reach it
    // before choosing one.
    await screen.findByLabelText(/title/i);
    advanceToReview();

    fireEvent.change(statusControl(), { target: { value: 'published' } });

    // On Review the commit control is the terminal "Save changes" button,
    // not the per-step "Save Changes" shortcut (there is deliberately no
    // shortcut on this step - see StepActions usage in OpportunityForm.tsx).
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());
    const body = vi.mocked(updateOpportunity).mock.calls[0][1] as Record<string, unknown>;
    expect(body.status).toBe('published');
  });
});
