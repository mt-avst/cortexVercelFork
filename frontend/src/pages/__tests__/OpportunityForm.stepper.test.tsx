import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, updateOpportunity } from '../../api/client';
import { chooseStudyType } from './helpers/study-type-picker';
import { setStatus as reviewSetStatus } from './helpers/review-status';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false,
  }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false }),
}));

/**
 * A slot time for the `AdminSessionManager` stub below, relative to the real
 * clock rather than a fixed 2030 date - the test that reads it is only about
 * whether an unsaved slot marks the form dirty, not whether the slot is
 * upcoming, but a literal future year is a #164-shaped trap waiting to
 * happen regardless. `vi.hoisted` because the `vi.mock` factory below runs
 * before this module's own top-level code.
 */
const STUB_SESSION_TIME = vi.hoisted(() => {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
  };
});

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
            { id: 'temp-session-1', start_time: STUB_SESSION_TIME.start, end_time: STUB_SESSION_TIME.end }
          ])
        }
      >
        stub: lay out a time slot
      </button>
    </>
  )
}));

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

const selectType = (value: string, delivery: 'native' | 'external' = 'external') =>
  chooseStudyType(value, delivery);

const typeInto = (label: RegExp, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

/** The native survey path: Questions on step 3, Consent on step 4. */
const selectNativeSurvey = () => {
  selectType('survey', 'native');
};

// Title and Purpose live on the Basic Info step now, split out of the Study
// type step (D1/D3 reshape) - so filling them means navigating there first via
// the strip, which leaves Basic Info (step 2) the current step afterwards.
const fillBasics = () => {
  fireEvent.click(steps()[1]);
  typeInto(/^Title/i, 'A study of the export flow');
  typeInto(/Purpose/i, 'Find out where people give up on exporting');
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the step strip reports progress, not just position', () => {
  it('numbers every step against the real total for the shape on screen', () => {
    renderForm();

    // The strip is locked at type-choice (WZ-18): with no type chosen it does
    // not render at all, so the count it shows is the shape's FIXED total from
    // the moment it first appears rather than one that grows as the author
    // picks a type. That "no strip before a type" behaviour is pinned in
    // OpportunityForm.type-gate.test.tsx; here the concern is the numbering
    // once the strip is on screen.
    // The D1/D3 spine, split into Study type and Basic Info: study type, basic
    // info, audience, experience, consent, review = six steps for a recorded
    // study.
    selectType('unmoderated');
    expect(steps().map((step) => step.textContent)).toEqual([
      expect.stringContaining('Step 1 of 6'),
      expect.stringContaining('Step 2 of 6'),
      expect.stringContaining('Step 3 of 6'),
      expect.stringContaining('Step 4 of 6'),
      expect.stringContaining('Step 5 of 6'),
      expect.stringContaining('Step 6 of 6'),
    ]);

    // An external poll is FIVE steps (D3): study type, basic info, audience,
    // your link, review - no Consent step, its affirmation folds into the link
    // (row 13).
    selectType('poll');
    expect(steps().map((step) => step.textContent)).toEqual([
      expect.stringContaining('Step 1 of 5'),
      expect.stringContaining('Step 2 of 5'),
      expect.stringContaining('Step 3 of 5'),
      expect.stringContaining('Step 4 of 5'),
      expect.stringContaining('Step 5 of 5'),
    ]);
  });

  it('carries an external poll to a fifth Review step, with no Consent step', () => {
    // D3: an external poll is [study type, basic info, audience, your link,
    // review] - five steps, no Consent step (row 13 folds its affirmation into
    // the link). Review is the fifth step, and its backward control names the
    // link before it.
    renderForm();
    selectType('poll');

    const beforeReview = steps();
    expect(beforeReview).toHaveLength(5);
    expect(beforeReview[1]).toHaveTextContent('Basic Info');
    expect(beforeReview[2]).toHaveTextContent('Audience');
    expect(beforeReview[3]).toHaveTextContent('Your link');
    expect(beforeReview.some((step) => step.textContent?.includes('Consent'))).toBe(false);

    fireEvent.click(beforeReview[2]); // Audience
    fireEvent.click(screen.getByRole('button', { name: 'Continue: Your link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue: Review' }));

    const onReview = steps();
    expect(onReview).toHaveLength(5);
    expect(onReview[4]).toHaveTextContent('Step 5 of 5');
    expect(onReview[4]).toHaveTextContent('Review');
    expect(onReview[4]).toHaveAttribute('aria-current', 'step');
    expect(
      screen.getByRole('button', { name: 'Previous: Your link' })
    ).toBeInTheDocument();
  });

  it('opens a blank form with one current step and the rest not started', () => {
    renderForm();
    selectType('unmoderated');

    const [one, two, three, four, five, six] = steps();
    expect(one).toHaveTextContent('Current step');
    expect(two).toHaveTextContent('Basic Info');
    expect(two).toHaveTextContent('Not started');
    expect(three).toHaveTextContent('Audience');
    expect(three).toHaveTextContent('Not started');
    expect(four).toHaveTextContent('Task List');
    expect(four).toHaveTextContent('Not started');
    expect(five).toHaveTextContent('Consent');
    expect(five).toHaveTextContent('Not started');
    // Review must read Not started rather than defaulting to another word,
    // because it is also the step that commits.
    expect(six).toHaveTextContent('Review');
    expect(six).toHaveTextContent('Not started');
    // Not "Completed": nothing has been decided about steps 2 to 6, and the
    // validator has nothing to object to on any of them yet.
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('flags a step the author walked past leaving it invalid, and clears it when filled - with no save', () => {
    renderForm();
    selectType('unmoderated');

    // A step reads Needs attention only once it has actually been VISITED -
    // stood on and left - not merely skipped over, so Basic Info is visited
    // first (leaving it with no title) and then walked past, straight to Task
    // List. Reachable because the strip is clickable, which is also why this
    // does NOT go through the Continue button that would have refused and
    // reported it.
    fireEvent.click(steps()[1]); // Basic Info, left with no title
    fireEvent.click(steps()[3]); // Task List

    expect(steps()[1]).toHaveTextContent('Needs attention');
    expect(steps()[3]).toHaveTextContent('Current step');

    fireEvent.click(steps()[1]);
    typeInto(/Title/i, 'A study of the export flow');
    typeInto(/Purpose/i, 'Find out where people give up on exporting');

    // Still on Basic Info, so it reads Current; the point is that the flag is
    // gone and nothing was saved to clear it.
    expect(steps()[1]).toHaveTextContent('Current step');
    expect(steps()[1]).not.toHaveTextContent('Needs attention');

    fireEvent.click(steps()[2]);
    expect(steps()[1]).toHaveTextContent('Completed');
  });

  it('does not lock a step behind an earlier one that needs attention', () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(steps()[1]); // Basic Info, left with no title
    fireEvent.click(steps()[4]); // Consent

    // Basic Info, not Study type, is the one left incomplete (no title yet).
    expect(steps()[1]).toHaveTextContent('Needs attention');
    // Forward navigation is information, not a gate - the author is standing on
    // a later step with an earlier one failing, and that is allowed.
    expect(steps()[4]).toHaveTextContent('Current step');
    expect(screen.getByRole('heading', { name: /Consent/i })).toBeInTheDocument();
  });

  it('marks the current step with aria-current and no other step', () => {
    renderForm();
    selectType('unmoderated');
    fireEvent.click(steps()[2]); // Audience

    expect(steps().map((step) => step.getAttribute('aria-current'))).toEqual([
      null,
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
    // Visit Basic Info and leave it with no title, so returning to it reads
    // Needs attention rather than Not started.
    fireEvent.click(steps()[1]);
    fireEvent.click(steps()[3]);
    expect(region).toHaveTextContent('Step 4 of 6: Task List. Current step.');

    fireEvent.click(steps()[1]);
    // Announces the step it ARRIVED at, not the one it left, and reports the
    // state that step is actually in.
    expect(region).toHaveTextContent('Step 2 of 6: Basic Info. Needs attention.');
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

    // Study type - the landing step since D5 - carries no Title field any
    // more (that split onto Basic Info), so the strip itself, gated on a type
    // being set, is the anchor that data has loaded.
    await screen.findByRole('navigation', { name: 'Form steps' });

    /*
     * WAIT FOR THE THING BEING ASSERTED, not for a neighbour of it.
     *
     * This test used to stop at the title appearing and then read the strip
     * immediately, and it reddened `main` once: the title (or here, the strip)
     * appearing means `setFormData` has run, and the effect that marks an
     * edited opportunity's steps VISITED is a separate pass. On a loaded CI
     * runner the assertion landed between the two and read "Not started",
     * which is exactly what this test exists to catch - so the failure was
     * indistinguishable from the real defect.
     *
     * Waiting on the visited state makes the precondition the same fact the
     * assertions below are about. It cannot mask the real defect: if the effect
     * never ran, this times out and fails.
     */
    await waitFor(() => expect(steps()[1]).toHaveTextContent('Completed'));

    // An edited external poll is FIVE steps (D3): study type, basic info,
    // audience, your link, review. Its content is on the server; calling any
    // of steps 2 to 4 "Not started" would be false. Step 1 is the one being
    // looked at, so it reads Current.
    const [one, two, three, four, five] = steps();
    expect(steps()).toHaveLength(5);
    expect(one).toHaveTextContent('Current step');
    expect(two).toHaveTextContent('Basic Info');
    expect(two).toHaveTextContent('Completed');
    expect(three).toHaveTextContent('Audience');
    expect(three).toHaveTextContent('Completed');
    expect(four).toHaveTextContent('Your link');
    expect(four).toHaveTextContent('Completed');
    // Review (audit row 15) is deliberately the ONE step this "already walked"
    // seeding excludes: it is the check-answers screen itself, so it starts
    // "Not started" and becomes visited the ordinary way, by being left.
    expect(five).toHaveTextContent('Review');
    expect(five).toHaveTextContent('Not started');
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
    fillBasics(); // lands on Basic Info (step 2)

    // Step 3, then step 4 - so the step being marked Completed is one the
    // visit tracker has to have recorded by its own identity rather than by a
    // hard-coded first step.
    fireEvent.click(steps()[2]);
    fireEvent.click(steps()[3]);

    expect(steps()[2]).toHaveTextContent('Completed');
    expect(steps()[0]).toHaveTextContent('Completed');
    expect(steps()[4]).toHaveTextContent('Not started');
  });

  it('flags a LATER step, and only that step, from the live rules', () => {
    renderForm();
    selectType('unmoderated');
    fillBasics(); // lands on Basic Info (step 2)

    fireEvent.click(steps()[3]); // Task List
    fireEvent.click(screen.getByRole('button', { name: /Add task/i }));
    // A task with no wording is invalid under the same rules a save uses, and
    // it routes to step 4 - not step 1.
    fireEvent.click(steps()[4]); // Consent

    expect(steps()[3]).toHaveTextContent('Needs attention');
    expect(steps()[0]).not.toHaveTextContent('Needs attention');
    expect(steps()[1]).not.toHaveTextContent('Needs attention');
  });

  it('flags a later step the author has never opened, from a refused save', () => {
    renderForm();
    selectType('unmoderated');
    fillBasics(); // lands on Basic Info (step 2)

    // Straight from Basic Info to Review - reached with the middle steps
    // UNVISITED, which is the only state the reported-errors map is
    // load-bearing for. Review is the step that carries the submit control
    // AND the Status choice (#111), and the strip is clickable, so this jumps
    // there directly. Review is the sixth step on a recorded study since the
    // D1/D3 reshape.
    fireEvent.click(steps()[5]);
    reviewSetStatus('published');
    fireEvent.click(screen.getByRole('button', { name: /Create study/i }));

    // Publishing an unmoderated study with no tasks fails on step 4.
    expect(steps()[3]).toHaveTextContent('Needs attention');
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

    // Study type - the landing step since D5 - carries no Title field any
    // more, so the strip, gated on a type being set, is the load anchor.
    await screen.findByRole('navigation', { name: 'Form steps' });

    // Waited for, not read once. The strip appears on the first render after
    // the opportunity resolves, but the step strip's completion state is
    // derived from form data that settles in a LATER commit - so reading the
    // strip immediately is a race that this machine wins and a loaded CI
    // runner loses. It turned main red the first time these two branches were
    // in the same tree, having passed on both of them separately.
    //
    // This does not weaken the assertion: a regression that never marks
    // Consent complete times out here and fails exactly as it did before. The
    // rest are read after the wait, when the strip has settled.
    await waitFor(() => expect(steps()[4]).toHaveTextContent('Completed'));

    const rendered = steps();
    expect(rendered).toHaveLength(6);
    // Consent is step 5 on the native survey shape since the D1/D3 reshape
    // (study type, basic info, audience, questions, consent, review).
    expect(rendered[4]).toHaveTextContent('Consent');
    expect(rendered[4]).toHaveTextContent('Step 5 of 6');
    expect(rendered[3]).toHaveTextContent('Completed');
    // Review reads "Not started" rather than "Completed" (audit row 15): Review
    // is excluded from the "already walked" edit-mode seeding, so it is visited
    // the ordinary way, by actually being left.
    expect(rendered[5]).toHaveTextContent('Step 6 of 6');
    expect(rendered[5]).toHaveTextContent('Review');
    expect(rendered[5]).toHaveTextContent('Not started');
  });

  it('does not carry one step 3 history over to a different step 3', () => {
    renderForm();
    selectType('unmoderated');
    fillBasics(); // lands on Basic Info (step 2)

    fireEvent.click(steps()[2]); // Audience
    fireEvent.click(steps()[3]); // Task List
    fireEvent.click(steps()[0]); // Study type
    expect(steps()[2]).toHaveTextContent('Completed');
    expect(steps()[3]).toHaveTextContent('Completed');

    // Step 4 is now External Link, a step this author has never seen. Its id
    // is still 4, which is exactly why history cannot be held by id.
    selectType('poll');

    // Five steps (D3) - an external poll has no Consent step.
    expect(steps()).toHaveLength(5);
    expect(steps()[3]).toHaveTextContent('Your link');
    expect(steps()[3]).toHaveTextContent('Not started');

    // And Audience, which IS the same step either side of the change, keeps
    // what it had. Forgetting everything on a type change would clear the flag
    // above too, and would look from that assertion alone like the fix working.
    expect(steps()[2]).toHaveTextContent('Completed');
  });

  it('keeps the announcement quiet while the author types', () => {
    renderForm();
    selectType('unmoderated');
    fireEvent.click(steps()[2]); // Audience

    // Scoped to the visually-hidden strip announcer: the Audience step also
    // carries the screener's own role="status" alert, so an unscoped query is
    // ambiguous there.
    const region = screen
      .getAllByRole('status')
      .find((el) => el.classList.contains('visually-hidden')) as HTMLElement;
    const announced = region.textContent;
    expect(announced).toContain('Step 3 of 6');

    // Back onto Basic Info, which starts Needs attention with no title yet.
    fireEvent.click(steps()[1]);
    const onBasicInfo = region.textContent;

    // Typing flips Basic Info from Needs attention to Completed-eligible,
    // which re-renders the strip. The region must not re-announce: it reports
    // step CHANGES, not field edits.
    typeInto(/^Title/i, 'A study of the export flow');
    typeInto(/Purpose/i, 'Find out where people give up on exporting');

    expect(region.textContent).toBe(onBasicInfo);
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
    fillBasics(); // lands on Basic Info (step 2)

    fireEvent.click(steps()[3]); // Questions
    fireEvent.click(screen.getByRole('button', { name: /Add question/i }));

    // Through a REFUSED SAVE, so the error lands in the reported map and not
    // only in the live rules. The live rules re-evaluate against a form that
    // no longer holds any questions and clear themselves; the reported map
    // does not, and that is the half that strands. The submit control lives on
    // Review (the sixth step on a native survey since the D1/D3 reshape),
    // reached directly through the clickable strip.
    fireEvent.click(steps()[5]);
    fireEvent.click(screen.getByRole('button', { name: /Create study/i }));
    expect(steps()[3]).toHaveTextContent('Needs attention');

    // Switching delivery mode discards the questions and replaces step 4 with
    // External Link, which is optional on a draft and shows no error. Left
    // uncleared, the flag is a dead end: the badge says fix this and there is
    // nothing on the step to fix.
    fireEvent.click(steps()[0]);
    selectType('survey', 'external');

    expect(steps()[3]).toHaveTextContent('Your link');
    expect(steps()[3]).not.toHaveTextContent('Needs attention');
  });
});

describe('the two backward controls are named apart', () => {
  it('names the step the bottom control returns to', () => {
    renderForm();
    selectType('unmoderated');

    // Neither Study type nor Basic Info carries a backward control of its
    // own - the strip is the only way back to either - so the chain proper
    // starts at Audience, whose previous is Basic Info.
    fireEvent.click(steps()[2]);
    expect(
      screen.getByRole('button', { name: 'Previous: Basic Info' })
    ).toBeInTheDocument();

    // Named from the step list rather than from a number written at the call
    // site: the Consent step's previous is the Task List for an unmoderated
    // study and the Questions step for a native survey, and neither call site
    // says so itself.
    fireEvent.click(steps()[4]);
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

    fireEvent.click(steps()[3]);
    expect(
      screen.getByRole('button', { name: 'Previous: Audience' })
    ).toBeInTheDocument();

    fireEvent.click(steps()[4]);
    expect(
      screen.getByRole('button', { name: 'Previous: Questions' })
    ).toBeInTheDocument();
  });

  it('names it on the external-link path, which authors no study at all', () => {
    renderForm();
    selectType('question');

    fireEvent.click(steps()[3]);
    expect(
      screen.getByRole('button', { name: 'Previous: Audience' })
    ).toBeInTheDocument();
  });

  it('names it on the session path, which does not use the shared action row', () => {
    // The sixth backward control, rendered by AdminSessionManager rather than
    // by StepActions. It said a bare "Back" while the other five named their
    // destination - and it is the step where the top/bottom confusion the
    // rename removes was still live.
    renderForm();
    selectType('interview');

    fireEvent.click(steps()[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Audience' }));

    expect(steps()[2]).toHaveAttribute('aria-current', 'step');
  });

  it('actually goes to the step it names, on every path', () => {
    renderForm();
    selectType('unmoderated');
    fireEvent.click(steps()[4]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Task List' }));
    expect(steps()[3]).toHaveAttribute('aria-current', 'step');

    // And from a step whose previous is not the one before last, on the other
    // authoring path - the destination is as unpinned as the label was.
    fireEvent.click(steps()[0]);
    selectNativeSurvey();
    fireEvent.click(steps()[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Audience' }));
    expect(steps()[2]).toHaveAttribute('aria-current', 'step');

    fireEvent.click(steps()[3]);
    fireEvent.click(steps()[4]);
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Questions' }));
    expect(steps()[3]).toHaveAttribute('aria-current', 'step');
  });

  it("names the step Review's own control returns to, and proves the chain is list-derived on two different paths", () => {
    // The backward chain must read the step list, not a number at the call site.
    // Since the D1/D3 reshape the spine is study type -> basic info -> audience
    // -> experience -> consent -> review, so Review's previous is Consent, and
    // Consent's own previous is the EXPERIENCE body - Task List on the
    // recorded path and Questions on the native survey path. That per-path
    // difference is what a hard-coded chain could not reproduce, so the two
    // shapes are walked back through Review -> Consent -> experience ->
    // Audience.
    renderForm();
    selectType('unmoderated');
    fillBasics(); // lands on Basic Info (step 2)

    fireEvent.click(steps()[4]); // Consent
    fireEvent.click(screen.getByRole('button', { name: 'Continue: Review' }));
    expect(
      screen.getByRole('button', { name: 'Previous: Consent' })
    ).toBeInTheDocument();
    // Back onto Consent, whose own previous is the experience - Task List here.
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Consent' }));
    expect(
      screen.getByRole('button', { name: 'Previous: Task List' })
    ).toBeInTheDocument();
    // And the Task List's own previous is the Audience step.
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Task List' }));
    expect(
      screen.getByRole('button', { name: 'Previous: Audience' })
    ).toBeInTheDocument();

    // The native survey path has the same experience -> Consent -> Review tail,
    // but the experience is Questions, not Task List - the difference a
    // hard-coded chain could not reproduce.
    fireEvent.click(steps()[0]);
    selectNativeSurvey();
    fireEvent.click(steps()[4]); // Consent
    fireEvent.click(screen.getByRole('button', { name: 'Continue: Review' }));
    expect(
      screen.getByRole('button', { name: 'Previous: Consent' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Consent' }));
    expect(
      screen.getByRole('button', { name: 'Previous: Questions' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous: Questions' }));
    expect(
      screen.getByRole('button', { name: 'Previous: Audience' })
    ).toBeInTheDocument();
  });

  it('calls the way out of the form Exit, not Back', () => {
    renderForm();

    expect(screen.getByRole('button', { name: /^Exit to Create & Manage$/i })).toBeInTheDocument();
    // The old label said "Back" three inches above a control that also said
    // "Back" and only moved one step. Pinned so it cannot come back.
    expect(screen.queryByRole('button', { name: /Back to Admin Dashboard/i })).not.toBeInTheDocument();
  });
});

describe('exiting the form', () => {
  it('leaves straight away when nothing has been typed', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /^Exit to Create & Manage$/i }));

    expect(screen.getByText('Admin dashboard')).toBeInTheDocument();
  });

  it('asks before discarding work, and stays put when the answer is no', () => {
    renderForm();
    // Title lives on Basic Info now, reachable only once a type is chosen.
    selectType('poll');
    fireEvent.click(steps()[1]);
    typeInto(/Title/i, 'Half a study');

    fireEvent.click(screen.getByRole('button', { name: /^Exit to Create & Manage$/i }));

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
    selectType('poll');
    fireEvent.click(steps()[1]);
    typeInto(/Title/i, 'Half a study');

    fireEvent.click(screen.getByRole('button', { name: /^Exit to Create & Manage$/i }));
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
    // Study type - the landing step since D5 - carries no Title field any
    // more, so the strip is the load anchor.
    await screen.findByRole('navigation', { name: 'Form steps' });

    fireEvent.click(screen.getByRole('button', { name: /^Exit to Create & Manage$/i }));

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

    // No baseline means no type either, so Basic Info (where Title lives) is
    // reached the ordinary way: choose a type, then walk to it.
    selectType('poll');
    fireEvent.click(steps()[1]);
    typeInto(/^Title/i, 'Typed over a form that never loaded');
    fireEvent.click(screen.getByRole('button', { name: /^Exit to Create & Manage$/i }));

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
    // Study type - the landing step since D5 - carries no Title field any
    // more, so the strip is the load anchor; Basic Info is where Title is.
    await screen.findByRole('navigation', { name: 'Form steps' });
    fireEvent.click(steps()[1]);
    await screen.findByDisplayValue('A study to be re-saved');

    typeInto(/^Title/i, 'A study to be re-saved, revised');
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await vi.waitFor(() => expect(vi.mocked(updateOpportunity)).toHaveBeenCalled());
    // Re-baselined against the server's answer, which is what makes the save
    // itself the thing under test rather than "nothing was ever touched".
    await screen.findByText(/saved as DRAFT|saved successfully/i);

    fireEvent.click(screen.getByRole('button', { name: /^Exit to Create & Manage$/i }));

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
    // D5: every shape, interview included, lands on Study type (step 1) now -
    // this used to wait for the Session Management step instead, because that
    // was where an interview opened. Study type carries no Title field any
    // more (that split onto Basic Info), so the strip is the load anchor and
    // Basic Info is where the change this helper needs is made.
    await screen.findByRole('navigation', { name: 'Form steps' });
    fireEvent.click(steps()[1]);
    await screen.findByDisplayValue('An interview about the export flow');
    typeInto(/^Title/i, 'An interview about the export flow, revised');

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await vi.waitFor(() => expect(vi.mocked(updateOpportunity)).toHaveBeenCalled());
    await screen.findByText(/saved as DRAFT|saved successfully/i);
  };

  it('lets a saved interview be left without a word', async () => {
    await editAndSaveAnInterview();

    fireEvent.click(screen.getByRole('button', { name: /^Exit to Create & Manage$/i }));

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

    fireEvent.click(steps()[3]); // Session Management
    fireEvent.click(screen.getByRole('button', { name: /lay out a time slot/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Exit to Create & Manage$/i }));

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
    fireEvent.click(steps()[3]); // Task List
    fireEvent.click(screen.getByRole('button', { name: /Add task/i }));

    fireEvent.click(screen.getByRole('button', { name: /^Exit to Create & Manage$/i }));

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
 * D5: every shape now lands on step 1, deliberately, including test and
 * interview. This file used to pin the opposite - a moderated edit landed on
 * Session Management - on the theory that booking a slot is a moderated
 * study's first job. That theory did not survive contact with a real
 * capture: it fired on a DRAFT as readily as a published study, and it
 * dropped the author on an unlabelled step 3 (the strip's current-step chip
 * reads "Needs attention" rather than "Current step" whenever the step you
 * are standing on also has a problem) next to a second, unrelated red flag on
 * step 1 they had not been told about either (verify-claims 14). Landing on
 * step 1 unconditionally removed that ambiguity for every shape at once; a
 * moderated author who wants the sessions step first now has one click to it
 * from the header's "Manage time slots" control instead.
 *
 * Asserted on `aria-current="step"` rather than on a field that happens to
 * render, because the step a field belongs to is a proxy and the proxy is
 * what went wrong before: an old version of this test waited for a Basic
 * Information input, which for an interview only appeared during the window
 * the landing effect had not closed yet.
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

  // Every shape lands at the beginning now - test and interview included,
  // which is the half of the rule that changed. `survey`/`poll`/`unmoderated`
  // are the control: they always landed here, so this also proves the
  // landing is not accidentally sending everything to the WRONG fixed step.
  it.each(['interview', 'test', 'survey', 'poll', 'unmoderated'])(
    'lands the author at the beginning (Study type) for a %s',
    async (type) => {
      await openExisting(type, `opp-${type}-landing`);

      await waitFor(async () =>
        expect(await standingOn()).toMatch(/Study type/)
      );
    }
  );

  // The sessions step still exists on these two shapes - the author is no
  // longer walked there automatically, but it has not been removed, and the
  // header's "Manage time slots" control (D5) is the one click there now.
  it.each(['interview', 'test'])(
    'still reaches Session Management in one click, via "Manage time slots"',
    async (type) => {
      await openExisting(type, `opp-${type}-landing`);
      await waitFor(async () =>
        expect(await standingOn()).toMatch(/Study type/)
      );

      fireEvent.click(screen.getByRole('button', { name: /Manage time slots/i }));

      await waitFor(async () =>
        expect(await standingOn()).toMatch(/Session Management/)
      );
    }
  );
});
