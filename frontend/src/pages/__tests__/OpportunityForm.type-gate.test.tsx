import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity } from '../../api/client';
import { chooseStudyType } from './helpers/study-type-picker';

/**
 * WZ-18: the step strip is locked at type-choice.
 *
 * The strip's step count is a function of the chosen type - [1, 2, 5] with no
 * type, four or five once a type is picked - so rendering it before a type is
 * chosen shows the author a total that their very first action revises. This
 * file pins the fix: no strip until `formData.type` is set, and an existing
 * study (which always has a type) shows it from first render.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false,
  }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false }),
}));

vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../api/firsthand-studies', async (importActual) => ({
  ...(await importActual<typeof import('../../api/firsthand-studies')>()),
  getFirstHandStudy: vi.fn().mockRejectedValue(new Error('not stubbed')),
}));

const renderNew = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <Routes>
        <Route path="/admin/opportunities/new" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

const stripQuery = () =>
  screen.queryByRole('navigation', { name: /form steps/i });

const selectType = (value: string) => chooseStudyType(value);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the step strip is locked at type-choice (WZ-18)', () => {
  it('shows no strip on a new form until a type is chosen', () => {
    renderNew();

    // Before a type: the Basic Information body and its type picker are on
    // screen, but the numbered strip is not - it has no fixed count to show yet.
    expect(stripQuery()).not.toBeInTheDocument();
    expect(
      screen.getByRole('radiogroup', { name: /study type/i })
    ).toBeInTheDocument();

    selectType('unmoderated');

    // Once a type is chosen the strip appears at its now-fixed count.
    expect(stripQuery()).toBeInTheDocument();
  });

  it('shows the strip from first render for an existing study', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-1',
      title: 'An existing study',
      type: 'poll',
      status: 'draft',
      purpose_one_liner: 'Understand how people read the dashboard',
      external_link_optional: 'https://survey.test/one',
      participant_type_required: 'any',
    } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    // An edit loads with a type already set, so the strip is present as soon as
    // the study resolves - the author never sees a form without it.
    await waitFor(() => expect(stripQuery()).toBeInTheDocument());
  });
});
