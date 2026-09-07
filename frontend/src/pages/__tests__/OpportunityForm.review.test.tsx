import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { createOpportunity, createSessions, getOpportunity, updateOpportunity } from '../../api/client';
import { PUBLISH_PROBLEM_MESSAGES } from '@shared/firsthand/publish-readiness';
import { EXTERNAL_LINK_PROTOCOL_MESSAGE } from '@shared/firsthand/url-safety';
import {
  errorSummary,
  inlineErrorText,
  queryErrorSummary,
  summarisedErrorKeys,
} from './helpers/error-summary';

/**
 * The Review step, and the commit point that moved onto it.
 *
 * Two things are being defended here and they are not the same thing. The first
 * is that Review EXISTS and reads correctly - which is cheap to test and cheap
 * to get right. The second is that no step but Review commits, which is the
 * exit criterion, and which a test standing on one step cannot see: before C3
 * the terminal control was on the Consent step, the External Link step, and
 * inside `AdminSessionManager`, so "the commit point moved" is a claim about
 * FOUR surfaces and is only true if it is checked on all of them.
 *
 * Every structural assertion below therefore names a step that is not the
 * first, on more than one type path. An independent mutation pass on C2 found
 * eighteen real survivors that collapsed to a single finding - everything had
 * only ever been proven for step 1 - and C3 adds a step to five paths.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));

/*
 * The session step is stubbed, but NOT to `null`. Its forward control is the
 * one this change had to add rather than relabel - that path had no way out
 * forwards at all, because it used to be the end of the form - so a stub with
 * no button would let the sessions path pass this file by being unreachable.
 */
vi.mock('../../components/AdminSessionManager', () => ({
  default: ({
    onContinue,
    onContinueLabel,
    onSessionsChange
  }: {
    onContinue?: () => void;
    onContinueLabel?: string;
    onSessionsChange?: (sessions: unknown[]) => void;
  }) => (
    <div>
      <span>stub: session management</span>
      {/*
        Hands a TEMPORARY session up to the parent the way confirming a slot
        does. The id prefix is the contract: `temp-session-` is what marks a
        slot that exists only in this form's state, and the parent selects on it.
      */}
      <button
        type="button"
        onClick={() =>
          onSessionsChange?.([
            {
              id: 'temp-session-1',
              opportunity_id: 'temp',
              start_time: '2030-01-07T10:00:00.000Z',
              end_time: '2030-01-07T10:30:00.000Z',
              capacity: 1,
              booked_count: 0,
              remaining: 1,
              location_or_meet_link_optional: ''
            },
            /*
             * A REAL row alongside the temporary one. With a single-item
             * fixture, "filter to the temp slots" and "send everything" are
             * indistinguishable - an independent mutation pass dropped the
             * filter entirely and stayed green. Two items, one of each kind,
             * is the smallest fixture that can tell them apart.
             */
            {
              id: 'sess-already-real',
              opportunity_id: 'opp-1',
              start_time: '2030-01-08T09:00:00.000Z',
              end_time: '2030-01-08T09:30:00.000Z',
              capacity: 1,
              booked_count: 0,
              remaining: 1,
              location_or_meet_link_optional: ''
            }
          ])
        }
      >
        stub: confirm one slot
      </button>
      {onContinue && (
        <button type="button" onClick={onContinue}>
          Continue: {onContinueLabel}
        </button>
      )}
    </div>
  )
}));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn().mockResolvedValue({ id: 'opp-new' }),
  updateOpportunity: vi.fn().mockResolvedValue({ id: 'opp-1' }),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([]),
  createSessions: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/firsthand-studies', () => ({
  getFirstHandStudy: vi.fn()
}));

const renderCreate = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <Routes>
        <Route path="/admin/opportunities/new" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

const renderEdit = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
      <Routes>
        <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

const strip = () =>
  within(screen.getByRole('navigation', { name: 'Form steps' })).getAllByRole('button');

/** The step the author is looking at, read the way assistive technology reads it. */
const currentStepName = () =>
  strip()
    .find((step) => step.getAttribute('aria-current') === 'step')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim() ?? '(no current step)';

const forwardControl = () => screen.queryByRole('button', { name: /^Continue: / });

/**
 * The control that commits, named as a STRING rather than a regex.
 *
 * `Save changes` on Review and `Save Changes` on every other step differ only
 * by capitalisation, and a regex `/Save Changes/i` finds either - so the
 * matcher the rest of this suite uses would find the terminal control while
 * claiming to have found the shortcut. A string name in Testing Library is
 * already an exact, case-sensitive, whitespace-normalised match of the WHOLE
 * accessible name, which is what makes the distinction hold here.
 *
 * Not `{ exact: true }`: that is an option on `getByText`, not on `getByRole`,
 * where it is accepted by nobody and silently ignored. It was in this file
 * until the test typecheck refused it - a reminder that a matcher option that
 * does nothing reads exactly like one that works.
 */
const commitControl = () =>
  screen.queryByRole('button', { name: 'Create opportunity' }) ??
  screen.queryByRole('button', { name: 'Save changes' });

/** Fill step 1 well enough to be allowed forward. */
const fillBasics = (
  type: string,
  { title = 'A study with a long enough title' } = {}
) => {
  fireEvent.change(screen.getByLabelText(/Research Study Type/i), { target: { value: type } });
  fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: title } });
  fireEvent.change(screen.getByLabelText(/^Purpose/i), {
    target: { value: 'A purpose long enough to pass validation' }
  });
  const location = screen.queryByLabelText(/Meeting Location/i);
  if (location) {
    fireEvent.change(location, { target: { value: 'Zoom' } });
  }
};

/**
 * Choose Status, from wherever Review currently is (#111 moved the control
 * off Basic Information).
 *
 * Review has no `<label htmlFor="status">` any more - only an
 * `<h3>Status</h3>` heading (see `git show 1b744f5 -- BasicInfoTab.tsx` for
 * the label it used to carry) - so it is found by role rather than by name;
 * it is the only `<select>` Review renders. `formData.status` is a single
 * piece of state that survives navigating away from Review, so a caller only
 * has to be ON Review at the moment this runs - not still there afterwards.
 */
const setStatus = (status: 'draft' | 'published') => {
  fireEvent.change(within(screen.getByTestId('review-step')).getByRole('combobox'), {
    target: { value: status }
  });
};

/**
 * Walk forward, recording what was on every step on the way.
 *
 * Returns the commit control's name per step, so a caller can assert about ALL
 * of them rather than about wherever it happened to stop. That return value is
 * the whole point: "no step but Review commits" is a statement about the steps
 * the author passes THROUGH, and a helper that only reports its destination
 * cannot support it.
 */
const walkForward = () => {
  const seen: Array<{ step: string; commitControl: string | null }> = [];
  for (let guard = 0; guard <= 6; guard += 1) {
    seen.push({
      step: currentStepName(),
      commitControl: commitControl()?.textContent?.replace(/\s+/g, ' ').trim() ?? null
    });
    const forward = forwardControl();
    if (!forward) {
      return seen;
    }
    fireEvent.click(forward);
  }
  throw new Error('walkForward never reached a step with no forward control');
};

const OPPORTUNITY = (over: Record<string, unknown> = {}) => ({
  id: 'opp-1',
  type: 'poll',
  title: 'A poll the author already wrote',
  purpose_one_liner: 'A purpose long enough to pass validation',
  description_optional: '',
  product_optional: '',
  status: 'draft',
  default_duration_minutes: 30,
  external_link_optional: 'https://example.com/poll',
  participant_type_required: 'any',
  can_edit: true,
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createOpportunity).mockResolvedValue({ id: 'opp-new' } as never);
});

describe('Review is the only step that commits', () => {
  it.each([
    ['unmoderated', 5, 'Consent'],
    ['poll', 4, 'External Link'],
    ['question', 4, 'External Link'],
    // Five since #79: Consent sits between Session Management and Review on
    // the moderated pair, because Cortex now stores what those sessions agree
    // to keep.
    ['test', 5, 'Consent'],
    ['interview', 5, 'Consent']
  ])(
    'on the %s path: no earlier step offers a commit control, and Review does',
    (type, expectedSteps, stepBeforeReview) => {
      renderCreate();
      fillBasics(type);

      const seen = walkForward();

      expect(seen).toHaveLength(expectedSteps);
      // Every step BUT the last. Asserted over the whole walk rather than over
      // the step the walk happened to end on: the control used to live on the
      // step before Review on three of these five paths, so the interesting
      // slot is never index 0.
      expect(seen.slice(0, -1).map((entry) => entry.commitControl)).toEqual(
        Array(expectedSteps - 1).fill(null)
      );
      expect(seen[seen.length - 1].step).toMatch(/Review/);
      expect(seen[seen.length - 1].commitControl).toBe('Create opportunity');
      // The step the author came from is named on the way back, and it differs
      // per path - which is what makes this a check on five shapes rather than
      // the same check five times.
      expect(
        screen.getByRole('button', { name: `Previous: ${stepBeforeReview}` })
      ).toBeInTheDocument();
    }
  );

  it('names the outcome differently in edit mode', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY() as never);
    renderEdit();
    await screen.findByDisplayValue('A poll the author already wrote');

    const seen = walkForward();

    expect(seen[seen.length - 1].commitControl).toBe('Save changes');
    expect(
      screen.queryByRole('button', { name: 'Create opportunity' })
    ).not.toBeInTheDocument();
  });

  it('carries no Save Changes shortcut of its own, so there is one control and one outcome', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY() as never);
    renderEdit();
    await screen.findByDisplayValue('A poll the author already wrote');
    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Edited so the shortcut appears' } });

    // The shortcut IS on the earlier step - asserted first, so the absence
    // below cannot pass by the shortcut having disappeared everywhere.
    expect(
      screen.getByRole('button', { name: 'Save Changes' })
    ).toBeInTheDocument();

    walkForward();

    expect(
      screen.queryByRole('button', { name: 'Save Changes' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save changes' })
    ).toBeInTheDocument();
  });

  it('sends nothing when the author leaves the step that used to commit', () => {
    renderCreate();
    fillBasics('poll');
    walkForward();

    // Pressing Continue on the External Link step - which carried the create
    // control until C3 - must reach Review without having sent anything.
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
    expect(currentStepName()).toMatch(/Review/);
  });
});

describe('the Edit links open the step that owns each section', () => {
  it('on the recorded path, including sections that are not the first', () => {
    renderCreate();
    fillBasics('unmoderated');
    walkForward();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Task List' }));
    expect(currentStepName()).toMatch(/Task List/);
    expect(document.activeElement?.id).toBe('inline_study_steps');

    fireEvent.click(strip()[strip().length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Consent' }));
    expect(currentStepName()).toMatch(/Consent/);
    /*
     * The heading, not the textarea. Consent is locked to the approved wording
     * by default, and while it is locked the textarea carrying
     * `inline_study_consent_text` is not rendered at all - so the obvious
     * target focuses nothing and the author is left on the button they pressed.
     * Found by driving the form; pinned here so it stays found.
     */
    expect(document.activeElement?.id).toBe('inline_study_consent_text-heading');
  });

  it('on the survey twin, which uses the other consent vocabulary', () => {
    renderCreate();
    fillBasics('survey');
    fireEvent.click(screen.getByLabelText(/in Cortex/i));
    walkForward();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Questions' }));
    expect(currentStepName()).toMatch(/Questions/);
    expect(document.activeElement?.id).toBe('inline_survey_questions');

    fireEvent.click(strip()[strip().length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Consent' }));
    expect(currentStepName()).toMatch(/Consent/);
    // The twin of the assertion above, and it must be the OTHER id. A single
    // shared anchor would satisfy both tests and prove neither.
    expect(document.activeElement?.id).toBe('inline_survey_consent_text-heading');
  });

  it('offers one Edit link per earlier step and none for Review itself', () => {
    renderCreate();
    fillBasics('unmoderated');
    walkForward();

    expect(
      screen.getAllByRole('button', { name: /^Edit / }).map((button) => button.textContent?.trim())
    ).toEqual(['Edit Basic Information', 'Edit Content & Details', 'Edit Task List', 'Edit Consent']);
  });
});

describe('the summary reads the form as it stands, not as it was on arrival', () => {
  it('shows a value changed after the first visit to Review, on two different steps', () => {
    renderCreate();
    fillBasics('unmoderated');
    walkForward();

    expect(screen.getByText('A study with a long enough title')).toBeInTheDocument();

    // Change something on step 1...
    fireEvent.click(screen.getByRole('button', { name: 'Edit Basic Information' }));
    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Renamed on a second visit' }
    });

    // ...and something on step 3, so this cannot pass by step 1 alone being
    // live. A snapshot taken on arrival would show both of the old values.
    fireEvent.click(strip()[2]);
    fireEvent.change(screen.getByLabelText(/Starting URL/i), {
      target: { value: 'https://shop.example.com:8443/basket?ref=x' }
    });

    fireEvent.click(strip()[strip().length - 1]);

    expect(screen.getByText('Renamed on a second visit')).toBeInTheDocument();
    expect(screen.queryByText('A study with a long enough title')).not.toBeInTheDocument();
    // The hostname as the participant sees it - not the port, not the path.
    expect(screen.getByText('shop.example.com')).toBeInTheDocument();
  });
});

describe('a publish that would be refused is previewed, never blocked', () => {
  it.each([
    ['unmoderated', PUBLISH_PROBLEM_MESSAGES.unmoderated_study_required, 'Task List'],
    ['poll', PUBLISH_PROBLEM_MESSAGES.external_link_required, 'External Link']
  ])('on the %s path, in the server\'s own words', (type, message, stepTitle) => {
    renderCreate();
    fillBasics(type);
    walkForward();
    setStatus('published');

    const alert = screen.getByRole('alert');
    // The message is imported from the shared predicate the SERVER throws
    // from, not restated here. A copy in this file would pass while the two
    // drifted, which is the whole failure this arrangement exists to prevent.
    expect(alert).toHaveTextContent(message);
    fireEvent.click(within(alert).getByRole('button', { name: `Go to ${stepTitle}` }));
    expect(currentStepName()).toMatch(new RegExp(stepTitle));
  });

  it('previews the native survey refusal, which is a different rule from the external one', () => {
    renderCreate();
    fillBasics('survey');
    fireEvent.click(screen.getByLabelText(/in Cortex/i));
    walkForward();
    setStatus('published');

    expect(screen.getByRole('alert')).toHaveTextContent(
      PUBLISH_PROBLEM_MESSAGES.native_survey_study_required
    );
    // And NOT its twin: a native survey needs its questions, not a link.
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      PUBLISH_PROBLEM_MESSAGES.external_link_required
    );
  });

  it('says nothing about a draft, because the guard is about publishing', () => {
    renderCreate();
    fillBasics('unmoderated');
    walkForward();

    /*
     * The same empty task list as the refusal test above. A draft is ALLOWED to
     * be empty, and warning about it here would train the author to ignore the
     * one warning on this screen that means something.
     */
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(commitControl()).toBeEnabled();
  });

  it('leaves the commit control enabled while it is refusing', () => {
    renderCreate();
    fillBasics('unmoderated');
    walkForward();
    setStatus('published');

    expect(screen.getByRole('alert')).toBeInTheDocument();
    // The server is the authority on this, and a disabled button that is wrong
    // is unrecoverable: the author cannot press it to find out why.
    expect(commitControl()).toBeEnabled();
  });
});

describe('the commit still happens, and only from Review', () => {
  it('creates the opportunity when the control on Review is pressed', async () => {
    renderCreate();
    fillBasics('poll');
    walkForward();
    fireEvent.click(strip()[2]);
    fireEvent.change(screen.getByLabelText(/External Link/i), {
      target: { value: 'https://example.com/poll' }
    });
    fireEvent.click(strip()[strip().length - 1]);

    fireEvent.click(screen.getByRole('button', { name: 'Create opportunity' }));

    await waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalledTimes(1));
  });
});

describe('the time slots confirmed on the session step are written by the commit', () => {
  it('writes them for a test, from Review', async () => {
    renderCreate();
    fillBasics('test');
    // step 2, the session step, then Consent (on this path since #79)
    fireEvent.click(forwardControl()!);
    fireEvent.click(forwardControl()!);
    fireEvent.click(screen.getByRole('button', { name: 'stub: confirm one slot' }));
    fireEvent.click(forwardControl()!);
    fireEvent.click(forwardControl()!);

    expect(currentStepName()).toMatch(/Review/);
    fireEvent.click(screen.getByRole('button', { name: 'Create opportunity' }));

    await waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalledTimes(1));
    // Against the id the CREATE returned, not the temporary one - and with
    // EXACTLY the temporary slot, not the real row beside it.
    await waitFor(() => expect(vi.mocked(createSessions)).toHaveBeenCalledTimes(1));
    const [opportunityId, slots] = vi.mocked(createSessions).mock.calls[0];
    expect(opportunityId).toBe('opp-new');
    // The signature permits one-or-many; this call site always sends an array,
    // and asserting that is part of the point.
    expect(Array.isArray(slots)).toBe(true);
    const sent = slots as ReadonlyArray<{ start_time: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.objectContaining({ start_time: '2030-01-07T10:00:00.000Z' })
    );
  });

  it('does NOT write them once the author has changed the type away from a session type', async () => {
    /*
     * The case the security gate found, and the reason the type gate is back.
     *
     * The first version selected temporary sessions by their id prefix alone,
     * on the reasoning that only the Session Management step mints them - true
     * of how they are created, false of what happens next. The type lives on
     * step 1, so this walk is available to any author: confirm the slots, go
     * back, change the type, commit. Without the gate those slots are written to
     * a poll, which has no session surface to show them.
     */
    renderCreate();
    fillBasics('test');
    fireEvent.click(forwardControl()!);
    fireEvent.click(forwardControl()!);
    fireEvent.click(screen.getByRole('button', { name: 'stub: confirm one slot' }));

    // Back to step 1 and change the type.
    fireEvent.click(strip()[0]);
    fireEvent.change(screen.getByLabelText(/Research Study Type/i), {
      target: { value: 'poll' }
    });
    walkForward();
    fireEvent.click(strip()[2]);
    fireEvent.change(screen.getByLabelText(/External Link/i), {
      target: { value: 'https://example.com/poll' }
    });
    fireEvent.click(strip()[strip().length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Create opportunity' }));

    // The opportunity IS created - asserted first, so the absence below cannot
    // pass by the commit having failed altogether.
    await waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createSessions)).not.toHaveBeenCalled();
  });
});

describe('a value the participant cannot use is never marked by colour alone', () => {
  /**
   * The `<dd>` for one summary row, found through its `<dt>`.
   *
   * The icon is `aria-hidden` - correctly, the words carry the meaning for a
   * screen reader - which means no role or text query can see it. Reaching the
   * element is the only way to assert it is there at all, and it has to be
   * asserted: a mutation suppressing the icon and leaving the colour class
   * passed every other test in this suite.
   */
  const valueFor = (label: string): HTMLElement => {
    const term = screen.getByText(label, { selector: 'dt' });
    const value = term.nextElementSibling;
    if (!(value instanceof HTMLElement) || value.tagName !== 'DD') {
      throw new Error(`No <dd> follows the <dt> for "${label}"`);
    }
    return value;
  };

  it('pairs the colour with a shape, on a flagged row and not on a satisfied one', () => {
    renderCreate();
    fillBasics('unmoderated');
    walkForward();
    setStatus('published');

    // Flagged: a published task list with nothing in it.
    const tasks = valueFor('Tasks');
    expect(tasks).toHaveClass('validation-error');
    /*
     * BOTH halves. `validation-error` is a colour token, and this app's rule is
     * that colour is never the carrier - so the row has to be distinguishable
     * in greyscale, which only the icon does. Asserting the class alone is what
     * let a mutation delete the icon and stay green.
     */
    expect(tasks.querySelector('svg')).not.toBeNull();

    // Satisfied, for contrast: the title the author actually filled in. Without
    // this the assertions above would also pass against a component that marked
    // EVERY row as a problem.
    const title = valueFor('Title');
    expect(title).not.toHaveClass('validation-error');
    expect(title.querySelector('svg')).toBeNull();
  });

  it('flags a link that is not a web address, on the step that owns it', () => {
    renderCreate();
    fillBasics('poll');
    walkForward();
    fireEvent.click(screen.getByRole('button', { name: 'Edit External Link' }));
    fireEvent.change(screen.getByLabelText(/External Link/i), {
      target: { value: 'javascript:alert(1)' }
    });
    fireEvent.click(strip()[strip().length - 1]);

    /*
     * Not step 1, and not an absent value. `hostnameOf` returns '' for every
     * opaque scheme, so this row used to render EMPTY with no flag at all -
     * styled exactly like an answered question, on the screen whose whole job
     * is to be the last chance to notice.
     */
    const link = valueFor('External Link');
    expect(link).toHaveClass('validation-error');
    expect(link.querySelector('svg')).not.toBeNull();
    expect(link).toHaveTextContent('javascript:alert(1)');
    expect(link).toHaveTextContent(/not a web address/i);
  });
});

describe('the form itself cannot commit, only the control on Review', () => {
  /*
   * The defect this pins broke the exit criterion outright, and no test in
   * 1187 could see it.
   *
   * Every control in this form is `type="button"`, so the form has no submit
   * button - which is the CONDITION for the HTML implicit-submission
   * algorithm, not a defence against it. A form with no submit button is
   * submitted from the form element whenever it holds no more than ONE field
   * that blocks implicit submission, and two steps qualify: External Link
   * renders a single `input[type=url]`, and Content & Details a single
   * `input[type=text]`. Pressing Return in either created the opportunity and
   * navigated away, from a step that is not Review.
   *
   * jsdom does not implement implicit submission, so a keyDown here proves
   * nothing. Dispatching the submit event directly is what exercises the
   * handler that used to be `handleSubmit` - and the e2e spec presses a real
   * Return in a real browser, which is where the defect was actually found.
   */
  const formElement = (): HTMLFormElement => {
    const form = document.querySelector('form');
    if (!(form instanceof HTMLFormElement)) {
      throw new Error('The opportunity form is not on screen');
    }
    return form;
  };

  it.each([
    ['poll', 2, 'External Link'],
    ['poll', 1, 'Content & Details']
  ])(
    'ignores its own submit event on the %s path, %i step(s) in (%s)',
    (type, forwardClicks, expectedStep) => {
      renderCreate();
      fillBasics(type);
      for (let i = 0; i < forwardClicks; i += 1) {
        fireEvent.click(forwardControl()!);
      }
      expect(currentStepName()).toMatch(new RegExp(expectedStep));

      fireEvent.submit(formElement());

      expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
      // And it does not silently move either: a swallowed submit that also
      // navigated would be a different bug wearing the same green test.
      expect(currentStepName()).toMatch(new RegExp(expectedStep));
    }
  );

  it('still commits from Review, so the fix did not disable the form', async () => {
    /*
     * Asserted in the same file as the two above, deliberately. "The submit
     * event does nothing" is satisfied by a form that can never save at all,
     * and that is the failure mode of this fix.
     */
    renderCreate();
    fillBasics('poll');
    walkForward();
    fireEvent.click(strip()[2]);
    fireEvent.change(screen.getByLabelText(/External Link/i), {
      target: { value: 'https://example.com/poll' }
    });
    fireEvent.click(strip()[strip().length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Create opportunity' }));

    await waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalledTimes(1));
  });
});

describe('what Review says about itself depends on whether the thing exists', () => {
  it('does not claim nothing has been saved when editing something that has', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(OPPORTUNITY() as never);
    renderEdit();
    await screen.findByDisplayValue('A poll the author already wrote');
    walkForward();

    /*
     * In edit mode both halves of the create copy are false: the opportunity
     * exists, and every earlier step keeps a Save Changes shortcut, so changes
     * may already have been saved this session.
     */
    expect(screen.queryByText(/Nothing has been saved yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Check everything before you save/i)).toBeInTheDocument();
  });

  it('does say so when creating, which is the case where it is true', () => {
    renderCreate();
    fillBasics('poll');
    walkForward();

    // The twin. Asserting only the edit case would pass against a component
    // that had simply lost the sentence altogether.
    expect(screen.getByText(/Nothing has been saved yet/i)).toBeInTheDocument();
  });
});

describe('a save that half-worked is not announced as a success', () => {
  it('stays on the form when the opportunity saved but its time slots did not', async () => {
    vi.mocked(createSessions).mockRejectedValueOnce(new Error('500 from the sessions endpoint'));

    renderCreate();
    fillBasics('test');
    fireEvent.click(forwardControl()!);
    fireEvent.click(forwardControl()!);
    fireEvent.click(screen.getByRole('button', { name: 'stub: confirm one slot' }));
    // Consent sits between Session Management and Review since #79.
    fireEvent.click(forwardControl()!);
    fireEvent.click(forwardControl()!);
    fireEvent.click(screen.getByRole('button', { name: 'Create opportunity' }));

    await waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalledTimes(1));

    /*
     * The banner explaining it must be on a page the author is still looking
     * at. Before this, execution fell straight through to the navigation, React
     * batched both into one commit, and the route change unmounted the form -
     * so the author landed on the dashboard reading "Opportunity created
     * successfully!" with an opportunity that had no bookable slots.
     */
    expect(
      await screen.findByText(/time slots were not/i)
    ).toBeInTheDocument();
    // Still on Review, not gone.
    expect(currentStepName()).toMatch(/Review/);
  });

  /**
   * Walk a create to the commit with one confirmed slot, and let `createSessions`
   * fail however the caller says.
   */
  const commitWithFailingSessions = async (rejection: unknown) => {
    vi.mocked(createSessions).mockRejectedValueOnce(rejection);

    renderCreate();
    fillBasics('test');
    fireEvent.click(forwardControl()!);
    fireEvent.click(forwardControl()!);
    fireEvent.click(screen.getByRole('button', { name: 'stub: confirm one slot' }));
    // Consent sits between Session Management and Review since #79.
    fireEvent.click(forwardControl()!);
    fireEvent.click(forwardControl()!);
    fireEvent.click(screen.getByRole('button', { name: 'Create opportunity' }));

    await waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalledTimes(1));
  };

  /** The whole banner as the author reads it, not the fragment a regex matched. */
  const bannerText = async (match: RegExp) =>
    (await screen.findByText(match)).textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('shows the clashing times the 409 named, and says to change them', async () => {
    await commitWithFailingSessions({
      response: {
        status: 409,
        // The route's own wording: `Session overlaps with existing sessions:
        // ${formatTime(start)} - ${formatTime(end)}`.
        data: { error: 'Session overlaps with existing sessions: 10:00 AM - 10:30 AM' }
      }
    });

    const banner = await bannerText(/10:00 AM - 10:30 AM/);
    // The fact that breaks the loop: WHICH slots clash.
    expect(banner).toContain('Session overlaps with existing sessions: 10:00 AM - 10:30 AM');
    // And the advice that can actually be followed from here. The batch is
    // atomic, so nothing was created and the slots are still on the step named.
    expect(banner).toMatch(/change the times on the Session Management step/i);
    // NOT the advice that sends them to re-add the same slots and hit the same 409.
    expect(banner).not.toMatch(/from the dashboard/i);
    expect(currentStepName()).toMatch(/Review/);

    /*
     * This message is two lines wide at the container, and the icon used to be
     * an inline sibling of the text - so line two wrapped UNDERNEATH it. Nothing
     * else in the suite would notice that coming back, because it is not a
     * string and not a step.
     */
    expect(screen.getByRole('alert')).toHaveClass('d-flex', 'align-items-start');
  });

  it('falls back to the generic sentence when the 409 carried no message', async () => {
    // Otherwise the fallback is dead copy the moment the 409 path is pinned.
    await commitWithFailingSessions({ response: { status: 409, data: {} } });

    expect(await bannerText(/time slots were not/i)).toBe(
      'The opportunity was saved but its time slots were not. Add them from the dashboard.'
    );
    expect(currentStepName()).toMatch(/Review/);
  });

  it('gives a 500 different advice from a 409, and does not print its message', async () => {
    /*
     * The twin of the 409 arm, and it is doing two jobs.
     *
     * A fix that surfaced the server string and gave IDENTICAL advice for both
     * statuses passes every other assertion in this block. And outside
     * production `errorHandler` puts the raw `error.message` in the body of a
     * 500, so this also pins that an internal message does not reach the author.
     * The 409 arm above is the control: it proves this assertion can see a
     * server message when one is meant to be rendered.
     */
    await commitWithFailingSessions({
      response: {
        status: 500,
        data: { error: 'insert or update on table "sessions" violates foreign key constraint' }
      }
    });

    const banner = await bannerText(/time slots were not/i);
    expect(banner).toBe(
      'The opportunity was saved but its time slots were not. Add them from the dashboard.'
    );
    expect(banner).not.toMatch(/foreign key constraint/i);
    expect(screen.queryByText(/foreign key constraint/i)).not.toBeInTheDocument();
    expect(currentStepName()).toMatch(/Review/);
  });

  it('still reports a rejection that is not an object at all', async () => {
    await commitWithFailingSessions(undefined);

    expect(await bannerText(/time slots were not/i)).toBe(
      'The opportunity was saved but its time slots were not. Add them from the dashboard.'
    );
    expect(currentStepName()).toMatch(/Review/);
  });
});

describe('the step that is not a StepActions row still names where it goes', () => {
  it('offers Continue: Consent on Session Management', () => {
    /*
     * The one forward control in this form that `StepActions` does not render.
     * Every "Continue: Review" assertion elsewhere sits on a StepActions step,
     * and this file's own walk helper matches `/^Continue: /` so it clicks
     * whatever it finds - so a mutation naming the WRONG step here survived the
     * whole suite. That is "a native poll read Continue to Link Setup and
     * landed on Questions", relocated to the one path nobody was watching.
     */
    renderCreate();
    fillBasics('test');
    fireEvent.click(forwardControl()!);
    fireEvent.click(forwardControl()!);

    expect(currentStepName()).toMatch(/Session Management/);
    // Consent, not Review, since #79 put the consent step on this path. The
    // hazard this test guards is unchanged: this is the one forward control
    // StepActions does not render, so only an exact name here can catch it
    // pointing at the wrong step.
    expect(
      screen.getByRole('button', { name: 'Continue: Consent' })
    ).toBeInTheDocument();
  });
});

describe('a refusal does not follow the author off the step that caused it', () => {
  it('clears the banner when they move on, and when they use an Edit link', () => {
    renderCreate();
    // No type chosen: step 2's forward control refuses and reports.
    fireEvent.click(strip()[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // By its own heading, not by role alone: a refused step also carries the
    // type error's inline alert, so `getByRole('alert')` is ambiguous here.
    expect(errorSummary()).toBeInTheDocument();
    expect(summarisedErrorKeys()).toEqual(['type']);

    // Moving on clears it...
    fillBasics('poll');
    fireEvent.click(forwardControl()!);
    expect(queryErrorSummary()).toBeNull();

    // ...and so does an Edit link from Review, which is a separate code path.
    walkForward();
    fireEvent.click(strip()[1]);
    fireEvent.click(screen.getByRole('button', { name: /^Continue: / }));
    walkForward();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Basic Information' }));
    expect(queryErrorSummary()).toBeNull();
    // The Edit link's own job, asserted here too so this cannot pass by the
    // click having done nothing at all.
    expect(document.activeElement?.id).toBe('title');
  });
});

describe('a publish that WOULD be allowed says nothing', () => {
  /*
   * Every other refusal test in this file uses a fixture that violates the
   * rule, and the only "no alert" case was a draft - so any mutation making
   * the predicate STRICTER stayed green. These are the other half.
   */
  it('shows no refusal for a published external poll that has a link', () => {
    renderCreate();
    fillBasics('poll');
    walkForward();
    setStatus('published');
    fireEvent.click(strip()[2]);
    fireEvent.change(screen.getByLabelText(/External Link/i), {
      target: { value: 'https://example.com/poll' }
    });
    fireEvent.click(strip()[strip().length - 1]);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(commitControl()).toBeEnabled();
  });

  it('shows no refusal for a published test, which needs no study at all', () => {
    // The twin path: a booked session has no study, so no rule applies.
    renderCreate();
    fillBasics('test');
    walkForward();
    setStatus('published');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('the form refuses a link the server would refuse', () => {
  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)']
  ])('names the problem inline rather than letting %s reach a 400', (link) => {
    /*
     * The client used a bare `new URL(...)`, which parses every one of these
     * happily. Now that the server's schema refuses them, an author whose form
     * did not would get an opaque "Validation failed" from an endpoint instead
     * of a message beside the field - so both boundaries have to agree, and the
     * message is imported rather than restated for exactly that reason.
     */
    renderCreate();
    fillBasics('question');
    walkForward();
    setStatus('published');
    fireEvent.click(strip()[2]);
    fireEvent.change(screen.getByLabelText(/External Link/i), { target: { value: link } });
    fireEvent.click(strip()[strip().length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Create opportunity' }));

    // Scoped OUT of the summary. Since D1 the summary carries the same
    // sentence, and this test's name promises the message is beside the field.
    expect(
      inlineErrorText(new RegExp(EXTERNAL_LINK_PROTOCOL_MESSAGE.slice(0, 30), 'i'))
    ).toBeInTheDocument();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
  });

  it('lets a real web address through, so the refusal is about the scheme and not the field', async () => {
    renderCreate();
    fillBasics('question');
    walkForward();
    setStatus('published');
    fireEvent.click(strip()[2]);
    fireEvent.change(screen.getByLabelText(/External Link/i), {
      target: { value: 'http://example.com/answer' }
    });
    fireEvent.click(strip()[strip().length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Create opportunity' }));

    await waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalledTimes(1));
  });
});

describe('an opportunity stored with a bad link can still be repaired', () => {
  it('flags the stored link on a DRAFT, where no publish rule applies', async () => {
    /*
     * The case that kept this fix out of C3: hardening the schema refuses
     * existing rows, and a row that can never be edited again is worse than the
     * bug.
     *
     * The form resends this field on every save, so a draft holding a
     * `javascript:` link stored before the schema was hardened gets a 400 from
     * the endpoint. Well-formedness is therefore checked whatever the status -
     * otherwise the author's only warning is "Validation failed", naming no
     * field, on the row they are trying to fix.
     */
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({
        type: 'question',
        status: 'draft',
        external_link_optional: 'javascript:alert(1)'
      }) as never
    );
    renderEdit();
    await screen.findByDisplayValue('A poll the author already wrote');

    walkForward();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      inlineErrorText(new RegExp(EXTERNAL_LINK_PROTOCOL_MESSAGE.slice(0, 30), 'i'))
    ).toBeInTheDocument();
    expect(vi.mocked(updateOpportunity)).not.toHaveBeenCalled();
  });

  it('saves once the author replaces it, so the row is not locked out', async () => {
    /*
     * The half that matters most. A guard that refuses the bad value and also
     * refuses the corrected one would brick every affected row, and the test
     * above alone cannot tell those two apart.
     */
    vi.mocked(getOpportunity).mockResolvedValue(
      OPPORTUNITY({
        type: 'question',
        status: 'draft',
        external_link_optional: 'javascript:alert(1)'
      }) as never
    );
    renderEdit();
    await screen.findByDisplayValue('A poll the author already wrote');

    walkForward();
    fireEvent.click(screen.getByRole('button', { name: 'Edit External Link' }));
    fireEvent.change(screen.getByLabelText(/External Link/i), {
      target: { value: 'https://example.com/repaired' }
    });
    fireEvent.click(strip()[strip().length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateOpportunity).mock.calls[0][1]).toEqual(
      expect.objectContaining({ external_link_optional: 'https://example.com/repaired' })
    );
  });
});

describe('the field says so on blur, not only on save', () => {
  /*
   * This boundary was a MUTATION SURVIVOR: disabling the blur validator's
   * scheme check left all 1210 tests green. There are three validators of this
   * field - submit, blur, and the server's schema - and the blur one had its
   * own bare `new URL(...)` and its own wording, so an author was told on blur
   * that a `javascript:` link was fine and told on save that it was not, in
   * different words. Testing only the submit path is how that survived.
   */
  const linkField = () => screen.getByLabelText(/External Link/i);

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>']
  ])('reports %s as soon as the author leaves the field', (link) => {
    renderCreate();
    fillBasics('question');
    walkForward();
    fireEvent.click(strip()[2]);

    fireEvent.change(linkField(), { target: { value: link } });
    fireEvent.blur(linkField());

    expect(
      screen.getByText(new RegExp(EXTERNAL_LINK_PROTOCOL_MESSAGE.slice(0, 30), 'i'))
    ).toBeInTheDocument();
  });

  it('clears the message when the author replaces it with a real address', () => {
    // The satisfied twin: a validator that flagged everything would pass the
    // assertions above and make the field impossible to fill in.
    renderCreate();
    fillBasics('question');
    walkForward();
    fireEvent.click(strip()[2]);

    fireEvent.change(linkField(), { target: { value: 'javascript:alert(1)' } });
    fireEvent.blur(linkField());
    expect(
      screen.getByText(new RegExp(EXTERNAL_LINK_PROTOCOL_MESSAGE.slice(0, 30), 'i'))
    ).toBeInTheDocument();

    fireEvent.change(linkField(), { target: { value: 'https://example.com/answer' } });
    fireEvent.blur(linkField());
    expect(
      screen.queryByText(new RegExp(EXTERNAL_LINK_PROTOCOL_MESSAGE.slice(0, 30), 'i'))
    ).not.toBeInTheDocument();
  });
});
