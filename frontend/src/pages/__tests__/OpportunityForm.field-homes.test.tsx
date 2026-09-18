import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm, { FIELD_LOCATIONS } from '../OpportunityForm';
import { summarisedErrorKeys } from './helpers/error-summary';
import { chooseStudyType } from './helpers/study-type-picker';

/*
 * D6 - field homes, updated for the reshape that split Study type and Basic
 * Info into their own steps:
 *
 *   - Meeting Location + Default Duration -> the Session Management step
 *   - Study Period, Participant Type, Roles or skills -> the Screener/Audience step
 *   - Description + Product -> the Basic Info step, beside Title and Purpose
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
  // D13, W9: StudyTypePicker mounts DescribeIt on the new-study route, and it
  // checks this on every mount - unmocked, this call resolves to `undefined`
  // and throws inside a component effect. False keeps the AI panel hidden,
  // which is the correct default for a suite that is not about AI drafting.
  getAiDraftingAvailable: vi.fn().mockResolvedValue(false),
  draftOpportunityFromBrief: vi.fn(),
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

const selectType = (value: string) => chooseStudyType(value);

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

// Picks the type on the Study type step, then moves straight to Basic Info
// (via the free-navigation strip) to name the study - the two are separate
// steps since the split, where they used to be one.
const fillBasics = (type: string) => {
  selectType(type);
  goToStep(/Basic Info/);
  setTitle('A perfectly serviceable title');
  setPurpose('Find out where people stall in the checkout flow');
};

describe('D6 field homes - FIELD_LOCATIONS routes a moved field to its new step', () => {
  // Pinned as literals (not derived) so a tab renumber cannot slip past. The
  // step ids: 4 is the type-specific step (Session Management for test/interview),
  // 3 is the Screener step on every shape that reaches a participant.
  it('routes Meeting Location and Default Duration to the Session Management step (4)', () => {
    expect(FIELD_LOCATIONS.meeting_location_optional.tab).toBe(4);
    expect(FIELD_LOCATIONS.default_duration_minutes.tab).toBe(4);
  });

  it('routes Participant Type and its criteria to the Audience step (3)', () => {
    expect(FIELD_LOCATIONS.participant_type_required.tab).toBe(3);
    expect(FIELD_LOCATIONS.participant_type_specific_details.tab).toBe(3);
  });
});

describe('D6 field homes - Basic Info step', () => {
  it('asks Description on the Basic Info step, not on Audience', () => {
    renderForm();
    fillBasics('survey');

    // On the Basic Info step now (with Title and Purpose).
    expect(screen.getByLabelText(/Description \(Optional\)/i)).toBeInTheDocument();

    // Not on the Audience step.
    goToStep(/Audience/);
    expect(screen.queryByLabelText(/Description \(Optional\)/i)).toBeNull();
  });

  it('asks Product on the Basic Info step, not on Audience', () => {
    renderForm();
    fillBasics('survey');

    expect(screen.getByLabelText(/Product\/Feature/i)).toBeInTheDocument();

    goToStep(/Audience/);
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

describe('D6 field homes - Audience step', () => {
  it('asks Participant Type on the Audience step, not The study', () => {
    renderForm();
    fillBasics('unmoderated');

    // Not on The study step.
    expect(screen.queryByLabelText(/Participant Type/i)).toBeNull();

    goToStep(/Audience/);
    expect(screen.getByLabelText(/Participant Type/i)).toBeInTheDocument();
  });

  it('asks Roles or skills wanted on the Audience step, not The study', () => {
    renderForm();
    fillBasics('unmoderated');

    expect(screen.queryByLabelText(/Roles or skills/i)).toBeNull();

    goToStep(/Audience/);
    expect(screen.getByLabelText(/Roles or skills/i)).toBeInTheDocument();
  });

  it('asks Study Period on the Audience step, not The study', () => {
    renderForm();
    fillBasics('unmoderated');

    // Study Period is not on The study step.
    expect(screen.queryByLabelText(/Start Date/i)).toBeNull();

    goToStep(/Audience/);
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

    goToStep(/Audience/);
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'specific' },
    });

    // Continue from the Screener step is refused over the criteria field that
    // now lives here.
    fireEvent.click(screen.getByRole('button', { name: /^Continue(:|$)/i }));
    expect(summarisedErrorKeys()).toContain('participant_type_specific_details');
  });
});
