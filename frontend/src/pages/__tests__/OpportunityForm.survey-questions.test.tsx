import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm, { getTabsForType } from '../OpportunityForm';
import { createOpportunity, getOpportunity, updateOpportunity } from '../../api/client';

/**
 * Authoring a native poll or survey on the opportunity form.
 *
 * Polls and surveys were external-link-only, so the third tab was always
 * "External Link". Which tab appears now depends on where the participant
 * answers, and the questions written there have to reach the API in the shape
 * the contract accepts - a payload that fails server-side is the failure this
 * form exists to prevent.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', role: 'researcher_admin', name: 'R' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn().mockResolvedValue({ id: 'new-1' }),
  updateOpportunity: vi.fn().mockResolvedValue({ id: 'opp-1' }),
  getOpportunity: vi.fn(),
  getFirstHandStudies: vi.fn(async () => []),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSessions: vi.fn(async () => [])
}));

const renderForm = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <Routes>
        <Route path="/admin/opportunities/new" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getTabsForType', () => {
  it('offers the external link tab when a survey hands off', () => {
    expect(getTabsForType('survey', 'external').map((tab) => tab.title)).toEqual([
      'Basic Information',
      'Content & Details',
      'External Link'
    ]);
  });

  it('offers the questions tab when a survey runs in Cortex', () => {
    expect(getTabsForType('survey', 'native').map((tab) => tab.title)).toEqual([
      'Basic Information',
      'Content & Details',
      'Questions'
    ]);
  });

  it('defaults to the external link tab, which is what every existing poll is', () => {
    expect(getTabsForType('poll').map((tab) => tab.title)).toContain('External Link');
  });

  /**
   * `question` has no native runner, so it keeps the link tab whatever the
   * delivery mode says. Without this it would lose its only third tab.
   */
  it('leaves the one-question type on the external link tab', () => {
    expect(getTabsForType('question', 'native').map((tab) => tab.title)).toContain(
      'External Link'
    );
  });

  it('leaves a recorded study on its task list', () => {
    expect(getTabsForType('unmoderated', 'native').map((tab) => tab.title)).toContain(
      'Task List'
    );
  });
});

describe('authoring a native survey', () => {
  const fillBasics = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.selectOptions(screen.getByLabelText(/Research Study Type/i), 'survey');
    await user.type(screen.getByLabelText(/^Title/i), 'Developer experience pulse');
    await user.type(
      screen.getByLabelText(/^Purpose/i),
      'Ten short questions about the tools you use every day'
    );
  };

  it('does not offer the delivery choice for a type that has no external mode', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(
      screen.getByLabelText(/Research Study Type/i),
      'unmoderated'
    );

    expect(screen.queryByText(/Where participants answer/i)).toBeNull();
  });

  it('swaps the third tab when the author chooses to run it in Cortex', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);

    expect(screen.getByText('External Link')).toBeInTheDocument();

    await user.click(screen.getByLabelText(/In Cortex/i));

    await waitFor(() => expect(screen.getByText('Questions')).toBeInTheDocument());
    expect(screen.queryByText('External Link')).toBeNull();
  });

  /**
   * The whole point of the tab: the questions have to arrive at the API as
   * `inline_survey`, in the contract's shape. This asserts on the request body
   * rather than on form state, because state proves nothing about what was
   * sent - the failure mode that lost every survey answer before 7.36.2 was
   * exactly a value that looked right until it crossed a boundary.
   */
  it('sends the authored questions as inline_survey', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));

    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'How easy was that?'
    );

    await user.click(screen.getByRole('button', { name: /Create Opportunity/i }));

    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      delivery_mode?: string;
      inline_survey?: { steps: { type: string; prompt: string }[] };
    };

    expect(body.delivery_mode).toBe('native');
    expect(body.inline_survey?.steps).toEqual([
      { type: 'open_text', prompt: 'How easy was that?' }
    ]);
  });

  /**
   * Changing a question's type has to DROP the settings that no longer apply,
   * not merely stop rendering them. A rating's scale left on a question the
   * author switched to a recommendation score is rejected by the contract -
   * that type is fixed at 0 to 10 and takes no scale - so a hidden leftover
   * fails the save with an error about a field the form is no longer showing.
   */
  it('drops a rating scale when the question becomes a recommendation score', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'How easy was that?'
    );

    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'rating');
    await waitFor(() =>
      expect(screen.getByLabelText(/Points on the scale/i)).toBeInTheDocument()
    );

    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'nps');

    await user.click(screen.getByRole('button', { name: /Create Opportunity/i }));
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      inline_survey?: { steps: Record<string, unknown>[] };
    };

    expect(body.inline_survey?.steps[0]).toEqual({
      type: 'nps',
      prompt: 'How easy was that?'
    });
  });

  /**
   * A half-written question must not block a save the author has since moved
   * away from. The per-question rules run only while those questions are the
   * thing being authored: ungated, a question abandoned before switching to an
   * external tool refused every later save while naming a field on a tab that
   * is no longer rendered.
   */
  it('does not hold an abandoned question against an external survey', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    // Added and left empty, which is what an author does when they change
    // their mind.
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));

    await user.click(screen.getByRole('button', { name: /Basic Information/i }));
    await user.click(screen.getByLabelText(/In an external tool/i));
    await user.click(screen.getByRole('button', { name: /External Link/i }));
    await user.type(
      screen.getByLabelText(/External Link/i),
      'https://example.com/form'
    );

    await user.click(screen.getByRole('button', { name: /Create Opportunity/i }));

    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());
  });

  /**
   * The scale is guarded only by min/max on a number input, and the save
   * controls are type="button" so they never run constraint validation - the
   * tab is unmounted anyway while the author is elsewhere. Without a rule the
   * contract refuses the save instead.
   */
  /**
   * An unrelated edit must not resend the delivery mode.
   *
   * The backend gates its publish and linkage checks on the request changing
   * the shape, precisely so a row already in a bad state can still be repaired.
   * Sending this field on every save made both conditions permanently true for
   * polls and surveys - a published poll with no external link could no longer
   * have its title corrected at all, and DELETE was the only way out. The
   * lock-out the backend guard was written to prevent, reintroduced from here.
   */
  it('does not resend the delivery mode on an edit that did not change it', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-1',
      type: 'survey',
      title: 'Developer experience pulse',
      purpose_one_liner: 'Ten short questions about the tools you use every day',
      description_optional: '',
      product_optional: '',
      default_duration_minutes: 30,
      status: 'draft',
      delivery_mode: 'native',
      firsthand_study_id: 'study_questions',
      participant_type_required: 'any',
      sessions: []
    } as never);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    const title = await screen.findByDisplayValue('Developer experience pulse');
    await user.type(title, ' 2026');

    await user.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    const body = vi.mocked(updateOpportunity).mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('delivery_mode');
  });

  /**
   * Reached through EDIT mode on purpose. From the Questions tab the number
   * input's own min/max blocks submission before any of this runs - but the
   * Save Changes buttons on the first two tabs are type="button" and call
   * handleSubmit directly, so they bypass constraint validation entirely while
   * the Questions tab is unmounted. That is the path an author actually takes,
   * and where the contract would otherwise refuse the save server-side.
   */
  it('refuses a rating scale the contract would reject, before sending it', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-1',
      type: 'survey',
      title: 'Developer experience pulse',
      purpose_one_liner: 'Ten short questions about the tools you use every day',
      description_optional: '',
      product_optional: '',
      default_duration_minutes: 30,
      status: 'draft',
      delivery_mode: 'native',
      participant_type_required: 'any',
      sessions: []
    } as never);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByDisplayValue('Developer experience pulse');

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'Rate it'
    );
    await user.selectOptions(screen.getByLabelText(/^Type$/i), 'rating');
    await user.clear(screen.getByLabelText(/Points on the scale/i));

    await user.click(screen.getByRole('button', { name: /Basic Information/i }));
    await user.click(screen.getByRole('button', { name: /Save Changes/i }));

    expect(updateOpportunity).not.toHaveBeenCalled();
    // On the SPECIFIC message, which only this rule produces. Asserting merely
    // that nothing was sent passed with the rule removed, because the number
    // input's own constraint was blocking the submit instead.
    expect(
      await screen.findByText(/rating scale needs between 2 and 10 points/i)
    ).toBeInTheDocument();
  });

  /**
   * Switching back to an external handoff must not leave the questions in the
   * payload: the API refuses them outright for external delivery, which would
   * block the save with an error about a tab the author is no longer looking at.
   */
  it('drops authored questions when the author switches back to an external tool', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillBasics(user);
    await user.click(screen.getByLabelText(/In Cortex/i));

    await user.click(screen.getByRole('button', { name: /Questions/i }));
    await user.click(screen.getByRole('button', { name: /^Add question$/i }));
    await user.type(
      screen.getByLabelText(/What the participant is asked/i),
      'How easy was that?'
    );

    await user.click(screen.getByRole('button', { name: /Basic Information/i }));
    await user.click(screen.getByLabelText(/In an external tool/i));

    await user.click(screen.getByRole('button', { name: /External Link/i }));
    await user.type(
      screen.getByLabelText(/External Link/i),
      'https://example.com/form'
    );

    await user.click(screen.getByRole('button', { name: /Create Opportunity/i }));

    await waitFor(() => expect(createOpportunity).toHaveBeenCalled());

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as {
      delivery_mode?: string;
      inline_survey?: unknown;
    };

    expect(body.delivery_mode).toBe('external');
    expect(body.inline_survey).toBeUndefined();
  });
});
