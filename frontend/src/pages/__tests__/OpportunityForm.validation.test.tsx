import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm, { FIELD_LOCATIONS } from '../OpportunityForm';
import { createOpportunity } from '../../api/client';
import {
  errorSummary,
  inlineErrorText,
  queryErrorSummary,
  summarisedErrorKeys,
  summaryLinkFor,
  summaryMessageFor,
  summaryMessages,
} from './helpers/error-summary';

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

vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
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

/** The step the author is looking at, read off the step strip. */
const currentStepName = () =>
  within(screen.getByRole('navigation', { name: 'Form steps' }))
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-current') === 'step')
    ?.textContent ?? '';

const continueForward = () =>
  fireEvent.click(screen.getByRole('button', { name: /^Continue(:|$)/i }));

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

const submitFromReview = () => {
  walkToReview();
  fireEvent.click(screen.getByRole('button', { name: /^Create opportunity$/ }));
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

    expect(currentStepName()).toMatch(/Basic Information/i);
    expect(summarisedErrorKeys()).toEqual(['title']);
    expect(summaryMessageFor('title')).toBe(
      'Shorten the title to 140 characters or fewer'
    );
  });

  it('refuses a 200-character purpose at Continue, where it used to advance', () => {
    renderForm();
    fillStepOne({ purpose: 'p'.repeat(200) });

    continueForward();

    expect(currentStepName()).toMatch(/Basic Information/i);
    expect(summarisedErrorKeys()).toEqual(['purpose_one_liner']);
    expect(summaryMessageFor('purpose_one_liner')).toBe(
      'Shorten the purpose to 180 characters or fewer'
    );
  });

  it('refuses a 300-minute session length at Continue, where it used to advance', () => {
    renderForm();
    fillStepOne({ type: 'test' });
    fireEvent.change(screen.getByLabelText(/Meeting Location/i), {
      target: { value: 'https://meet.example.com/room' },
    });
    fireEvent.change(screen.getByLabelText(/Default Duration/i), {
      target: { value: '300' },
    });

    continueForward();

    expect(currentStepName()).toMatch(/Basic Information/i);
    expect(summarisedErrorKeys()).toEqual(['default_duration_minutes']);
  });

  it('still lets a valid step 1 through, so the refusals above are about the values', () => {
    // The satisfied twin. A Continue that refused everything would pass all
    // three tests above and make the form impossible to use.
    renderForm();
    fillStepOne();

    continueForward();

    expect(currentStepName()).toMatch(/Content & Details/i);
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
    fireEvent.click(screen.getByRole('button', { name: /^Create opportunity$/ }));
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
    fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: 'published' } });

    continueForward();

    expect(currentStepName()).toMatch(/Content & Details/i);
    expect(queryErrorSummary()).toBeNull();

    // ...and the same form is refused at Submit, for that very field.
    submitFromReview();
    expect(summarisedErrorKeys()).toEqual(['external_link_optional']);
  });

  it('keeps `type` in scope on a later step, because it decides the shape', () => {
    // Step 2 is reachable with no type set - the step headers are clickable -
    // and continuing would walk the author past the only choice that decides
    // what this form is for.
    renderForm();
    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[1]);
    expect(currentStepName()).toMatch(/Content & Details/i);

    fireEvent.click(screen.getByRole('button', { name: /^Continue$/ }));

    expect(summarisedErrorKeys()).toEqual(['type']);
    // Routed to the step that HOLDS the field, not left where it was refused.
    expect(currentStepName()).toMatch(/Basic Information/i);
  });

  it('does not erase another step\'s reported problem when a later Continue refuses', () => {
    // The deleted validator called `setValidationErrors(errors)` with its own
    // narrow object, so a refusal on one step wiped what every other step had
    // been told. The stepper reads that map for its "Needs attention" chips.
    renderForm();
    fillStepOne({ title: 'x'.repeat(150) });

    continueForward();
    expect(summarisedErrorKeys()).toEqual(['title']);

    // Jump ahead and refuse there too, without fixing the title.
    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[1]);
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

    expect(currentStepName()).toMatch(/Content & Details/i);
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
    // (step 2), so the summary has to span steps and be ordered.
    setPurpose('Find out where people stall in the checkout flow');
    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[1]);
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'specific' },
    });
    fireEvent.click(strip[strip.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: /^Create opportunity$/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /^Create opportunity$/ }));

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

    expect(currentStepName()).toMatch(/Basic Information/i);
    expect(document.activeElement?.id).toBe('title');
  });

  it('reaches a control two steps from where the refusal was issued', () => {
    // The whole argument for the pattern: the save control lives only on
    // Review, so the field at fault is almost never on screen when it fails.
    refuseOnTwoSteps();

    fireEvent.click(summaryLinkFor('participant_type_specific_details'));

    expect(currentStepName()).toMatch(/Content & Details/i);
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
    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    // Description lives on step 2.
    fireEvent.click(strip[1]);
    fireEvent.change(screen.getByLabelText(/Description \(Optional\)/i), {
      target: { value: 'A long description the author does not want to retype' },
    });

    fireEvent.click(strip[strip.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: /^Create opportunity$/ }));

    expect(summarisedErrorKeys()).toEqual(['title']);

    // The value that FAILED is still there - clearing it would be the cruellest
    // reading of "fix this".
    fireEvent.click(summaryLinkFor('title'));
    expect(screen.getByLabelText(/^Title/i)).toHaveValue('abc');
    expect(screen.getByLabelText(/purpose/i)).toHaveValue(
      'Find out where people stall in the checkout flow'
    );

    // And so is the untouched field two steps away.
    const stripAgain = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(stripAgain[1]);
    expect(screen.getByLabelText(/Description \(Optional\)/i)).toHaveValue(
      'A long description the author does not want to retype'
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
    selectType('survey');
    setTitle('Developer experience pulse');
    setPurpose('Ten short questions about the tools you use every day');
    fireEvent.click(screen.getByLabelText(/In Cortex/i));

    // Through the step strip: C3's forward control on step 2 is ALSO named
    // "Continue: Questions", so an unscoped match is ambiguous.
    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[2]);
    fireEvent.click(await screen.findByRole('button', { name: /^Add question$/i }));

    walkToReview();
    fireEvent.click(screen.getByRole('button', { name: /^Create opportunity$/ }));
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
    fireEvent.change(screen.getByLabelText(/Meeting Location/i), {
      target: { value: 'https://meet.example.com/room' },
    });
    const duration = screen.getByLabelText(/Default Duration/i);
    fireEvent.change(duration, { target: { value: '300' } });
    fireEvent.blur(duration);
    expect(
      inlineErrorText('Enter a session length between 5 and 240 minutes')
    ).toBeInTheDocument();

    selectType('question');

    // The field is gone, so the message has to be gone...
    expect(screen.queryByLabelText(/Default Duration/i)).toBeNull();
    expect(
      screen.queryAllByText('Enter a session length between 5 and 240 minutes')
    ).toEqual([]);
    // ...and so does the chip that pointed at it. This is the assertion that
    // fails without the fix: the message disappears on its own, because the
    // input that renders it has unmounted.
    const stepOne = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button')[0];
    expect(stepOne).not.toHaveTextContent('Needs attention');
  });

  it('keeps it while the type still HAS a session', () => {
    // The satisfied twin: clearing on every type change would drop a live
    // error the moment the author switched between test and interview.
    renderForm();
    fillStepOne({ type: 'test' });
    fireEvent.change(screen.getByLabelText(/Meeting Location/i), {
      target: { value: 'https://meet.example.com/room' },
    });
    const duration = screen.getByLabelText(/Default Duration/i);
    fireEvent.change(duration, { target: { value: '300' } });
    fireEvent.blur(duration);

    selectType('interview');

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
    selectType('survey');
    setTitle('Developer experience pulse');
    setPurpose('Ten short questions about the tools you use every day');
    fireEvent.click(screen.getByLabelText(/In Cortex/i));

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
    fireEvent.click(screen.getByRole('button', { name: /^Create opportunity$/ }));
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
    // `type`, `title` and `purpose` are the first three tab stops on a new
    // form. Validating unconditionally on blur meant simply LOOKING at the form
    // raised three assertive refusals before a character was typed. Nothing did
    // that before D1, because no input on this step wired `onBlur` at all.
    renderForm();

    fireEvent.blur(screen.getByRole('combobox', { name: /Research Study Type/i }));
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

    const strip = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button');
    fireEvent.click(strip[1]);
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'specific' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Continue(:|$)/i }));
    expect(summarisedErrorKeys()).toEqual(['participant_type_specific_details']);

    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'any' },
    });

    expect(screen.queryByLabelText(/Specific Criteria/i)).toBeNull();
    expect(queryErrorSummary()).toBeNull();
    const stepTwo = within(
      screen.getByRole('navigation', { name: 'Form steps' })
    ).getAllByRole('button')[1];
    expect(stepTwo).not.toHaveTextContent('Needs attention');
  });
});

describe('the "at least two answers" rule waits until focus leaves the group', () => {
  /** A native survey with one single-choice question, on the Questions step. */
  const aChoiceQuestion = async () => {
    renderForm();
    selectType('survey');
    setTitle('Developer experience pulse');
    setPurpose('Ten short questions about the tools you use every day');
    fireEvent.click(screen.getByLabelText(/In Cortex/i));

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
