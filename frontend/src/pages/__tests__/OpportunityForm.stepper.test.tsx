import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, updateOpportunity } from '../../api/client';

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
 * Reports the backward- and forward-navigation props it was handed, so the
 * page's wiring can be asserted here while the control's own rendering is
 * asserted where the real component is rendered, in
 * `AdminSessionManager.render.test.tsx`. Stubbed to null, this step's controls
 * were invisible to every test - which is how the backward one stayed a bare
 * "Back" while the other five were renamed, and it is also why C3 could add a
 * forward one here (`onContinue`/`onContinueLabel`) with nothing to walk the
 * sessions path forward until this stub grew a button for it. `onOpportunitySave`
 * and `onNavigate` are gone from the real component - Review commits for every
 * type now - so this stub no longer wires anything to them.
 */
vi.mock('../../components/AdminSessionManager', () => ({
  default: ({
    onBack,
    onBackLabel,
    onContinue,
    onContinueLabel,
    onSessionsChange
  }: {
    onBack?: () => void;
    onBackLabel?: string;
    onContinue?: () => void;
    onContinueLabel?: string;
    onSessionsChange?: (sessions: unknown[]) => void;
  }) => (
    <>
      <button type="button" onClick={onContinue}>
        {onContinueLabel ? `Continue: ${onContinueLabel}` : 'sessions: no forward control'}
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

vi.mock('../../api/firsthand-studies', async (importActual) => ({
  ...(await importActual<typeof import('../../api/firsthand-studies')>()),
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

    // No type chosen is a REACHABLE state with only three steps - Basic
    // Information, Content & Details and Review - and the numbering has to be
    // honest about it rather than promising a fourth.
    expect(steps().map((step) => step.textContent)).toEqual([
      expect.stringContaining('Step 1 of 3'),
      expect.stringContaining('Step 2 of 3'),
      expect.stringContaining('Step 3 of 3'),
    ]);

    selectType('unmoderated');
    expect(steps().map((step) => step.textContent)).toEqual([
      expect.stringContaining('Step 1 of 5'),
      expect.stringContaining('Step 2 of 5'),
      expect.stringContaining('Step 3 of 5'),
      expect.stringContaining('Step 4 of 5'),
      expect.stringContaining('Step 5 of 5'),
    ]);

    // An external poll authors no study, so it has no Consent step and stops
    // at four - and step 4 of 4 and step 4 of 5 are both real sentences this
    // strip has to be able to say, for Review on two different shapes.
    selectType('poll');
    expect(steps().map((step) => step.textContent)).toEqual([
      expect.stringContaining('Step 1 of 4'),
      expect.stringContaining('Step 2 of 4'),
      expect.stringContaining('Step 3 of 4'),
      expect.stringContaining('Step 4 of 4'),
    ]);
  });

  it("reads step IDENTITY rather than position, so Review's id (5) still reports its true position on shapes shorter than five", () => {
    // On the two shapes that author a study, id === index + 1 for every step
    // including Review (id 5, index 4) - a component that read POSITION where
    // it should read IDENTITY would behave identically on those and only show
    // the mistake on a shorter shape.
    //
    // No type chosen is the SHORTEST shape that still reaches Review: [1, 2,
    // 5], length 3 - Review sits at index 2 and reads "Step 3 of 3" despite
    // carrying id 5.
    renderForm();

    const blankSteps = steps();
    expect(blankSteps).toHaveLength(3);

    fireEvent.click(blankSteps[1]); // Content & Details

    /*
     * Reached by clicking the TILE, not the forward control, and that is a
     * statement about the form rather than a convenience.
     *
     * With no type chosen the forward control on step 2 reads a bare
     * "Continue" and refuses the move, sending the author to the type field -
     * so there is no "Continue: Review" here to press. Asserted, because the
     * first version of this test pressed it and the label existed: the control
     * named Review while going to step 1, which is precisely the lying label
     * C3 removed from this row.
     */
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Continue: Review' })
    ).not.toBeInTheDocument();

    fireEvent.click(blankSteps[2]); // Review, directly

    const blankOnReview = steps();
    expect(blankOnReview).toHaveLength(3);
    expect(blankOnReview[2]).toHaveTextContent('Step 3 of 3');
    expect(blankOnReview[2]).toHaveTextContent('Review');
    expect(blankOnReview[2]).toHaveAttribute('aria-current', 'step');

    // An external poll is one step longer - [1, 2, 3, 5], length 4 - so
    // Review's id (5) is one past what THIS shape's length would suggest too,
    // at a different position than the case above.
    // Review's backward control names the step BEFORE it in this shape, which
    // with no type chosen is Content & Details rather than the type-dependent
    // step - asserted rather than assumed, because it is the label that would
    // be wrong if the control read a fixed number instead of the list.
    expect(
      screen.getByRole('button', { name: 'Previous: Content & Details' })
    ).toBeInTheDocument();
    fireEvent.click(steps()[0]);
    selectType('poll');

    const beforeReview = steps();
    expect(beforeReview).toHaveLength(4);

    fireEvent.click(beforeReview[2]); // External Link
    fireEvent.click(screen.getByRole('button', { name: 'Continue: Review' }));

    const onReview = steps();
    expect(onReview).toHaveLength(4);
    expect(onReview[3]).toHaveTextContent('Step 4 of 4');
    expect(onReview[3]).toHaveTextContent('Review');
    expect(onReview[3]).toHaveAttribute('aria-current', 'step');
  });

  it('opens a blank form with one current step and the rest not started', () => {
    renderForm();
    selectType('unmoderated');

    const [one, two, three, four, five] = steps();
    expect(one).toHaveTextContent('Current step');
    expect(two).toHaveTextContent('Not started');
    expect(three).toHaveTextContent('Not started');
    expect(four).toHaveTextContent('Not started');
    // Review, unasserted here before: a blank form has decided nothing about
    // it either, and it must read Not started rather than defaulting to some
    // other word because it is also the step that commits.
    expect(five).toHaveTextContent('Review');
    expect(five).toHaveTextContent('Not started');
    // Not "Completed": nothing has been decided about steps 2 to 5, and the
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
      null,
    ]);
  });

  it('announces the step that was opened, naming it and its state', () => {
    renderForm();
    selectType('unmoderated');

    const region = screen.getByRole('status');
    fireEvent.click(steps()[2]);
    expect(region).toHaveTextContent('Step 3 of 5: Task List. Current step.');

    fireEvent.click(steps()[0]);
    // Announces the step it ARRIVED at, not the one it left, and reports the
    // state that step is actually in.
    expect(region).toHaveTextContent('Step 1 of 5: Basic Information. Needs attention.');
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

    /*
     * WAIT FOR THE THING BEING ASSERTED, not for a neighbour of it.
     *
     * This test used to stop at `findByDisplayValue` and then read the strip
     * immediately, and it reddened `main` once: the title appearing means
     * `setFormData` has run, and the effect that marks an edited opportunity's
     * steps VISITED is a separate pass. On a loaded CI runner the assertion
     * landed between the two and read "Not started", which is exactly what this
     * test exists to catch - so the failure was indistinguishable from the real
     * defect.
     *
     * Waiting on the visited state makes the precondition the same fact the
     * assertions below are about. It cannot mask the real defect: if the effect
     * never ran, this times out and fails.
     */
    await waitFor(() => expect(steps()[1]).toHaveTextContent('Completed'));

    // Its content is on the server; calling steps 2, 3 and Review "Not
    // started" would be false. Step 1 is the one being looked at, so it reads
    // Current.
    const [one, two, three, four] = steps();
    expect(one).toHaveTextContent('Current step');
    expect(two).toHaveTextContent('Completed');
    expect(three).toHaveTextContent('Completed');
    // Review too, previously left unasserted here: the edit-mode "mark
    // everything visited" effect walks the WHOLE shape from `getTabsForType`,
    // which now includes Review, and a version that stopped one step short of
    // it would have passed this test while still leaving Review "Not started"
    // under an author's own content.
    expect(four).toHaveTextContent('Review');
    expect(four).toHaveTextContent('Completed');
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

    // Straight from step 1 to Consent - no longer the last step, but still
    // reached with steps 2 and 3 UNVISITED, which is the only state the
    // reported-errors map is load-bearing for - and on to Review, the step
    // that now carries the submit control AND the Status choice (#111).
    fireEvent.click(steps()[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue: Review' }));
    // Review's Status control has no `<label htmlFor="status">` - only an
    // `<h3>Status</h3>` heading - so it is found by role, scoped to Review,
    // rather than by name.
    fireEvent.change(within(screen.getByTestId('review-step')).getByRole('combobox'), {
      target: { value: 'published' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Create study/i }));

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

    // Waited for, not read once. The title field appears on the first render
    // after the opportunity resolves, but the step strip's completion state is
    // derived from form data that settles in a LATER commit - so reading the
    // strip immediately is a race that this machine wins and a loaded CI
    // runner loses. It turned main red the first time these two branches were
    // in the same tree, having passed on both of them separately.
    //
    // This does not weaken the assertion: a regression that never marks
    // Consent complete times out here and fails exactly as it did before. The
    // rest are read after the wait, when the strip has settled.
    await waitFor(() => expect(steps()[3]).toHaveTextContent('Completed'));

    const rendered = steps();
    expect(rendered).toHaveLength(5);
    expect(rendered[3]).toHaveTextContent('Step 4 of 5');
    expect(rendered[2]).toHaveTextContent('Completed');
    // Review, previously left out of this test entirely: the fifth slot is
    // exactly the one an id-keyed (rather than key-keyed) history tracker
    // could get right for four steps and wrong for the fifth, since Review's
    // id (5) matches neither the native nor the external shape's step 4.
    expect(rendered[4]).toHaveTextContent('Step 5 of 5');
    expect(rendered[4]).toHaveTextContent('Review');
    expect(rendered[4]).toHaveTextContent('Completed');
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

    expect(steps()).toHaveLength(4);
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
    expect(announced).toContain('Step 2 of 5');

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
    // does not, and that is the half that strands. The submit control lives
    // on Review now, one step further on than Consent.
    fireEvent.click(screen.getByRole('button', { name: 'Continue: Review' }));
    fireEvent.click(screen.getByRole('button', { name: /Create study/i }));
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

  it("names the step Review's own control returns to, and proves it on two different paths", () => {
    // An independent mutation pass on this plan's previous step found 18
    // survivors that collapsed to one finding: everything had only ever been
    // proven for the first tile. Review sits after every shape now, so its
    // own backward control needs checking on two shapes with two different
    // previous steps, not one - a version that only ever checked the
    // authoring path could not tell Review's previous step apart from a
    // hard-coded "Consent".
    renderForm();
    selectType('unmoderated');
    fillBasics();

    fireEvent.click(steps()[3]); // Consent
    fireEvent.click(screen.getByRole('button', { name: 'Continue: Review' }));
    expect(
      screen.getByRole('button', { name: 'Previous: Consent' })
    ).toBeInTheDocument();

    // A poll authors no study, so it has no Consent step at all - Review's
    // previous here is External Link.
    fireEvent.click(steps()[0]);
    selectType('poll');
    fireEvent.click(steps()[2]); // External Link
    fireEvent.click(screen.getByRole('button', { name: 'Continue: Review' }));
    expect(
      screen.getByRole('button', { name: 'Previous: External Link' })
    ).toBeInTheDocument();
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
    await screen.findByText(/Failed to load study/i);

    typeInto(/^Title/i, 'Typed over a form that never loaded');
    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    expect(screen.getByText(/have not been saved/i)).toBeInTheDocument();
    expect(screen.queryByText('Admin dashboard')).not.toBeInTheDocument();
  });

  it('says nothing about unsaved work once the save has succeeded', async () => {
    // A CREATE no longer leaves the form mounted to ask this of. Review
    // commits for every type now and its `onSubmit` calls `handleSubmit()`
    // with no `skipNavigation`, so a successful create navigates away the
    // instant the request resolves - there is no window left in which Exit
    // could be clicked against a freshly-created, still-mounted form, and no
    // "created as DRAFT" banner ever renders here: that message travels to
    // `/admin` in the navigation state now, for THAT page to show, not this
    // one. An EDIT is the one path left where a successful save keeps the
    // form on screen, and it is the one this assertion has always actually
    // been about: does the save rebaseline what it sent, or does the form
    // read dirty forever afterwards.
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-5',
      title: 'A study to be re-saved',
      type: 'poll',
      status: 'draft',
      purpose_one_liner: 'Understand how people read the dashboard',
      external_link_optional: 'https://survey.test/one',
      participant_type_required: 'any',
    } as never);
    vi.mocked(updateOpportunity).mockResolvedValue({ id: 'opp-5' } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-5/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
          <Route path="/admin" element={<div>Admin dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByDisplayValue('A study to be re-saved');

    typeInto(/^Title/i, 'A study to be re-saved, revised');
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await vi.waitFor(() => expect(vi.mocked(updateOpportunity)).toHaveBeenCalled());
    // Re-baselined against the server's answer, which is what makes the save
    // itself the thing under test rather than "nothing was ever touched".
    await screen.findByText(/saved as DRAFT|saved successfully/i);

    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    expect(screen.queryByText(/have not been saved/i)).not.toBeInTheDocument();
    // And it actually left - a confirmation that silently no-ops is just as
    // wrong as one that cries wolf.
    expect(screen.getByText('Admin dashboard')).toBeInTheDocument();
  });

  /**
   * Edit an interview and save a real change, which is what leaves a saved
   * entity mounted now.
   *
   * This used to be a CREATE that stopped without navigating, because the
   * session manager owned both the save and the navigation away for exactly
   * test and interview. That branch is gone: Review commits for every type,
   * its `onSubmit` calls `handleSubmit()` with no `skipNavigation`, and a
   * successful CREATE now navigates away the instant the request resolves -
   * for every type, not just the other four. There is no "created and
   * stayed" state left to test from a create at all. An edit save is the one
   * path still on screen afterwards, and it exercises the equivalent
   * rebaseline: `loadOpportunity()` re-reads the server and refreshes
   * `originalFormData`, the way `openingFormData.current = formData` used to
   * for a create.
   */
  const editAndSaveAnInterview = async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      id: 'opp-interview-1',
      title: 'An interview about the export flow',
      type: 'interview',
      status: 'draft',
      purpose_one_liner: 'Understand how people book time',
      meeting_location_optional: 'Zoom',
      default_duration_minutes: 30,
      participant_type_required: 'any',
    } as never);
    vi.mocked(updateOpportunity).mockResolvedValue({ id: 'opp-interview-1' } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-interview-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
          <Route path="/admin" element={<div>Admin dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );
    // Test and interview land on Session Management the moment the load
    // resolves, so wait for THAT step rather than for a Basic Information
    // field. The title input is not on screen at this point, and waiting for
    // it used to work only because the landing step was applied by an effect
    // one render AFTER the content appeared - the same window that let an
    // author's own click be undone. Nothing renders step 1 with this data any
    // more, so the wait has to name the step the author actually lands on.
    await screen.findByRole('navigation', { name: 'Form steps' });
    await strip().findByRole('button', { name: /Session Management/i });

    // Back to Basic Information to make a real, savable change.
    fireEvent.click(steps()[0]);
    await screen.findByDisplayValue('An interview about the export flow');
    typeInto(/^Title/i, 'An interview about the export flow, revised');

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await vi.waitFor(() => expect(vi.mocked(updateOpportunity)).toHaveBeenCalled());
    await screen.findByText(/saved as DRAFT|saved successfully/i);
  };

  it('lets a saved interview be left without a word', async () => {
    await editAndSaveAnInterview();

    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    // The half that stops the confirmation crying wolf. Without the save
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
    await editAndSaveAnInterview();

    fireEvent.click(steps()[2]); // Session Management
    fireEvent.click(screen.getByRole('button', { name: /lay out a time slot/i }));
    fireEvent.click(screen.getByRole('button', { name: /Exit to dashboard/i }));

    expect(screen.getByText(/have not been saved/i)).toBeInTheDocument();
    expect(screen.queryByText('Admin dashboard')).not.toBeInTheDocument();
  });

  /*
   * Removed with #46: 'goes home, and says so, on the participant-facing form'.
   *
   * It was the only caller anywhere that passed `allowUserSubmission`, and it
   * existed solely to cover that prop's "Exit to home" branch. The prop is
   * gone - the page that set it was unrouted and unimported - so the test was
   * covering a branch that no longer exists rather than any behaviour a user
   * can reach. The admin destination it contrasted against is still pinned by
   * 'lets a saved interview be left without a word', above.
   */

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

/**
 * Which step an EXISTING opportunity opens on.
 *
 * Not the same question as "can the author walk to that step", which
 * `OpportunityForm.review.test.tsx` already covers by clicking Continue
 * through a create. This is the edit-load landing: the author opens something
 * that already exists and the form chooses a step for them.
 *
 * Untested until now, on either side of the fix. The rule lived in a `useEffect`
 * keyed on the loaded values, and moving it into `loadOpportunity` deliberately
 * preserved it - but nothing in the suite would have said so if it had not.
 * Changing the landing to `? 1 : 1`, so tests and interviews open at the
 * beginning like everything else, passed all 110 files and 1472 tests.
 *
 * Asserted on `aria-current="step"` rather than on a field that happens to
 * render, because the step a field belongs to is a proxy and the proxy is what
 * went wrong before: the old test waited for a Basic Information input, which
 * for an interview only appeared during the window the landing effect had not
 * closed yet.
 */
describe('opening an opportunity that already exists', () => {
  const openExisting = async (type: string, id: string) => {
    vi.mocked(getOpportunity).mockResolvedValue({
      id,
      title: 'Something already written',
      type,
      status: 'draft',
      purpose_one_liner: 'Understand how people book time',
      meeting_location_optional: 'Zoom',
      default_duration_minutes: 30,
      participant_type_required: 'any',
    } as never);

    render(
      <MemoryRouter initialEntries={[`/admin/opportunities/${id}/edit`]}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByRole('navigation', { name: 'Form steps' });
  };

  const standingOn = async () =>
    (await strip().findByRole('button', { current: 'step' })).textContent;

  // The case the rewrite set out to keep: these two are edited to manage their
  // sessions, so that is where their authors are put.
  it.each(['interview', 'test'])(
    'lands the author on Session Management for a %s',
    async (type) => {
      await openExisting(type, `opp-${type}-landing`);

      await waitFor(async () =>
        expect(await standingOn()).toMatch(/Session Management/)
      );
    }
  );

  // The other half of the same rule, and the half that makes the assertion
  // above mean something: without it, a landing that sent EVERY type to
  // Session Management would pass.
  it.each(['survey', 'poll', 'unmoderated'])(
    'lands the author at the beginning for a %s',
    async (type) => {
      await openExisting(type, `opp-${type}-landing`);

      await waitFor(async () =>
        expect(await standingOn()).toMatch(/Basic Information/)
      );
    }
  );
});
