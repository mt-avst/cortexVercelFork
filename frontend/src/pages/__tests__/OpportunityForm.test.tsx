import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm, {
  clearTypeConditionalErrors,
  UNMODERATED_EXTERNAL_PARTICIPANT_ERROR,
} from '../OpportunityForm';
import { getFirstHandStudies, getOpportunity } from '../../api/client';

// OpportunityForm is an admin-gated, context-heavy page. Model a signed-in
// researcher_admin so the auth gate lets the form render, and keep the theme
// light so the WebGL background (rendered only when isDark) never mounts under jsdom.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false,
  }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light' }),
}));

// Heavy leaf components irrelevant to the A1 study-vs-external-link behaviour;
// stub them so jsdom never pulls in three.js or the session manager.
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

// The form and the FirstHand study tab both call the API client on interaction.
// Stub every function they use; getFirstHandStudies returns one launched study
// so the picker has something to render. (Mocks are defined inside the factory
// to avoid the vi.mock hoisting temporal-dead-zone trap.)
vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([
    { id: 'study_demo', title: 'Demo Study', status: 'launched' },
  ]),
}));

// clearAllMocks resets call history but keeps mockResolvedValue implementations,
// so getFirstHandStudies still resolves its launched study in every test.
beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Pure logic - the two behaviours this change actually introduces (A1 follow-up)
// ---------------------------------------------------------------------------

describe('clearTypeConditionalErrors', () => {
  it('drops external-link and participant-type errors, keeps the study error, when switching to unmoderated', () => {
    const cleared = clearTypeConditionalErrors(
      {
        external_link_optional: 'x',
        participant_type_required: 'y',
        firsthand_study_id: 'keep',
        title: 'keep',
      },
      'unmoderated'
    );
    expect(cleared).toEqual({ firsthand_study_id: 'keep', title: 'keep' });
  });

  it('drops the stale firsthand-study error (and M2 error) when switching away from unmoderated', () => {
    const cleared = clearTypeConditionalErrors(
      {
        firsthand_study_id: 'x',
        participant_type_required: 'y',
        external_link_optional: 'keep',
        title: 'keep',
      },
      'poll'
    );
    expect(cleared).toEqual({ external_link_optional: 'keep', title: 'keep' });
  });

  it('drops both external-link and study errors for session types (test/interview)', () => {
    const cleared = clearTypeConditionalErrors(
      { external_link_optional: 'x', firsthand_study_id: 'y', title: 'keep' },
      'test'
    );
    expect(cleared).toEqual({ title: 'keep' });
  });

  it('does not mutate the input errors object', () => {
    const input = { external_link_optional: 'x', firsthand_study_id: 'y' };
    clearTypeConditionalErrors(input, 'unmoderated');
    expect(input).toEqual({ external_link_optional: 'x', firsthand_study_id: 'y' });
  });
});

describe('UNMODERATED_EXTERNAL_PARTICIPANT_ERROR', () => {
  it('matches the authoritative backend wording exactly', () => {
    expect(UNMODERATED_EXTERNAL_PARTICIPANT_ERROR).toBe(
      'Unmoderated studies cannot use an external participant type; participants must be logged-in Cortex users'
    );
  });
});

// ---------------------------------------------------------------------------
// Rendered behaviour - unmoderated routes to the FirstHand study, not a link (A1)
// ---------------------------------------------------------------------------

const renderForm = () =>
  render(
    <MemoryRouter>
      <OpportunityForm />
    </MemoryRouter>
  );

const selectType = (value: string) => {
  fireEvent.change(screen.getByRole('combobox', { name: /Research Study Type/i }), {
    target: { value },
  });
};

describe('OpportunityForm - unmoderated is FirstHand-only (A1)', () => {
  it('renders the create form for an admin without loading an opportunity', () => {
    renderForm();
    expect(
      screen.getByRole('combobox', { name: /Research Study Type/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Status/i })).toBeInTheDocument();
    // Create mode makes no fetch for an existing opportunity.
    expect(vi.mocked(getOpportunity)).not.toHaveBeenCalled();
  });

  it('routes unmoderated studies to the FirstHand Study tab, not External Link', () => {
    renderForm();
    selectType('unmoderated');

    // The FirstHand Study step replaces the External Link step for this type.
    expect(
      screen.getByRole('button', { name: /FirstHand Study/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /External Link/i })
    ).not.toBeInTheDocument();
    // ...and the type helper copy names FirstHand as the engine.
    expect(
      screen.getByText('Self-guided recorded study, powered by FirstHand')
    ).toBeInTheDocument();
  });

  it('keeps the External Link tab for poll and hides FirstHand Study', () => {
    renderForm();
    selectType('poll');

    expect(
      screen.getByRole('button', { name: /External Link/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /FirstHand Study/i })
    ).not.toBeInTheDocument();
  });

  it('sends unmoderated participants into a launched FirstHand study picker', async () => {
    renderForm();
    selectType('unmoderated');

    // Open the FirstHand Study step.
    fireEvent.click(screen.getByRole('button', { name: /FirstHand Study/i }));

    // The picker loads launched studies from FirstHand; there is no external-link fallback.
    expect(
      await screen.findByText('-- Select a launched FirstHand study --')
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Demo Study' })).toBeInTheDocument();
    expect(vi.mocked(getFirstHandStudies)).toHaveBeenCalled();
  });
});
