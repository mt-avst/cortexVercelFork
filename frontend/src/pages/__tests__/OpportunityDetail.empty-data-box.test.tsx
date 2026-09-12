import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityDetail from '../OpportunityDetail';
import { getOpportunity, getRecordedStudyBrief } from '../../api/client';

// DT-6: the right-column "technical specs" box on the study page fills each row
// conditionally - PRODUCT, DURATION, TASKS, PARTICIPANTS. When every row is
// suppressed the box still shipped: its border and padding wrapped around
// nothing. It is now rendered only when it has at least one row; the content
// column (flex:6) then takes the full width.
//
// Post-DT-7 the empty case is narrower: poll, survey and question now always
// carry a DURATION expectation row, so the only study that can still empty the
// box is an unmoderated one with no linked brief, no product and no
// eligibility narrowing. That is the fixture here.

const emptyBase = {
  id: 'opp-1',
  type: 'unmoderated',
  title: 'How do you name a new repository',
  purpose_one_liner: 'A walkthrough of naming habits',
  status: 'published',
  default_duration_minutes: 30, // column default; must never surface
  participant_type_required: 'any', // no narrowing → no PARTICIPANTS row
  firsthand_study_id: null, // no linked study → no brief, no TASKS, no DURATION
  external_link_optional: 'https://example.com/study',
  sessions: [],
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
vi.mock('../../components/CalendarGrid', () => ({
  default: () => null,
  CALENDAR_LEGEND_ITEMS: [],
}));

vi.mock('../../api/client', () => ({
  getOpportunity: vi.fn(),
  getRecordedStudyBrief: vi.fn(),
  trackOpportunityClick: vi.fn().mockResolvedValue(undefined),
  bookSession: vi.fn(),
  getMyCalendarEvents: vi.fn(async () => []),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOpportunity).mockResolvedValue({ ...emptyBase } as never);
  // This study has no linked brief; guard the call anyway.
  vi.mocked(getRecordedStudyBrief).mockResolvedValue(null as never);
});

describe('study page data box (DT-6)', () => {
  it('does not render the specs box when an unmoderated study has nothing to put in it', async () => {
    const { container } = renderDetail();
    await screen.findByText(emptyBase.title);

    // The box, its border and its padding are gone - not merely empty.
    expect(container.querySelector('.mission-data-box')).toBeNull();
    // And none of its rows leaked out elsewhere.
    for (const label of ['PRODUCT', 'DURATION', 'TASKS', 'PARTICIPANTS']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('still renders the box when there is a row to show (product)', async () => {
    // Control: the fix must hide an EMPTY box, not the box itself. A study with
    // a product has exactly one row and the box comes back.
    vi.mocked(getOpportunity).mockResolvedValue({
      ...emptyBase,
      product_optional: 'Bitbucket Pipelines',
    } as never);

    const { container } = renderDetail();
    await screen.findByText(emptyBase.title);

    expect(container.querySelector('.mission-data-box')).not.toBeNull();
    expect(screen.getByText('PRODUCT')).toBeInTheDocument();
    expect(screen.getByText('Bitbucket Pipelines')).toBeInTheDocument();
  });
});
