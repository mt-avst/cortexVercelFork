import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { createOpportunity, getOpportunity } from '../../api/client';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false,
  }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false }),
}));

vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
/**
 * Reports the backward-navigation props it was handed, so the page's wiring can
 * be asserted here while the control's own rendering is asserted where the real
 * component is rendered, in `AdminSessionManager.render.test.tsx`. Stubbed to
 * null, this step's control was invisible to every test - which is how it stayed
 * a bare "Back" while the other five were renamed.
 */
vi.mock('../../components/AdminSessionManager', () => ({
  default: ({
    onBack,
    onBackLabel,
    onSessionsChange,
    onOpportunitySave
  }: {
    onBack?: () => void;
    onBackLabel?: string;
    onSessionsChange?: (sessions: unknown[]) => void;
    onOpportunitySave?: () => void;
  }) => (
    <>
      <button type="button" onClick={onOpportunitySave}>
        stub: save the opportunity
      </button>
      <button type="button" onClick={onBack}>
        {onBackLabel ? `Previous: ${onBackLabel}` : 'sessions: no backward control'}
      </button>
      <button
        type="button"
        onClick={() =>
          onSessionsChange?.([
            { id: 'temp-session-1', start_time: '2030-01-01T10:00:00Z', end_time: '2030-01-01T10:30:00Z' }
          ])
        }
      >
        stub: lay out a time slot
      </button>
    </>
  )
}));

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

/**
 * Rendered with somewhere to go, so "did the exit control leave" is answered by
 * the destination appearing rather than by a spy on navigate - which would pass
 * just as happily if the confirmation never opened.
 */
const renderForm = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <Routes>
        <Route path="/admin/opportunities/new" element={<OpportunityForm />} />
        <Route path="/admin" element={<div>Admin dashboard</div>} />
      </Routes>
    </MemoryRouter>
  );

const strip = () => within(screen.getByRole('navigation', { name: 'Form steps' }));

/** Every step button, in the order the strip renders them. */
const steps = () => strip().getAllByRole('button');

const selectType = (value: string) => {
  fireEvent.change(screen.getByRole('combobox', { name: /Research Study Type/i }), {
    target: { value },
  });
};

const typeInto = (label: RegExp, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

/** The native survey path: Questions on step 3, Consent on step 4. */
const selectNativeSurvey = () => {
  selectType('survey');
  fireEvent.click(screen.getByLabelText(/In Cortex/i));
};

const fillBasics = () => {
  typeInto(/^Title/i, 'A study of the export flow');
  typeInto(/Purpose/i, 'Find out where people give up on exporting');
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the step strip reports progress, not just position', () => {
  it('numbers every step against the real total for the shape on screen', () => {
    renderForm();

    // No type chosen is a REACHABLE state with only two steps, and the numbering
    // has to be honest about it rather than promising a third.
    expect(steps().map((step) => step.textContent)).toEqual([
      expect.stringContaining('Step 1 of 2'),
      expect.stringContaining('Step 2 of 2'),
    ]);

    selectType('unmoderated');
    expect(steps().map((step) => step.textContent)).toEqual([
      expect.stringContaining('Step 1 of 4'),
      expect.stringContaining('Step 2 of 4'),
      expect.stringContaining('Step 3 of 4'),
      expect.stringContaining('Step 4 of 4'),
    ]);

    // An external poll authors no study, so it stops at three - and step 3 of 3
    // and step 3 of 4 are both real sentences this strip has to be able to say.
    selectType('poll');
    expect(steps().map((step) => step.textContent)).toEqual([
      expect.stringContaining('Step 1 of 3'),
      expect.stringContaining('Step 2 of 3'),
      expect.stringContaining('Step 3 of 3'),
    ]);
  });

  it('opens a blank form with one current step and the rest not started', () => {
    renderForm();
    selectType('unmoderated');

    const [one, two, three, four] = steps();
    expect(one).toHaveTextContent('Current step');
    expect(two).toHaveTextContent('Not started');
    expect(three).toHaveTextContent('Not started');
    expect(four).toHaveTextContent('Not started');
    // Not "Completed": nothing has been decided about steps 2 to 4, and the
    // validator has nothing to object to on any of them yet.
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('flags a step the author walked past leaving it invalid, and clears it when filled - with no save', () => {
    renderForm();
    selectType('unmoderated');

    // Straight past step 1 without a title. Reachable because the strip is
    // clickable, which is also why this does NOT go through the Continue
    // button that would have refused and reported it.
    fireEvent.click(steps()[2]);

    expect(steps()[0]).toHaveTextContent('Needs attention');
    expect(steps()[2]).toHaveTextContent('Current step');

    fireEvent.click(steps()[0]);
    typeInto(/Title/i, 'A study of the export flow');
    typeInto(/Purpose/i, 'Find out where people give up on exporting');

    // Still on step 1, so it reads Current; the point is that the flag is gone
    // and nothing was saved to clear it.
    expect(steps()[0]).toHaveTextContent('Current step');
    expect(steps()[0]).not.toHaveTextContent('Needs attention');

    fireEvent.click(steps()[1]);
    expect(steps()[0]).toHaveTextContent('Completed');
  });

  it('does not lock a step behind an earlier one that needs attention', () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(steps()[3]);

    expect(steps()[0]).toHaveTextContent('Needs attention');
    // Forward navigation is information, not a gate - the author is standing on
    // the last step with the first one failing, and that is allowed.
    expect(steps()[3]).toHaveTextContent('Current step');
    expect(screen.getByRole('heading', { name: /Consent/i })).toBeInTheDocument();
  });

  it('marks the current step with aria-current and no other step', () => {
    renderForm();
    selectType('unmoderated');
    fireEvent.click(steps()[1]);

    expect(steps().map((step) => step.getAttribute('aria-current'))).toEqual([
      null,
      'step',
      null,
      null,
    ]);
  });

  it('announces the step that was opened, naming it and its state', () => {
    renderForm();
    selectType('unmoderated');

    const region = screen.getByRole('status');
    fireEvent.click(steps()[2]);
    expect(region).toHaveTextContent('Step 3 of 4: Task List. Current step.');

    fireEvent.click(steps()[0]);
    // Announces the step it ARRIVED at, not the one it left, and reports the
    // state that step is actually in.
    expect(region).toHaveTextContent('Step 1 of 4: Basic Information. Needs attention.');
  });

  it('treats an opportunity being edited as already walked, not as three untouched steps', async () => {
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

    await screen.findByDisplayValue('An existing study');

    // Its content is on the server; calling steps 2 and 3 "Not started" would
    // be false. Step 1 is the one being looked at, so it reads Current.
    const [one, two, three] = steps();
    expect(one).toHaveTextContent('Current step');
    expect(two).toHaveTextContent('Completed');
    expect(three).toHaveTextContent('Completed');
  });
});

/**
 * Everything below is deliberately asserted somewhere OTHER than step 1.
 *
 * An independent mutation pass replaced `next.add(left)` with `next.add(1)`
 * and replaced `locateField` with `() => ({ tab: 1 })` on both error maps, and
 * all 1067 tests passed: every claim the strip makes had only ever been
 * checked on its first tile, and every error-flag assertion sat in slot 0.
 */
describe('the strip reports steps other than the first', () => {
  it('completes a step whose id is not 1', () => {
    renderForm();
    selectType('unmoderated');
    fillBasics();

    // Step 2, then step 3 - so the step being marked Completed is one the
    // visit tracker has to have recorded by its own identity rather than by a
    // hard-coded first step.
    fireEvent.click(steps()[1]);
    fireEvent.click(steps()[2]);

    expect(steps()[1]).toHaveTextContent('Completed');
    expect(steps()[0]).toHaveTextContent('Completed');
    expect(steps()[3]).toHaveTextContent('Not started');
  });

  it('flags a LATER step, and only that step, from the live rules', () => {
    renderForm();
    selectType('unmoderated');
    fillBasics();

    fireEvent.click(steps()[2]);
    fireEvent.click(screen.getByRole('button', { name: /Add task/i }));
    // A task with no wording is invalid under the same rules a save uses, and
    // it routes to step 3 - not step 1.
    fireEvent.click(steps()[3]);

    expect(steps()[2]).toHaveTextContent('Needs attention');
    expect(steps()[0]).not.toHaveTextContent('Needs attention');
    expect(steps()[1]).not.toHaveTextContent('Needs attention');
  });

  it('flags a later step the author has never opened, from a refused save', () => {
    renderForm();
    selectType('unmoderated');
    fillBasics();
    fireEvent.change(screen.getByRole('combobox', { name: /Status/i }), {
      target: { value: 'published' }
    });

    // Straight from step 1 to the last step, so steps 2 and 3 are UNVISITED -
    // which is the only state the reported-errors map is load-bearing for.
    fireEvent.click(steps()[3]);
    fireEvent.click(screen.getByRole('button', { name: /Create Opportunity/i }));

    // Publishing an unmoderated study with no tasks fails on step 3.
    expect(steps()[2]).toHaveTextContent('Needs attention');
    expect(steps()[0]).not.toHaveTextContent('Needs attention');
  });

  it('marks the right steps visited on a NATIVE survey being edited, not just an external one', async () => {
    // The delivery mode is read back from the loaded opportunity. Hard-coded
    // either way, an edited native survey reports its Consent step - which has
    // wording on the server - as "Not started".
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-2',
      title: 'A native survey',
      type: 'survey',
      status: 'draft',
      delivery_mode: 'native',
      purpose_one_liner: 'Understand how people read the dashboard',
      participant_type_required: 'any',
    } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-2/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByDisplayValue('A native survey');

    const rendered = steps();
    expect(rendered).toHaveLength(4);
    expect(rendered[3]).toHaveTextContent('Step 4 of 4');
    expect(rendered[3]).toHaveTextContent('Completed');
    expect(rendered[2]).toHaveTextContent('Completed');
  });

  it('does not carry one step 3 history over to a different step 3', () => {
    renderForm();
    selectType('unmoderated');
    fillBasics();

    fireEvent.click(steps()[1]);
    fireEvent.click(steps()[2]);
    fireEvent.click(steps()[0]);
    expect(steps()[1]).toHaveTextContent('Completed');
    expect(steps()[2]).toHaveTextContent('Completed');

    // Step 3 is now External Link, a step this author has never seen. Its id
    // is still 3, which is exactly why history cannot be held by id.
    selectType('poll');

    expect(steps()).toHaveLength(3);
    expect(steps()[2]).toHaveTextContent('External Link');
    expect(steps()[2]).toHaveTextContent('Not started');

    // And Content & Details, which IS the same step either side of the change,
    // keeps what it had. Forgetting everything on a type change would clear
    // the flag above too, and would look from that assertion alone like the
    // fix working.
    expect(steps()[1]).toHaveTextContent('Completed');
  });

  it('keeps the announcement quiet while the author types', () => {
    renderForm();
    selectType('unmoderated');
    fireEvent.click(steps()[1]);

    const region = screen.getByRole('status');
    const announced = region.textContent;
    expect(announced).toContain('Step 2 of 4');

    // Typing flips step 1 from Needs attention to Completed, which re-renders
    // the strip. The region must not re-announce: it reports step CHANGES.
    fireEvent.click(steps()[0]);
    const onStepOne = region.textContent;
    fillBasics();

    expect(region.textContent).toBe(onStepOne);
  });

  it('keeps the announcement out of the visible page', () => {
    renderForm();

    expect(screen.getByRole('status')).toHaveClass('visually-hidden');
  });

  it('marks the current step visually as well as programmatically', () => {
    renderForm();
    selectType('unmoderated');
    fireEvent.click(steps()[2]);

    // `aria-current` is for assistive technology; the class is what draws the
    // tint and the underline. Both, or the strip reads as inert to one of the
    // two audiences.
    expect(steps()[2]).toHaveClass('active');
    expect(steps()[0]).not.toHaveClass('active');
  });

  it('does not strand a needs-attention flag on a step that has been replaced', () => {
    renderForm();
    selectNativeSurvey();
    fillBasics();

    fireEvent.click(steps()[2]);
    fireEvent.click(screen.getByRole('button', { name: /Add question/i }));
    fireEvent.click(steps()[3]);

    // Through a REFUSED SAVE, so the error lands in the reported map and not
    // only in the live rules. The live rules re-evaluate against a form that
    // no longer holds any questions and clear themselves; the reported map
    // does not, and that is the half that strands.
    fireEvent.click(screen.getByRole('button', { name: /Create Opportunity/i }));
    expect(steps()[2]).toHaveTextContent('Needs attention');

    // Switching delivery mode discards the questions and replaces step 3 with
    // External Link, which is optional on a draft and shows no error. Left
    // uncleared, the flag is a dead end: the badge says fix this and there is
    // nothing on the step to fix.
    fireEvent.click(steps()[0]);
    fireEvent.click(screen.getByLabelText(/In an external tool/i));

    expect(steps()[2]).toHaveTextContent('External Link');
    expect(steps()[2]).not.toHaveTextContent('Needs attention');
  });
});

describe('the two backward controls are named apart', () => {
  it('names the step the bottom control returns to', () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(steps()[1]);
    expect(
      screen.getByRole('button', { name: 'Previous: Basic Information' })
    ).toBeInTheDocument();

    fireEvent.click(steps()[2]);
    expect(
      screen.getByRole('button', { name: 'Previous: Content & Details' })
    ).toBeInTheDocument();

    // Named from the step list rather than from a number written at the call
    // site: the Consent step's previous is the Task List for an unmoderated
    // study and the Questions step for a native survey, and neither call site
    // says so itself.
    fireEvent.click(steps()[3]);
    expect(
      screen.getByRole('button', { name: 'Previous: Task List' })
    ).toBeInTheDocument();
  });

  it('names it on the survey path too, not only the unmoderated one', () => {
    // The twin. Of the five converted call sites, the Questions step and the
    // External Link step were the two an independent mutation pass could
    // rewire to step 1 and rename to themselves without a single failure.
    renderForm();
    selectNativeSurvey();

    fireEvent.click(steps()[2]);
    expect(
      screen.getByRole('button', { name: 'Previous: Content & Details' })
    ).toBeInTheDocument();

    fireEvent.click(steps()[3]);
    expect(
      screen.getByRole('button', { name: 'Previous: Questions' })
    ).toBeInTheDocument();
  });

  it('names it on the external-link path, which authors no study at all', () => {
    renderForm();
    selectType('question');

    fireEvent.click(steps()[2]);
    expect(
      screen.getByRole('button', { name: 'Previous: Content & Details' })
    ).toBeInTheDocument();
  });

  it('names it on the session path, which does not use the shared action row', () => {
    // The sixth backward control, rendered by AdminSessionManager rather than
    // by StepActions. It said a bare "Back" while the other five named their
    // destination - and it is the step where the top/bottom confusion the
    // rename removes was still live.
    renderForm();
    selectType('interview');

    fireEvent.click(steps()[2]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Content & Details' }));

    expect(steps()[1]).toHaveAttribute('aria-current', 'step');
  });

  it('actually goes to the step it names, on every path', () => {
    renderForm();
    selectType('unmoderated');
    fireEvent.click(steps()[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Task List' }));
    expect(steps()[2]).toHaveAttribute('aria-current', 'step');

    // And from a step whose previous is not the one before last, on the other
    // authoring path - the destination is as unpinned as the label was.
    fireEvent.click(steps()[0]);
    selectNativeSurvey();
    fireEvent.click(steps()[2]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Content & Details' }));
    expect(steps()[1]).toHaveAttribute('aria-current', 'step');

    fireEvent.click(steps()[2]);
    fireEvent.click(steps()[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Questions' }));
    expect(steps()[2]).toHaveAttribute('aria-current', 'step');
  });

  it('calls the way out of the form Exit, not Back', () => {
    renderForm();

    expect(screen.getByRole('button', { name: /Exit to dashboard/i })).toBeInTheDocument();
    // The old label said "Back" three inches above a control that also said
    // "Back" and only moved one step. Pinned so it cannot come back.
    expect(screen.queryByRole('button', { name: /Back to Admin Dashboard/i })).not.toBeInTheDocument();
  });
});

describe('exiting the form', () => {
  it('leaves straight away when nothing has been typed', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    expect(screen.getByText('Admin dashboard')).toBeInTheDocument();
  });

  it('asks before discarding work, and stays put when the answer is no', () => {
    renderForm();
    typeInto(/Title/i, 'Half a study');

    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    expect(screen.getByText(/have not been saved/i)).toBeInTheDocument();
    expect(screen.queryByText('Admin dashboard')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Stay on this form/i }));

    expect(screen.queryByText(/have not been saved/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Admin dashboard')).not.toBeInTheDocument();
    // And the work is still there, which is the whole point of asking.
    expect(screen.getByLabelText(/Title/i)).toHaveValue('Half a study');
  });

  it('leaves when the answer is yes', () => {
    renderForm();
    typeInto(/Title/i, 'Half a study');

    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));
    fireEvent.click(screen.getByRole('button', { name: /Discard and leave/i }));

    expect(screen.getByText('Admin dashboard')).toBeInTheDocument();
  });

  it('asks nothing when an edit is closed without being touched', async () => {
    // The edit branch of the unsaved-work check had no test at all. Made
    // unconditional, every exit from an edit form - including this one -
    // would demand a confirmation, because the create baseline is the blank
    // first render and an edit overwrites it on load.
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-3',
      title: 'An untouched study',
      type: 'poll',
      status: 'draft',
      purpose_one_liner: 'Understand how people read the dashboard',
      external_link_optional: 'https://survey.test/one',
      participant_type_required: 'any',
    } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-3/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
          <Route path="/admin" element={<div>Admin dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByDisplayValue('An untouched study');

    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    expect(screen.getByText('Admin dashboard')).toBeInTheDocument();
  });

  it('asks before discarding an edit whose opportunity could not be loaded', async () => {
    // The load failed, so there is no server baseline - and the form renders
    // fully editable behind an inline banner anyway. The edit-mode dirty check
    // returns a flat false without a baseline, so this control used to walk an
    // author straight out of a form they had just filled in.
    vi.mocked(getOpportunity).mockRejectedValue(new Error('boom'));

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-4/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
          <Route path="/admin" element={<div>Admin dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByText(/Failed to load opportunity/i);

    typeInto(/^Title/i, 'Typed over a form that never loaded');
    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    expect(screen.getByText(/have not been saved/i)).toBeInTheDocument();
    expect(screen.queryByText('Admin dashboard')).not.toBeInTheDocument();
  });

  it('says nothing about unsaved work once the save has succeeded', async () => {
    vi.mocked(createOpportunity).mockResolvedValue({ id: 'opp-new' } as never);
    renderForm();
    selectType('question');
    fillBasics();
    fireEvent.click(steps()[2]);
    fireEvent.change(screen.getByLabelText(/External Link/i), {
      target: { value: 'https://survey.test/one' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Opportunity/i }));

    // The form stays on screen for a second or two after a create, showing its
    // success banner, before navigating itself. Clicking Exit in that window
    // must not claim the work is unsaved - it is saved, and a confirmation
    // that cries wolf is the one people learn to click through.
    // A create defaults to draft, so the banner is the draft warning - which
    // is still a save that succeeded.
    await screen.findByText(/created as DRAFT/i);
    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    expect(screen.queryByText(/have not been saved/i)).not.toBeInTheDocument();
  });

  /**
   * Create a test/interview and stop, which is a real resting state: this type
   * returns from its create WITHOUT navigating, because the session manager
   * owns both the save and the navigation away. So the form is on screen with
   * everything in it already stored.
   */
  const createAnInterview = async () => {
    vi.mocked(createOpportunity).mockResolvedValue({ id: 'opp-new' } as never);
    renderForm();
    selectType('interview');
    fillBasics();
    typeInto(/Meeting Location/i, 'Zoom');
    fireEvent.click(steps()[2]);
    fireEvent.click(screen.getByRole('button', { name: /save the opportunity/i }));
    await vi.waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalled());
  };

  it('lets a saved interview be left without a word', async () => {
    await createAnInterview();

    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    // The half that stops the confirmation crying wolf. Without the create
    // rebaselining what it sent, this form reads dirty forever - and a dialog
    // that always appears is the one people learn to click through.
    expect(screen.getByText('Admin dashboard')).toBeInTheDocument();
  });

  it('counts time slots that have not been saved, which live outside the form object', async () => {
    // Sessions are held in their own state, not in `formData`, so the object
    // comparison cannot see them.
    //
    // Asserted on a SAVED interview, deliberately. Before the save, the typing
    // on step 1 already makes the form dirty and the answer comes back true
    // without the sessions being consulted at all - a fixture that is dirty
    // either way proves nothing about the clause under test. The test above
    // pins that this same state is otherwise clean.
    await createAnInterview();

    fireEvent.click(screen.getByRole('button', { name: /lay out a time slot/i }));
    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    expect(screen.getByText(/have not been saved/i)).toBeInTheDocument();
    expect(screen.queryByText('Admin dashboard')).not.toBeInTheDocument();
  });

  it('goes home, and says so, on the participant-facing form', () => {
    // `allowUserSubmission` renders the same page for a non-admin, where the
    // way out is the home page rather than the admin dashboard. Neither the
    // label nor the destination had any test.
    render(
      <MemoryRouter initialEntries={['/submit']}>
        <Routes>
          <Route path="/submit" element={<OpportunityForm allowUserSubmission />} />
          <Route path="/" element={<div>Home page</div>} />
          <Route path="/admin" element={<div>Admin dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: /Exit to dashboard/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Exit to home/i }));

    expect(screen.getByText('Home page')).toBeInTheDocument();
  });

  it('notices a change to authored content, not only to the fields on step 1', () => {
    renderForm();
    selectType('unmoderated');
    fireEvent.click(steps()[2]);
    fireEvent.click(screen.getByRole('button', { name: /Add task/i }));

    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    // The dirty check compares the whole form object rather than a hand-written
    // list of fields. A list is what hid the Save button from an author who had
    // rewritten their tasks, twice.
    expect(screen.getByText(/have not been saved/i)).toBeInTheDocument();
  });
});
