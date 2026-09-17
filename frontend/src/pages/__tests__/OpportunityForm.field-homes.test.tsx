import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm, { FIELD_LOCATIONS } from '../OpportunityForm';
import { summarisedErrorKeys } from './helpers/error-summary';

/*
 * D6 - field homes. Each field is asked on the step it belongs to, within the
 * existing six steps (2a does not reshape the step set):
 *
 *   - Meeting Location + Default Duration -> the Session Management step
 *   - Study Period, Participant Type, Roles or skills -> the Screener/Audience step
 *   - Description + Product -> Basic Information, beside Title and Purpose
 *
 * The tests drive the wizard the way an author does - choose a type, walk the
 * strip - and assert a field is present on its NEW step and absent from its OLD
 * one, so a move that only half-happened fails by name. Validation must travel
 * with the control: a rule for a moved field must block on the step that now
 * renders it.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false,
  }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light' }),
}));

// The Session Management step body renders Meeting Location and Default Duration
// OUTSIDE AdminSessionManager, so mocking the manager to null still exercises
// the two fields on that step.
vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../api/firsthand-studies', () => ({
  getFirstHandStudy: vi.fn().mockRejectedValue(new Error('not stubbed')),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

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

const setTitle = (value: string) =>
  fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value } });

const setPurpose = (value: string) =>
  fireEvent.change(screen.getByLabelText(/purpose/i), { target: { value } });

/**
 * Click the strip button naming the step. Matched by substring, because each
 * strip button's accessible name also carries its number and status word.
 */
const goToStep = (name: RegExp) =>
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Form steps' })).getByRole(
      'button',
      { name }
    )
  );

const fillBasics = (type: string) => {
  selectType(type);
  setTitle('A perfectly serviceable title');
  setPurpose('Find out where people stall in the checkout flow');
};

describe('D6 field homes - FIELD_LOCATIONS routes a moved field to its new step', () => {
  // Pinned as literals (not derived) so a tab renumber cannot slip past. The
  // step ids: 3 is the type-specific step (Session Management for test/interview),
  // 4 is the Screener step on every shape that reaches a participant.
  it('routes Meeting Location and Default Duration to the Session Management step (3)', () => {
    expect(FIELD_LOCATIONS.meeting_location_optional.tab).toBe(3);
    expect(FIELD_LOCATIONS.default_duration_minutes.tab).toBe(3);
  });

  it('routes Participant Type and its criteria to the Screener step (4)', () => {
    expect(FIELD_LOCATIONS.participant_type_required.tab).toBe(4);
    expect(FIELD_LOCATIONS.participant_type_specific_details.tab).toBe(4);
  });
});

describe('D6 field homes - Basic Information', () => {
  it('asks Description on Basic Information, not on Content & Details', () => {
    renderForm();
    fillBasics('survey');

    // On Basic Information now.
    expect(screen.getByLabelText(/Description \(Optional\)/i)).toBeInTheDocument();

    // Gone from Content & Details.
    goToStep(/Content & Details/);
    expect(screen.queryByLabelText(/Description \(Optional\)/i)).toBeNull();
  });

  it('asks Product on Basic Information, not on Content & Details', () => {
    renderForm();
    fillBasics('survey');

    expect(screen.getByLabelText(/Product\/Feature/i)).toBeInTheDocument();

    goToStep(/Content & Details/);
    expect(screen.queryByLabelText(/Product\/Feature/i)).toBeNull();
  });
});

describe('D6 field homes - Session Management step', () => {
  it('asks Meeting Location on the Session Management step, not Basic Information', () => {
    renderForm();
    fillBasics('test');

    // Not on Basic Information any more.
    expect(screen.queryByLabelText(/Meeting Location/i)).toBeNull();

    goToStep(/Session Management/);
    expect(screen.getByLabelText(/Meeting Location/i)).toBeInTheDocument();
  });

  it('asks Default Duration on the Session Management step, not Basic Information', () => {
    renderForm();
    fillBasics('test');

    expect(screen.queryByLabelText(/Default Duration/i)).toBeNull();

    goToStep(/Session Management/);
    expect(screen.getByLabelText(/Default Duration/i)).toBeInTheDocument();
  });
});

describe('D6 field homes - Screener/Audience step', () => {
  it('asks Participant Type on the Screener step, not Content & Details', () => {
    renderForm();
    fillBasics('unmoderated');

    goToStep(/Content & Details/);
    expect(screen.queryByLabelText(/Participant Type/i)).toBeNull();

    goToStep(/Screener/);
    expect(screen.getByLabelText(/Participant Type/i)).toBeInTheDocument();
  });

  it('asks Roles or skills wanted on the Screener step, not Content & Details', () => {
    renderForm();
    fillBasics('unmoderated');

    goToStep(/Content & Details/);
    expect(screen.queryByLabelText(/Roles or skills/i)).toBeNull();

    goToStep(/Screener/);
    expect(screen.getByLabelText(/Roles or skills/i)).toBeInTheDocument();
  });

  it('asks Study Period on the Screener step, not Basic Information', () => {
    renderForm();
    fillBasics('unmoderated');

    // Study Period is not on Basic Information any more.
    expect(screen.queryByLabelText(/Start Date/i)).toBeNull();

    goToStep(/Screener/);
    expect(screen.getByLabelText(/Start Date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/End Date/i)).toBeInTheDocument();
  });
});

describe('D6 field homes - validation travels with the control', () => {
  it('blocks an out-of-range Default Duration on the Session Management step', () => {
    renderForm();
    fillBasics('test');

    goToStep(/Session Management/);
    const duration = screen.getByLabelText(/Default Duration/i);
    fireEvent.change(duration, { target: { value: '300' } });
    fireEvent.blur(duration);

    // The refusal is raised on the step that now owns the field.
    expect(
      screen.getByText('Enter a session length between 5 and 240 minutes')
    ).toBeInTheDocument();
  });

  it('blocks missing participant criteria on the Screener step', () => {
    renderForm();
    fillBasics('unmoderated');

    goToStep(/Screener/);
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'specific' },
    });

    // Continue from the Screener step is refused over the criteria field that
    // now lives here.
    fireEvent.click(screen.getByRole('button', { name: /^Continue(:|$)/i }));
    expect(summarisedErrorKeys()).toContain('participant_type_specific_details');
  });
});
