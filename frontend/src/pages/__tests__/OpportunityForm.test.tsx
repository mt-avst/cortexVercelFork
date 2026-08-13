import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm, {
  clearTypeConditionalErrors,
  UNMODERATED_EXTERNAL_PARTICIPANT_ERROR,
} from '../OpportunityForm';
import { createOpportunity, getFirstHandStudies, getOpportunity, updateOpportunity } from '../../api/client';

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
      screen.getByRole('button', { name: /Study Tasks/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /External Link/i })
    ).not.toBeInTheDocument();
    // ...and the type helper copy no longer names an internal product.
    expect(
      screen.getByText('Self-guided recorded study')
    ).toBeInTheDocument();
  });

  it('keeps the External Link tab for poll and hides the study tab', () => {
    renderForm();
    selectType('poll');

    expect(
      screen.getByRole('button', { name: /External Link/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Study Tasks/i })
    ).not.toBeInTheDocument();
  });

  it('lets an unmoderated study be authored inline without visiting the studies area', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Study Tasks/i }));

    // Authoring is the default path, so the tab opens on the task author and
    // does not fetch the study list at all.
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));

    expect(
      screen.getByLabelText(/What the participant sees/i)
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Consent text/i)).toBeInTheDocument();
    expect(vi.mocked(getFirstHandStudies)).not.toHaveBeenCalled();
  });

  it('sends the starting url, and blocks one that could run against the session', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Study Tasks/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    // An active-scheme URL is refused before it can reach the payload.
    fireEvent.change(screen.getByLabelText(/Starting URL/i), {
      target: { value: 'javascript:alert(1)' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    expect(
      await screen.findByText(/http\(s\) address, or a path beginning with a single/i)
    ).toBeInTheDocument();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();

    // A real one goes through and lands on the payload.
    fireEvent.change(screen.getByLabelText(/Starting URL/i), {
      target: { value: 'https://example.com/checkout' }
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const payload = vi.mocked(createOpportunity).mock.calls[0][0] as any;
    expect(payload.inline_study.target_url).toBe('https://example.com/checkout');
  });

  it('does not send a stale study id alongside tasks authored after unticking reuse', async () => {
    // The sequence that silently dropped authored tasks: tick reuse, pick a
    // study, change your mind, untick, write tasks. The id survived in state
    // and won on the backend, discarding everything typed.
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Study Tasks/i }));

    const reuse = await screen.findByLabelText(/Reuse a script from an existing study/i);
    fireEvent.click(reuse);
    fireEvent.change(await screen.findByLabelText(/Recorded study/i), {
      target: { value: 'study_demo' }
    });
    fireEvent.click(reuse);

    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    fireEvent.click(screen.getByRole('button', { name: /^Create/i }));

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const payload = vi.mocked(createOpportunity).mock.calls[0][0] as any;
    expect(payload.firsthand_study_id).toBeUndefined();
    expect(payload.inline_study.steps).toEqual([
      { type: 'open_text', prompt: 'Find the export button' }
    ]);
  });

  it('offers inline authoring when editing an unmoderated draft that has no study yet', async () => {
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-1',
      type: 'unmoderated',
      title: 'Draft saved early',
      purpose_one_liner: 'Saved before the tasks were written, which is allowed',
      status: 'draft',
      default_duration_minutes: 30,
      firsthand_study_id: null,
      participant_type_required: 'any'
    } as any);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Study Tasks/i }));

    // Not locked to the picker: the reuse tickbox is offered and authoring is
    // the default, exactly as on create.
    expect(
      await screen.findByLabelText(/Reuse a script from an existing study/i)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(screen.getByLabelText(/What the participant sees/i)).toBeInTheDocument();
  });

  it('adopts the created study after saving, so a second save is not rejected', async () => {
    // Edit mode stays on the form after saving. Without adopting the server's
    // answer the state still said "no study linked" while the database had one,
    // so the next save re-sent the tasks and the backend refused it as
    // authoring over an existing study - dead-ending the flow on click two.
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-3',
      type: 'unmoderated',
      title: 'Draft saved early',
      purpose_one_liner: 'Saved before the tasks were written, which is allowed',
      status: 'draft',
      default_duration_minutes: 30,
      firsthand_study_id: null,
      participant_type_required: 'any'
    } as any);
    vi.mocked(updateOpportunity).mockResolvedValueOnce({
      id: 'opp-3',
      type: 'unmoderated',
      firsthand_study_id: 'study_created_on_save'
    } as any);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-3/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Study Tasks/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Update Opportunity/i }));

    await vi.waitFor(() => {
      expect(vi.mocked(updateOpportunity)).toHaveBeenCalled();
    });

    // First save authored the study.
    expect(
      (vi.mocked(updateOpportunity).mock.calls[0][1] as any).inline_study
    ).toBeDefined();

    // Having adopted it, the tab is locked to the picker - wait on the picker
    // appearing rather than the tickbox vanishing, so the study-list fetch it
    // triggers settles inside the assertion instead of after the test.
    expect(await screen.findByText('-- Select a launched study --')).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Reuse a script from an existing study/i)
    ).not.toBeInTheDocument();

    // The point of the fix: a LATER save must not re-send the tasks, which the
    // backend would now reject as authoring over an existing study. Asserting
    // only that the tickbox vanished would pass even if the steps survived.
    //
    // A real edit is needed to trigger it - an unchanged form saves nothing.
    vi.mocked(updateOpportunity).mockResolvedValueOnce({
      id: 'opp-3',
      type: 'unmoderated',
      firsthand_study_id: 'study_created_on_save'
    } as any);

    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
    fireEvent.change(await screen.findByLabelText(/^Title/i), {
      target: { value: 'Draft saved early, now renamed' }
    });

    // Back to the study tab, where the save control lives. It stays disabled
    // while the post-save success banner is up, so wait it out rather than
    // racing it - a click during that window is silently dropped.
    fireEvent.click(screen.getByRole('button', { name: /Study Tasks/i }));
    const saveAgain = await screen.findByRole('button', { name: /Update Opportunity/i });
    await vi.waitFor(() => expect(saveAgain).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(saveAgain);

    await vi.waitFor(() => {
      expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(2);
    });

    const secondPayload = vi.mocked(updateOpportunity).mock.calls[1][1] as any;
    expect(secondPayload.inline_study).toBeUndefined();
    expect(secondPayload.firsthand_study_id).toBe('study_created_on_save');
  });

  it('locks an edit to the picker once a study is actually linked', async () => {
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-2',
      type: 'unmoderated',
      title: 'Already wired up',
      purpose_one_liner: 'This one already points at a recorded study somewhere',
      status: 'draft',
      default_duration_minutes: 30,
      firsthand_study_id: 'study_demo',
      participant_type_required: 'any'
    } as any);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-2/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Study Tasks/i }));

    expect(
      await screen.findByText('-- Select a launched study --')
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Reuse a script from an existing study/i)
    ).not.toBeInTheDocument();
  });

  it('still offers the launched-study picker when reuse is ticked', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Study Tasks/i }));
    fireEvent.click(await screen.findByLabelText(/Reuse a script from an existing study/i));

    expect(
      await screen.findByText('-- Select a launched study --')
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Demo Study' })).toBeInTheDocument();
    expect(vi.mocked(getFirstHandStudies)).toHaveBeenCalled();
  });
});
