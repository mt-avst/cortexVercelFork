import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm, { FIELD_LOCATIONS } from '../OpportunityForm';
import { createOpportunity, getOpportunity } from '../../api/client';
import {
  errorSummary,
  inlineErrorText,
  queryErrorSummary,
  summarisedErrorKeys,
  summaryLinkFor,
  summaryMessageFor,
  summaryMessages,
} from './helpers/error-summary';
import { chooseStudyType } from './helpers/study-type-picker';

/*
 * D1 - one validation rule set, one vocabulary, reachable by keyboard.
 *
 * The behaviour under test is not "does a banner appear". It is that the two
 * entry points into the SAME rules cannot disagree, that every sentence the
 * author reads exists once, and that a refusal is reachable without a mouse.
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

// A stub that still exposes the step's forward control, so a test can press
// Continue ON the Session Management step - the field-owning step since D6.
vi.mock('../../components/AdminSessionManager', () => ({
  default: ({
    onContinue,
    onContinueLabel
  }: {
    onContinue?: () => void;
    onContinueLabel?: string;
  }) =>
    onContinue ? (
      <button type="button" onClick={onContinue}>
        Continue: {onContinueLabel}
      </button>
    ) : null
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

const selectType = (value: string, delivery: 'native' | 'external' = 'external') =>
  chooseStudyType(value, delivery);

const setTitle = (value: string) =>
  fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value } });

const setPurpose = (value: string) =>
  fireEvent.change(screen.getByLabelText(/purpose/i), { target: { value } });

/** The step the author is looking at, read off the step strip. */
const currentStepName = () =>
  within(screen.getByRole('navigation', { name: 'Form steps' }))
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-current') === 'step')
    ?.textContent ?? '';

const continueForward = () =>
  fireEvent.click(screen.getByRole('button', { name: /^Continue(:|$)/i }));

/**
 * Click the strip button naming a step. Matched by substring, because each
 * strip button's accessible name also carries its number and status word. Used
 * to reach a field on the step it now lives on after the D6 field moves.
 */
const goToStep = (name: RegExp) =>
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Form steps' })).getByRole(
      'button',
      { name }
    )
  );

/**
 * Walk to Review and submit, whatever the shape's length.
 *
 * A loop rather than a fixed number of clicks, because the shapes are three,
 * four and five steps long - and because a Continue that now REFUSES will stop
 * the walk, which is exactly what several tests below are asserting.
 */
const walkToReview = () => {
  for (let guard = 0; guard <= 6; guard += 1) {
    const forward = screen.queryByRole('button', { name: /^Continue: /i });
    if (!forward) {
      return;
    }
    fireEvent.click(forward);
  }
  throw new Error('walkToReview never reached a step with no Continue control');
};

/**
 * Choose Status from Review (#111 moved the control off Basic Information).
 *
 * Review has no `<label htmlFor="status">` any more - only an
 * `<h3>Status</h3>` heading - so it is the one `<select>` Review renders,
 * found by role rather than by name. Must be called once Review is on
 * screen (e.g. after `walkToReview()`).
 */
const setStatus = (status: 'draft' | 'published') =>
  fireEvent.change(within(screen.getByTestId('review-step')).getByRole('combobox'), {
    target: { value: status },
  });

const submitFromReview = (status?: 'draft' | 'published') => {
  walkToReview();
  if (status) {
    setStatus(status);
  }
  fireEvent.click(screen.getByRole('button', { name: /^Create study$/ }));
};

/**
 * Fill step 1 so the form is valid, then apply one deliberate fault.
 *
 * A single fixture builder, used by BOTH halves of the agreement test below.
 * Two builders would let the two paths be driven with two different forms,
 * which is the way that test goes vacuous without anyone noticing.
 */
const fillStepOne = ({
  title = 'A perfectly serviceable title',
  purpose = 'Find out where people stall in the checkout flow',
  type = 'question',
}: { title?: string; purpose?: string; type?: string } = {}) => {
  selectType(type);
  setTitle(title);
  setPurpose(purpose);
};

// ---------------------------------------------------------------------------
// The divergence D1 exists to close
// ---------------------------------------------------------------------------

describe('Continue can never pass what Submit refuses', () => {
  /*
   * MEASURED against the code as it stood before this change, not assumed.
   *
   * Step 1's forward control ran a hand-written copy of four of the collector's
   * rules. All three cases below walked THROUGH Continue and were refused
   * later, from Review, by rules the author had already been walked past:
   *
   *   150-character title    Continue advanced   Submit refused
   *   200-character purpose  Continue advanced   Submit refused
   *   300-minute duration    Continue advanced   Submit refused
   *
   * The plan also names a 3-character title. That one was ALREADY refused by
   * both, and a repro written against it would have passed before the fix and
   * proved nothing - so it is asserted here as a control rather than as a bug.
   */

  it('refuses a 150-character title at Continue, where it used to advance', () => {
    renderForm();
    fillStepOne({ title: 'x'.repeat(150) });

    continueForward();

    expect(currentStepName()).toMatch(/The study/i);
    expect(summarisedErrorKeys()).toEqual(['title']);
    expect(summaryMessageFor('title')).toBe(
      'Shorten the title to 140 characters or fewer'
    );
  });

  it('refuses a 200-character purpose at Continue, where it used to advance', () => {
    renderForm();
    fillStepOne({ purpose: 'p'.repeat(200) });

    continueForward();

    expect(currentStepName()).toMatch(/The study/i);
    expect(summarisedErrorKeys()).toEqual(['purpose_one_liner']);
    expect(summaryMessageFor('purpose_one_liner')).toBe(
      'Shorten the purpose to 180 characters or fewer'
    );
  });

  it('refuses a 300-minute session length at Continue on the step that owns it (D6)', () => {
    // Session length used to be a Basic Information field with a hand-copied
    // Continue rule. D6 moved it to the Session Management step; Continue THERE
    // must refuse it, not just blur - otherwise the author advances past a value
    // Submit still refuses, the exact "Continue can never pass what Submit
    // refuses" break the D6 review caught.
    renderForm();
    fillStepOne({ type: 'test' });

    // Not on Basic Information any more.
    expect(screen.queryByLabelText(/Default Duration/i)).toBeNull();

    goToStep(/Session Management/);
    fireEvent.change(screen.getByLabelText(/Default Duration/i), {
      target: { value: '300' },
    });

    // The step's forward control (the AdminSessionManager stub exposes it).
    fireEvent.click(screen.getByRole('button', { name: /^Continue: /i }));

    // It did NOT advance, and it named the field on this step.
    expect(currentStepName()).toMatch(/Session Management/i);
    expect(summarisedErrorKeys()).toEqual(['default_duration_minutes']);
  });

  it('refuses an emptied meeting location at Continue when publishing (row 9 / D6)', async () => {
    // The published-edit venue gate moved to the Session Management step too
    // (D6). A published test with the venue cleared must be refused at Continue
    // there, not advanced past.
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-pub',
      type: 'test',
      title: 'A published live session',
      purpose_one_liner: 'Watch people work through the new checkout end to end',
      status: 'published',
      default_duration_minutes: 30,
      meeting_location_optional: 'https://meet.example.com/room',
      participant_type_required: 'any',
    } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-pub/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByRole('navigation', { name: 'Form steps' });
    goToStep(/Session Management/);
    fireEvent.change(screen.getByLabelText(/Meeting Location/i), {
      target: { value: '' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^Continue: /i }));

    // Did not advance, and the venue refusal is on the record. (A slotless
    // published test also reports `sessions` here - both are Session Management
    // gates now - so the venue key is asserted by presence, not exclusively.)
    expect(currentStepName()).toMatch(/Session Management/i);
    expect(summarisedErrorKeys()).toContain('meeting_location_optional');
  });

  it('still lets a valid step 1 through, so the refusals above are about the values', () => {
    // The satisfied twin. A Continue that refused everything would pass all
    // three tests above and make the form impossible to use.
    renderForm();
    fillStepOne();

    continueForward();

    expect(currentStepName()).toMatch(/Audience/i);
    expect(queryErrorSummary()).toBeNull();
  });

  it('refuses a 3-character title at BOTH, which it always did', () => {
    // The control case, recorded so nobody writes it as a regression later.
    renderForm();
    fillStepOne({ title: 'abc' });

    continueForward();

    expect(summaryMessageFor('title')).toBe('Enter a title of at least 4 characters');
  });

  /*
   * THE test. Not "did a banner render" - the same fixture through both entry
   * points, compared by ERROR KEY.
   *
   * Comparing rendered copy would pass the day two different rules were given
   * the same wording. Comparing keys is comparing which RULES fired.
   */
  it('reports identical error keys from Continue and from Submit', () => {
    const faults = {
      type: 'question',
      title: 'x'.repeat(150),
      purpose: 'p'.repeat(200),
    };

    // --- through Continue, on step 1 ---
    const viaContinue = renderForm();
    fillStepOne(faults);
    continueForward();
    const continueKeys = summarisedErrorKeys();
    viaContinue.unmount();

    // --- the same fixture, through Submit, from Review ---
    renderForm();
    fillStepOne(faults);
    // Step headers are directly clickable, which is how a form with an invalid
    // step 1 reaches Review at all now that Continue refuses.
    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[strip.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: /^Create study$/ }));
    const submitKeys = summarisedErrorKeys();

    // Non-vacuous by construction: a fixture that produced NO errors would make
    // [] === [] and prove nothing, so the count is asserted first.
    expect(continueKeys.length).toBe(2);
    expect(continueKeys).toEqual(submitKeys);
    expect(continueKeys).toEqual(['title', 'purpose_one_liner']);
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
  });

  it('scopes Continue to the step the author is standing on', () => {
    // The other half of "one rule set": Continue must not refuse over a field
    // three steps ahead, which would be unfixable from where the author is.
    // A published question with no external link fails at Submit; on step 1 it
    // is none of Continue's business.
    renderForm();
    fillStepOne();

    continueForward();

    expect(currentStepName()).toMatch(/Audience/i);
    expect(queryErrorSummary()).toBeNull();

    // ...and the same form is refused at Submit, for that very field. Status
    // (#111) is chosen from Review now, so it is set on the way through
    // rather than back on step 1.
    submitFromReview('published');
    expect(summarisedErrorKeys()).toEqual(['external_link_optional']);
  });

  it('lets a draft test leave Basics with no meeting location, which is a publish requirement now (row 9)', () => {
    // The venue used to be required at step 1, blocking a draft author who had
    // not booked a room yet. It moves to the publish gate: a draft advances,
    // and the refusal is reasserted only when the study is published.
    renderForm();
    selectType('test');
    setTitle('A perfectly serviceable title');
    setPurpose('Find out where people stall in the checkout flow');
    // Meeting Location deliberately left empty.

    continueForward();

    // Advanced off Basic Information (to Content & Details, step 2 of the
    // five-step test shape) rather than being held on step 1 by the empty venue.
    expect(currentStepName()).not.toMatch(/The study/i);
    expect(currentStepName()).toMatch(/Audience/i);
    expect(queryErrorSummary()).toBeNull();
  });

  it('keeps `type` in scope, because it decides the shape', () => {
    // Type is required before the form advances at all. The strip is hidden
    // until a type is chosen (WZ-18), so an author cannot click past Basic
    // Information to a later step with no type - and step 1's own Continue
    // refuses without one. Filled everything else, the sole refusal is `type`.
    renderForm();
    setTitle('A perfectly serviceable title');
    setPurpose('Find out where people stall in the checkout flow');

    fireEvent.click(screen.getByRole('button', { name: /^Continue(:|$)/ }));

    expect(summarisedErrorKeys()).toEqual(['type']);
    // Left on the step that HOLDS the field: the type picker is still on
    // screen, so the author was not advanced past the choice. (The strip is
    // absent with no type, so this is asserted by the body, not by the strip.)
    expect(
      screen.getByRole('radiogroup', { name: /study type/i })
    ).toBeInTheDocument();
  });

  it('does not erase another step\'s reported problem when a later Continue refuses', () => {
    // The deleted validator called `setValidationErrors(errors)` with its own
    // narrow object, so a refusal on one step wiped what every other step had
    // been told. The stepper reads that map for its "Needs attention" chips.
    renderForm();
    fillStepOne({ title: 'x'.repeat(150) });

    continueForward();
    expect(summarisedErrorKeys()).toEqual(['title']);

    // Jump ahead to the Screener/Audience step, where Participant Type lives
    // now (D6), and refuse there too without fixing the title.
    goToStep(/Audience/);
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'specific' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Continue(:|$)/i }));

    // Both steps' problems are still on the record.
    expect(summarisedErrorKeys()).toEqual([
      'title',
      'participant_type_specific_details',
    ]);
  });

  it('clears a step\'s own problem once the author fixes it and continues', () => {
    renderForm();
    fillStepOne({ title: 'x'.repeat(150) });
    continueForward();
    expect(summarisedErrorKeys()).toEqual(['title']);

    setTitle('A title of a reasonable length');
    continueForward();

    expect(currentStepName()).toMatch(/Audience/i);
    expect(queryErrorSummary()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The summary itself
// ---------------------------------------------------------------------------

describe('the error summary is reachable, and says one thing per problem', () => {
  /** A form failing on two different steps at once. */
  const refuseOnTwoSteps = () => {
    renderForm();
    selectType('question');
    // Title left empty (step 1), participant criteria demanded and left empty
    // (the Screener/Audience step, D6), so the summary has to span steps and be
    // ordered.
    setPurpose('Find out where people stall in the checkout flow');
    goToStep(/Audience/);
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'specific' },
    });
    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[strip.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: /^Create study$/ }));
  };

  it('takes focus when it appears, so a refusal is not announced to nobody', () => {
    refuseOnTwoSteps();
    expect(document.activeElement).toBe(errorSummary());
  });

  it('re-takes focus on a REPEAT refusal over the same fields', () => {
    // Nothing in the DOM changes on a second identical refusal, so without the
    // counter the author is told in silence that the button did nothing.
    refuseOnTwoSteps();
    (document.activeElement as HTMLElement)?.blur();
    expect(document.activeElement).not.toBe(errorSummary());

    // The first refusal routed the author to step 1, so Review has to be
    // reopened before the same button can be pressed again.
    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[strip.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: /^Create study$/ }));

    expect(document.activeElement).toBe(errorSummary());
  });

  it('names every problem once, in step order', () => {
    refuseOnTwoSteps();
    expect(summarisedErrorKeys()).toEqual([
      'title',
      'participant_type_specific_details',
    ]);
    expect(summaryMessages()).toEqual([
      'Enter a title',
      'Describe the participants you need',
    ]);
  });

  it('counts the problems in its heading', () => {
    refuseOnTwoSteps();
    expect(
      within(errorSummary()).getByRole('heading', { level: 2 })
    ).toHaveTextContent('There are 2 problems');
  });

  it('opens the step and focuses the control when a link is activated', () => {
    refuseOnTwoSteps();

    fireEvent.click(summaryLinkFor('title'));

    expect(currentStepName()).toMatch(/The study/i);
    expect(document.activeElement?.id).toBe('title');
  });

  it('reaches a control two steps from where the refusal was issued', () => {
    // The whole argument for the pattern: the save control lives only on
    // Review, so the field at fault is almost never on screen when it fails.
    refuseOnTwoSteps();

    fireEvent.click(summaryLinkFor('participant_type_specific_details'));

    expect(currentStepName()).toMatch(/Audience/i);
    expect(document.activeElement?.id).toBe('participant_type_specific_details');
  });

  it('stays up after the author acts on one of its links', () => {
    // A refusal naming two problems that vanishes when the first is acted on
    // has told the author about one problem and hidden the other.
    refuseOnTwoSteps();

    fireEvent.click(summaryLinkFor('title'));

    expect(summarisedErrorKeys()).toEqual([
      'title',
      'participant_type_specific_details',
    ]);
  });

  it('shows the same sentence in the summary and beside the control', () => {
    refuseOnTwoSteps();

    expect(summaryMessageFor('title')).toBe('Enter a title');
    // On the step, not in the summary - `inlineErrorText` scopes the summary
    // out and fails if there is more or less than one such node.
    expect(inlineErrorText('Enter a title')).toBeInTheDocument();
  });

  it('marks every error with an icon as well as colour', () => {
    // `.validation-error` is a colour and nothing else - brand orange in the
    // dark theme, #DC2626 in the light one - sitting in the same position under
    // the same control as `.form-text` help. Two messages that differ only in
    // hue are one message to anyone who cannot separate those hues.
    refuseOnTwoSteps();

    // EVERY problem the summary is reporting, each checked ON ITS OWN STEP.
    //
    // Naming one sentence is how three live messages shipped with no icon, no
    // error colour and no `role="alert"` at all: this test's own fixture
    // produces "Describe the participants you need", which was one of them, and
    // the assertion walked straight past it. Scoping to whatever step happened
    // to be open would have missed it too - a field message only exists while
    // its step is rendered - so this follows each summary link to its step
    // first, which also proves the link lands where it says.
    const keys = summarisedErrorKeys();
    expect(keys.length).toBeGreaterThan(1);

    keys.forEach((key) => {
      const sentence = summaryMessageFor(key) as string;
      fireEvent.click(summaryLinkFor(key));

      const inline = inlineErrorText(sentence).closest('.validation-error');
      expect(inline, `no field message for "${sentence}"`).not.toBeNull();
      // The colour token AND the layout class - the second is what pairs the
      // icon with the sentence, and scoping them apart is what stops the
      // layout rule leaking onto the three other things that carry the token.
      expect(inline).toHaveClass('field-error');
      expect(inline).toHaveAttribute('role', 'alert');
      expect(inline?.querySelector('svg')).not.toBeNull();
      // Hidden from assistive tech: the sentence already says what is wrong,
      // and an announced "warning" before every message is noise.
      expect(inline?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    });

    expect(within(errorSummary()).getByRole('heading', { level: 2 }).querySelector('svg'))
      .not.toBeNull();

  });

  it('is a real control, so it can be reached by keyboard', () => {
    refuseOnTwoSteps();
    // A `<div onClick>` looks identical on screen and is unreachable by tab.
    expect(summaryLinkFor('title').tagName).toBe('BUTTON');
    // And not a submit: this form's controls are all type="button" because
    // nothing submits it implicitly.
    expect(summaryLinkFor('title')).toHaveAttribute('type', 'button');
  });

  it('lands on a control that EXISTS for every field that declares one', () => {
    // A `focus()` on an id nothing renders throws nothing and does nothing, so
    // a summary link can promise a landing and silently not make it. Asserted
    // against the map rather than by driving all fifteen fields, because the
    // rendered-id half is covered by the two focus tests above.
    const declared = Object.entries(FIELD_LOCATIONS)
      .filter(([, location]) => location.control)
      .map(([, location]) => location.control as string);

    expect(declared.length).toBeGreaterThanOrEqual(14);
    // Every id is distinct: two fields sharing one would send the author to the
    // wrong box from one of them, and nothing else would notice.
    expect(new Set(declared).size).toBe(declared.length);
  });
});

// ---------------------------------------------------------------------------
// Blur, and what a refusal must not destroy
// ---------------------------------------------------------------------------

describe('blur reports the same rules, on every field that has one', () => {
  it('flags an over-long title on blur, not only at save', () => {
    // The old blur validator was a switch of six hand-written cases, and its
    // two most-used ones were unreachable: `handleBlur` was threaded into
    // BasicInfoTab and used by no input in it.
    renderForm();
    selectType('question');
    const title = screen.getByLabelText(/^Title/i);
    fireEvent.change(title, { target: { value: 'x'.repeat(150) } });
    fireEvent.blur(title);

    expect(
      inlineErrorText('Shorten the title to 140 characters or fewer')
    ).toBeInTheDocument();
  });

  it('flags a short purpose on blur', () => {
    renderForm();
    selectType('question');
    const purpose = screen.getByLabelText(/purpose/i);
    fireEvent.change(purpose, { target: { value: 'too short' } });
    fireEvent.blur(purpose);

    expect(
      inlineErrorText('Enter a purpose of at least 10 characters')
    ).toBeInTheDocument();
  });

  it('flags an out-of-range session length on blur', () => {
    renderForm();
    selectType('test');
    // Default Duration lives on the Session Management step now (D6).
    goToStep(/Session Management/);
    const duration = screen.getByLabelText(/Default Duration/i);
    fireEvent.change(duration, { target: { value: '300' } });
    fireEvent.blur(duration);

    expect(
      inlineErrorText('Enter a session length between 5 and 240 minutes')
    ).toBeInTheDocument();
  });

  it('clears the message on blur once the value is corrected', () => {
    // The satisfied twin: a blur validator that only ever added messages would
    // pass every test above and make the field impossible to fill in.
    renderForm();
    selectType('question');
    const title = screen.getByLabelText(/^Title/i);
    fireEvent.change(title, { target: { value: 'x'.repeat(150) } });
    fireEvent.blur(title);
    expect(
      inlineErrorText('Shorten the title to 140 characters or fewer')
    ).toBeInTheDocument();

    fireEvent.change(title, { target: { value: 'A title of a reasonable length' } });
    fireEvent.blur(title);

    expect(
      screen.queryAllByText('Shorten the title to 140 characters or fewer')
    ).toEqual([]);
  });

  it('touches only the field that was blurred', () => {
    // Blur runs the WHOLE collector to get its answer, so the temptation is to
    // write the whole answer back - which would flag every empty field on the
    // form the moment the author left the first one.
    renderForm();
    selectType('question');
    const title = screen.getByLabelText(/^Title/i);
    fireEvent.change(title, { target: { value: 'abc' } });
    fireEvent.blur(title);

    expect(
      inlineErrorText('Enter a title of at least 4 characters')
    ).toBeInTheDocument();
    // Purpose is empty and would fail the collector, but nobody has been near
    // it, so it must not be marked.
    //
    // By the MESSAGE, not by `toBeInvalid`: purpose carries `required`, so an
    // empty one fails HTML constraint validation whatever this form thinks -
    // asserting on that would have passed with the whole map written back.
    expect(screen.queryAllByText('Enter a purpose')).toEqual([]);
    expect(screen.getByLabelText(/purpose/i)).not.toHaveClass('is-invalid');
  });
});

describe('a refusal preserves every keystroke', () => {
  it('keeps what the author typed on every step it refused over', () => {
    // Already true before D1, and asserted here so it keeps being true: the
    // form re-renders through a refusal, and a reset-on-error is one careless
    // `setFormData` away.
    renderForm();
    selectType('question');
    setTitle('abc');
    setPurpose('Find out where people stall in the checkout flow');
    // Description sits with Title and Purpose on Basic Information now (D6).
    fireEvent.change(screen.getByLabelText(/Description \(Optional\)/i), {
      target: { value: 'A long description the author does not want to retype' },
    });
    // A field two steps away, on the Screener/Audience step, filled validly so
    // it adds no error of its own - only its survival through a refusal matters.
    goToStep(/Audience/);
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'specific' },
    });
    fireEvent.change(screen.getByLabelText(/Specific Criteria/i), {
      target: { value: 'Admins who use the export flow weekly' },
    });

    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[strip.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: /^Create study$/ }));

    expect(summarisedErrorKeys()).toEqual(['title']);

    // The value that FAILED is still there - clearing it would be the cruellest
    // reading of "fix this".
    fireEvent.click(summaryLinkFor('title'));
    expect(screen.getByLabelText(/^Title/i)).toHaveValue('abc');
    expect(screen.getByLabelText(/purpose/i)).toHaveValue(
      'Find out where people stall in the checkout flow'
    );
    // Description is on the same step, and is preserved too.
    expect(screen.getByLabelText(/Description \(Optional\)/i)).toHaveValue(
      'A long description the author does not want to retype'
    );

    // And so is the untouched field two steps away.
    goToStep(/Audience/);
    expect(screen.getByLabelText(/Specific Criteria/i)).toHaveValue(
      'Admins who use the export flow weekly'
    );
  });
});

// ---------------------------------------------------------------------------
// Per-item problems, where the control's id is not the error key
// ---------------------------------------------------------------------------

describe('a summary link lands on the item it names', () => {
  /**
   * A native survey with one empty question, refused from Review.
   *
   * Per-question controls are addressed by the question's CLIENT ID, not by its
   * position, so this is the one path where the summary cannot read the control
   * id straight off the field map.
   */
  const refuseOnAnEmptyQuestion = async () => {
    renderForm();
    selectType('survey', 'native');
    setTitle('Developer experience pulse');
    setPurpose('Ten short questions about the tools you use every day');

    // Through the step strip: C3's forward control on step 2 is ALSO named
    // "Continue: Questions", so an unscoped match is ambiguous.
    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[2]);
    fireEvent.click(await screen.findByRole('button', { name: /^Add question$/i }));

    walkToReview();
    fireEvent.click(screen.getByRole('button', { name: /^Create study$/ }));
  };

  it('numbers the question in the message, so a list of them is readable', async () => {
    await refuseOnAnEmptyQuestion();

    expect(summarisedErrorKeys()).toContain('inline_survey_questions.0.prompt');
    expect(summaryMessageFor('inline_survey_questions.0.prompt')).toBe(
      'Enter the text for question 1'
    );
  });

  it('focuses the QUESTION\'s own prompt box, not the step heading', async () => {
    // The prefix and the client id are both strings on both sides, and a
    // focus() on an id nothing renders throws nothing and does nothing - so
    // getting either wrong is silent. Nothing else in the suite drives this.
    await refuseOnAnEmptyQuestion();

    fireEvent.click(summaryLinkFor('inline_survey_questions.0.prompt'));

    const focused = document.activeElement as HTMLElement;
    expect(focused.tagName).toBe('TEXTAREA');
    expect(focused.id).toMatch(/^question-prompt-/);
    // And it is the box for the question that failed, not merely A prompt box.
    expect(focused).toHaveValue('');
    expect(
      screen.getByRole('list', { name: /questions in this list/i })
    ).toContainElement(focused);
  });

  it('offers no link that lands nowhere', async () => {
    // Every entry either names a control that EXISTS once the step is open, or
    // names none at all. The middle case - an id nothing renders - is the one
    // that fails in silence.
    await refuseOnAnEmptyQuestion();

    const keys = summarisedErrorKeys();
    expect(keys.length).toBeGreaterThan(0);

    keys.forEach((key) => {
      const link = summaryLinkFor(key);
      fireEvent.click(link);
      const landed = document.activeElement as HTMLElement;
      // Focus moved off the link itself, onto something real on the step now
      // open. `document.body` is where focus goes when the target is missing.
      expect(landed).not.toBe(document.body);
      expect(landed).not.toBe(link);
    });
  });
});

// ---------------------------------------------------------------------------
// A step must never say "Needs attention" over nothing
// ---------------------------------------------------------------------------

describe('a validation error does not outlive the field it is about', () => {
  it('clears the session-length error when the type stops having a session', () => {
    // Found by driving the form, not by reading it. The message vanished with
    // the field, but the KEY stayed in the reported map - and the stepper
    // paints a reported error as "Needs attention" whether or not the field is
    // on screen. The result was a step chip with nothing on the step to fix.
    renderForm();
    fillStepOne({ type: 'test' });
    // Meeting Location and Default Duration live on the Session Management step
    // now (D6).
    goToStep(/Session Management/);
    fireEvent.change(screen.getByLabelText(/Meeting Location/i), {
      target: { value: 'https://meet.example.com/room' },
    });
    const duration = screen.getByLabelText(/Default Duration/i);
    fireEvent.change(duration, { target: { value: '300' } });
    fireEvent.blur(duration);
    expect(
      inlineErrorText('Enter a session length between 5 and 240 minutes')
    ).toBeInTheDocument();

    // The type select is back on Basic Information; switch to a type with no
    // session step.
    goToStep(/The study/);
    selectType('question');

    // The field is gone, so the message has to be gone...
    expect(screen.queryByLabelText(/Default Duration/i)).toBeNull();
    expect(
      screen.queryAllByText('Enter a session length between 5 and 240 minutes')
    ).toEqual([]);
    // ...and no step chip is left pointing at a field that no longer exists.
    // This is the assertion that fails without the fix: the message disappears
    // on its own, because the input that renders it has unmounted, while the
    // reported-error key would otherwise linger on the strip.
    within(screen.getByRole('navigation', { name: 'Form steps' }))
      .getAllByRole('button')
      .forEach((button) => expect(button).not.toHaveTextContent('Needs attention'));
  });

  it('keeps it while the type still HAS a session', () => {
    // The satisfied twin: clearing on every type change would drop a live
    // error the moment the author switched between test and interview.
    renderForm();
    fillStepOne({ type: 'test' });
    goToStep(/Session Management/);
    fireEvent.change(screen.getByLabelText(/Meeting Location/i), {
      target: { value: 'https://meet.example.com/room' },
    });
    const duration = screen.getByLabelText(/Default Duration/i);
    fireEvent.change(duration, { target: { value: '300' } });
    fireEvent.blur(duration);

    // The type select is on Basic Information; interview still has a session
    // step, so the error must survive.
    goToStep(/The study/);
    selectType('interview');

    goToStep(/Session Management/);
    expect(
      inlineErrorText('Enter a session length between 5 and 240 minutes')
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Findings from the code-reviewer gate on this change
// ---------------------------------------------------------------------------

describe('a per-item message renumbers when its item moves', () => {
  /** A native survey whose SECOND question is empty, refused from Review. */
  const refuseOnTheSecondQuestion = async () => {
    renderForm();
    selectType('survey', 'native');
    setTitle('Developer experience pulse');
    setPurpose('Ten short questions about the tools you use every day');

    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[2]);

    fireEvent.click(await screen.findByRole('button', { name: /^Add question$/i }));
    fireEvent.change(
      screen.getByLabelText(/What the participant is asked|What are you asking/i),
      { target: { value: 'Which tool slows you down?' } }
    );
    // Added second and left empty.
    fireEvent.click(screen.getByRole('button', { name: /^Add question$/i }));

    walkToReview();
    fireEvent.click(screen.getByRole('button', { name: /^Create study$/ }));
  };

  it('numbers it from the live position, not from where it was when it failed', async () => {
    // The number used to be baked into the sentence when the validator ran.
    // `remapAuthoringErrors` moves an error's KEY when its item moves and
    // carries the MESSAGE through verbatim - so after a reorder the card
    // labelled "1." read "Enter the text for question 2", and the summary
    // entry, sorted into first place by the very index it was contradicting,
    // said the same. A test in this suite had enshrined that as deliberate.
    await refuseOnTheSecondQuestion();
    expect(summarisedErrorKeys()).toEqual(['inline_survey_questions.1.prompt']);
    expect(summaryMessageFor('inline_survey_questions.1.prompt')).toBe(
      'Enter the text for question 2'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move question 2 up' }));

    // The empty question is now FIRST, so it is question 1 - in both places.
    expect(summarisedErrorKeys()).toEqual(['inline_survey_questions.0.prompt']);
    expect(summaryMessageFor('inline_survey_questions.0.prompt')).toBe(
      'Enter the text for question 1'
    );

    const cards = within(
      screen.getByRole('list', { name: /questions in this list/i })
    ).getAllByRole('listitem');
    expect(
      within(cards[0]).getByText('Enter the text for question 1')
    ).toBeInTheDocument();
    // And the stale number is nowhere on screen.
    expect(screen.queryAllByText('Enter the text for question 2')).toEqual([]);
  });
});

describe('blur does not flag a field the author never filled', () => {
  it('says nothing when they tab through a blank form', () => {
    // Title and purpose are the first text tab stops on a new form (the type is
    // now a card picker, not a blurred field). Validating unconditionally on
    // blur meant simply LOOKING at the form raised assertive refusals before a
    // character was typed. Nothing did that before D1, because no input on this
    // step wired `onBlur` at all.
    renderForm();

    fireEvent.blur(screen.getByLabelText(/^Title/i));
    fireEvent.blur(screen.getByLabelText(/purpose/i));

    expect(queryErrorSummary()).toBeNull();
    expect(screen.queryAllByText('Choose a research study type')).toEqual([]);
    expect(screen.queryAllByText('Enter a title')).toEqual([]);
    expect(screen.queryAllByText('Enter a purpose')).toEqual([]);
  });

  it('still flags a field they filled in badly', () => {
    // The satisfied twin. A blur that never flagged anything would pass the
    // test above and make the whole of task 6 pointless.
    renderForm();
    selectType('question');
    const title = screen.getByLabelText(/^Title/i);
    fireEvent.change(title, { target: { value: 'abc' } });
    fireEvent.blur(title);

    expect(
      inlineErrorText('Enter a title of at least 4 characters')
    ).toBeInTheDocument();
  });

  it('still clears a message on a field they have emptied', () => {
    // The clearing half must run whatever the field's history, or a reported
    // error on a now-empty optional field could never be taken back.
    renderForm();
    selectType('question');
    const title = screen.getByLabelText(/^Title/i);
    fireEvent.change(title, { target: { value: 'abc' } });
    fireEvent.blur(title);
    expect(
      inlineErrorText('Enter a title of at least 4 characters')
    ).toBeInTheDocument();

    fireEvent.change(title, { target: { value: 'A perfectly good title' } });
    fireEvent.blur(title);
    expect(
      screen.queryAllByText('Enter a title of at least 4 characters')
    ).toEqual([]);
  });
});

describe('an error does not outlive the field it is about', () => {
  it('clears the participant criteria error when the type stops being Specific', () => {
    // The same dead end as the session-length one, a field over: the criteria
    // input is rendered only while the type is `specific`, so switching back to
    // "Anyone" left an error in the map with nothing on screen to answer it -
    // and a summary link whose control id nothing renders, which focuses
    // nothing and drops the author on the body.
    renderForm();
    selectType('question');
    setTitle('A perfectly serviceable title');
    setPurpose('Find out where people stall in the checkout flow');

    // Participant Type and its criteria live on the Screener/Audience step now
    // (D6).
    goToStep(/Audience/);
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'specific' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Continue(:|$)/i }));
    expect(summarisedErrorKeys()).toEqual(['participant_type_specific_details']);

    goToStep(/Audience/);
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'any' },
    });

    expect(screen.queryByLabelText(/Specific Criteria/i)).toBeNull();
    expect(queryErrorSummary()).toBeNull();
    // No step chip is left saying "Needs attention" over a field that is gone.
    within(screen.getByRole('navigation', { name: 'Form steps' }))
      .getAllByRole('button')
      .forEach((button) => expect(button).not.toHaveTextContent('Needs attention'));
  });
});

describe('the "at least two answers" rule waits until focus leaves the group', () => {
  /** A native survey with one single-choice question, on the Questions step. */
  const aChoiceQuestion = async () => {
    renderForm();
    selectType('survey', 'native');
    setTitle('Developer experience pulse');
    setPurpose('Ten short questions about the tools you use every day');

    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[2]);
    fireEvent.click(await screen.findByRole('button', { name: /^Add question$/i }));
    fireEvent.change(screen.getByLabelText(/^Type$/i), {
      target: { value: 'single_choice' },
    });

    const first = await screen.findByLabelText(/Answer 1 for question 1/i);
    const second = screen.getByLabelText(/Answer 2 for question 1/i);
    return { first, second };
  };

  it('says nothing while the author is moving between answer boxes', async () => {
    // Per-box blur meant typing "Yes" into answer 1 and tabbing to answer 2
    // raised "Enter at least two answers" - assertively announced - while the
    // author was visibly half-way through the task. A guaranteed flash on
    // every choice question ever authored, and newly introduced by wiring
    // blur onto these boxes at all.
    const { first, second } = await aChoiceQuestion();

    fireEvent.change(first, { target: { value: 'Yes' } });
    fireEvent.blur(first, { relatedTarget: second });

    expect(
      screen.queryAllByText(/Enter at least two answers for question 1/i)
    ).toEqual([]);
  });

  it('says so once they leave the group with one answer filled', async () => {
    // The satisfied twin. A group blur that never fired would pass the test
    // above and leave the rule unenforced until submit.
    const { first } = await aChoiceQuestion();

    fireEvent.change(first, { target: { value: 'Yes' } });
    fireEvent.blur(first, { relatedTarget: null });

    expect(
      inlineErrorText(/Enter at least two answers for question 1/i)
    ).toBeInTheDocument();
  });
});
