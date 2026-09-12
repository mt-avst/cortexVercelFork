import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { opportunityFormRoutes } from '../OpportunityForm.routes';
import { getOpportunity } from '../../api/client';

/**
 * WZ-14: the form has two save behaviours - a draft autosaves, a published
 * study does not - and previously told the author about neither. This is the
 * signage, driven off the same `autosaveApplies` signal the real behaviour
 * uses, so the copy can never disagree with what the form actually does.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false })
}));
vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  deleteOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/firsthand-studies', async (importActual) => ({
  ...(await importActual<typeof import('../../api/firsthand-studies')>()),
  getFirstHandStudy: vi.fn()
}));

const draftOpportunity = {
  id: 'opp-1',
  type: 'survey',
  title: 'Developer experience pulse',
  purpose_one_liner: 'Ten short questions about the tools you use every day',
  description_optional: '',
  product_optional: '',
  meeting_location_optional: '',
  default_duration_minutes: 30,
  status: 'draft',
  delivery_mode: 'external',
  participant_type_required: 'any',
  owner_user_id: 'admin-1',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  sessions: []
};

const publishedOpportunity = { ...draftOpportunity, status: 'published' };

const renderEditForm = (opportunity: Record<string, unknown>) => {
  vi.mocked(getOpportunity).mockResolvedValue(opportunity as never);
  return render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
      <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
    </MemoryRouter>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signage for the two save models', () => {
  it('tells a draft author that changes save automatically', async () => {
    renderEditForm(draftOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    expect(screen.getByTestId('save-model-note')).toHaveTextContent(
      /save automatically/i
    );
    expect(screen.getByTestId('save-model-note')).not.toHaveTextContent(
      /not saved automatically/i
    );
  });

  it('tells a published-study author that changes are not saved automatically', async () => {
    renderEditForm(publishedOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    expect(screen.getByTestId('save-model-note')).toHaveTextContent(
      /not saved automatically/i
    );
    expect(screen.getByTestId('save-model-note')).not.toHaveTextContent(
      /^Draft changes save automatically/i
    );
  });
});
