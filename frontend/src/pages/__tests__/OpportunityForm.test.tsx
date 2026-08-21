import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm, {
  clearTypeConditionalErrors,
  FIELD_LOCATIONS,
  locateField,
  UNMODERATED_EXTERNAL_PARTICIPANT_ERROR,
  stepAfterShapeChange,
} from '../OpportunityForm';
import { firstStepHoldingError } from '../../lib/opportunity-authoring/error-summary';
import {
  inlineErrorText,
  queryErrorSummary,
  summarisedErrorKeys,
  summaryMessageFor,
} from './helpers/error-summary';
import { createOpportunity, getFirstHandStudies, getOpportunity, updateOpportunity } from '../../api/client';
import { getFirstHandStudy } from '../../api/firsthand-studies';

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

// The form and the Task List tab both call the API client on interaction.
// Stub every function they use; getFirstHandStudies returns one launched study
// so the picker has something to render. (Mocks are defined inside the factory
// to avoid the vi.mock hoisting temporal-dead-zone trap.)
vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  // Carries BOTH kinds, deliberately: a fixture with no `kind` key at all makes
  // `undefined !== 'survey'` pass whether or not the task-list filter is even
  // there, so removing `&& s.kind !== 'survey'` from FirstHandStudyTab could not
  // fail against a single kind-less study.
  getFirstHandStudies: vi.fn().mockResolvedValue([
    { id: 'study_demo', title: 'Demo Study', status: 'launched', kind: 'recorded' },
    { id: 'study_demo_survey', title: 'Demo Survey', status: 'launched', kind: 'survey' },
  ]),
}));

// The single-study getter the form calls in edit mode to read back what the
// author wrote. A separate module from the client, so it needs its own factory -
// and every export this file's subject touches has to be in it, or the form
// calls `undefined(...)` and the failure reads as a bug in the form.
//
// Rejecting by default is deliberate: a test that puts a linked study on an
// opportunity without saying what that study CONTAINS is not describing a real
// state, and the form's load-failure path (which refuses to save) is the honest
// answer to it. Tests that mean a real study queue a resolved value.
vi.mock('../../api/firsthand-studies', () => ({
  getFirstHandStudy: vi.fn().mockRejectedValue(new Error('not stubbed')),
}));

/**
 * A linked study as the API returns it: the record, its steps with the
 * appended `end` marker, and whether this reader may edit it.
 */
const linkedStudy = (
  overrides: {
    kind?: 'recorded' | 'survey';
    steps?: Array<Record<string, unknown>>;
    consent_text?: string;
    estimated_duration_minutes?: number | null;
    updated_at?: string;
    can_edit?: boolean;
  } = {}
) => {
  const steps = overrides.steps ?? [
    { step_id: 'study_demo_step_1', order: 1, type: 'open_text', prompt: 'What did you try first?' },
  ];

  return {
    study: {
      id: 'study_demo',
      title: 'Demo Study',
      intro_text: 'Intro',
      consent_text: overrides.consent_text ?? 'Bespoke consent the author wrote',
      kind: overrides.kind ?? 'recorded',
      status: 'launched' as const,
      estimated_duration_minutes:
        overrides.estimated_duration_minutes === undefined
          ? 12
          : overrides.estimated_duration_minutes,
      owner_user_id: 'admin-1',
      updated_at: overrides.updated_at ?? '2026-08-19T00:00:00.000Z',
    },
    steps: [
      ...steps,
      { step_id: 'study_demo_step_end', order: steps.length + 1, type: 'end', prompt: 'Thanks' },
    ],
    can_edit: overrides.can_edit ?? true,
  } as never;
};

// clearAllMocks resets call history but keeps mockResolvedValue implementations,
// so getFirstHandStudies still resolves its launched study in every test.
beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no scroll implementation, and every refused action in this form
  // now scrolls the banner into view - without this the suite is buried in
  // "Not implemented: window.scrollTo". Re-established each test, after the
  // clear, so call history is per-test.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Pure logic - the two behaviours this change actually introduces (A1 follow-up)
// ---------------------------------------------------------------------------


/**
 * Open the Consent step, the step before Review on the two authoring paths.
 *
 * C1 gave consent its own step; C3 then added Review after it, so this no
 * longer lands on the terminal control - it lands one step short of it, which
 * is what the tests that dig into the Consent surface itself actually want.
 * A test that needs to submit calls `walkToReview` (or `submitFromLastStep`,
 * which does that for it) instead.
 */
const goToConsentStep = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Continue: Consent$/i }));
};

/**
 * Open the consent editor.
 *
 * Consent is LOCKED to the approved wording by default since C1, so a test that
 * wants to change it has to unlock it the way an author does. Doing it through
 * the button rather than by reaching past it is the point: the lock is the
 * feature, and a test that bypassed it would keep passing if the lock were
 * removed.
 */
const customiseConsent = () => {
  const unlock = screen.queryByRole('button', { name: /Customise consent wording/i });

  if (unlock) {
    fireEvent.click(unlock);
  }
};

/**
 * Walk forward until there is nowhere left to go, which is Review.
 *
 * Clicks whatever "Continue: {step}" the current step offers, repeatedly. A
 * loop rather than a fixed number of clicks because the shapes are three, four
 * and five steps long, and a count cannot help stopping one step short when a
 * shape changes - which is the whole failure mode this helper exists to keep
 * out of thirty-odd call sites.
 *
 * The bound guards against a Continue control that renders but does not
 * advance: without it that spins forever instead of failing.
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
 * Click the create/save control, walking every remaining step to Review first.
 *
 * Review is where every save happens now (C3), so this always walks whatever
 * distance is left via `walkToReview` before clicking the terminal control.
 */
const submitFromLastStep = (name: RegExp = /^(Create opportunity|Save changes)$/) => {
  walkToReview();
  fireEvent.click(screen.getByRole('button', { name }));
};

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

  it('routes unmoderated opportunities to the Task List tab, not External Link', () => {
    renderForm();
    selectType('unmoderated');

    // The FirstHand Study step replaces the External Link step for this type.
    expect(
      screen.getByRole('button', { name: /Task List/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /External Link/i })
    ).not.toBeInTheDocument();
    // ...and the type helper copy no longer names an internal product.
    expect(
      screen.getByText('Self-guided recorded study')
    ).toBeInTheDocument();
  });

  it('keeps the External Link tab for poll and hides the Task List tab', () => {
    renderForm();
    selectType('poll');

    expect(
      screen.getByRole('button', { name: /External Link/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Task List/i })
    ).not.toBeInTheDocument();
  });

  it('lets an unmoderated study be authored inline without visiting the Task Lists area', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));

    // Authoring is the default path, so the tab opens on the task author and
    // does not fetch the study list at all.
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));

    expect(
      screen.getByLabelText(/What the participant sees/i)
    ).toBeInTheDocument();

    // Consent is a step of its own now, and it opens LOCKED: the approved
    // wording is shown as text with its template named, not as a textarea. So
    // this asserts the wording is present and that there is nothing to type
    // into - the second half is what would fail if the lock were dropped and
    // the old free textarea came back.
    goToConsentStep();
    expect(screen.getByText(/Standard recorded-session consent/i)).toBeInTheDocument();
    expect(screen.getByTestId('consent-locked-text')).toHaveTextContent(
      /This session records your screen and microphone/i
    );
    expect(screen.queryByLabelText(/Consent text/i)).not.toBeInTheDocument();
    expect(vi.mocked(getFirstHandStudies)).not.toHaveBeenCalled();
  });

  // Duration used to be taken from `default_duration_minutes`, the OPPORTUNITY's
  // field - which unmoderated never shows, so it sat at its default and every
  // recorded study told participants a length nobody had chosen, above a consent
  // button. These two pin the payload: it comes from the study's own field, and
  // an untouched field sends nothing at all.
  // Typed rather than `as any`: an untyped payload read can silently survive a
  // renamed or dropped field. Covers every shape this file's tests read off a
  // create/update body - not the full CreateOpportunityRequest, just the
  // fields these tests assert on.
  type InlineContentPayload = {
    target_url?: string;
    consent_text?: string;
    estimated_duration_minutes?: number;
    steps?: Array<Record<string, unknown>>;
    copied_from_study_id?: string;
    consent_template_id?: string;
    consent_template_version?: number;
  };
  type SubmittedPayload = {
    default_duration_minutes?: number;
    firsthand_study_id?: string;
    inline_study?: InlineContentPayload;
    inline_survey?: InlineContentPayload;
  };
  const submittedPayload = (): SubmittedPayload =>
    vi.mocked(createOpportunity).mock.calls[0][0] as unknown as SubmittedPayload;
  /** The same shape, off an `updateOpportunity` call rather than a create. */
  const updatedPayload = (callIndex = 0): SubmittedPayload =>
    vi.mocked(updateOpportunity).mock.calls[callIndex][1] as unknown as SubmittedPayload;

  /**
   * Open every collapsed card. B2 collapses authored tasks by default, so their
   * prompt fields do not exist until the card is opened.
   */
  const openAllCards = async (): Promise<void> => {
    const summaries = await screen.findAllByRole('button', { expanded: false });
    summaries.forEach((summary) => fireEvent.click(summary));
  };

  /**
   * Take the duration over from the automatic estimate and set it by hand.
   * The field is read-only while the estimate is in force, which is the whole
   * point of the override being explicit.
   */
  const overrideDuration = (minutes: string) => {
    fireEvent.click(screen.getByRole('button', { name: /Set it myself/i }));
    fireEvent.change(screen.getByLabelText(/Estimated completion time/i), {
      target: { value: minutes }
    });
  };

  const fillMinimalStudy = async () => {
    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });
  };

  /**
   * The consent classification has to REACH the payload, not merely exist in
   * form state.
   *
   * `inlineStudySchema` is the one inline schema that is not `.strict()`, so a
   * claim the form never sends and a claim the schema silently strips look
   * identical from here - and both leave the server reclassifying the study
   * against the newest template on every save. Reading it off the request body
   * is the only assertion that can tell the difference.
   */
  it('sends the consent template the wording is actually on', async () => {
    renderForm();
    selectType('unmoderated');
    await fillMinimalStudy();

    submitFromLastStep(/^Create/i);

    await vi.waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalled());
    expect(submittedPayload().inline_study?.consent_template_id).toBe(
      'recorded-default'
    );
    expect(submittedPayload().inline_study?.consent_template_version).toBe(1);
  });

  it('sends no template claim at all once the author has customised the wording', async () => {
    renderForm();
    selectType('unmoderated');
    await fillMinimalStudy();

    goToConsentStep();
    customiseConsent();
    fireEvent.change(screen.getByLabelText(/Consent text/i), {
      target: { value: 'We record everything and share it with our client.' }
    });
    submitFromLastStep(/^Create/i);

    await vi.waitFor(() => expect(vi.mocked(createOpportunity)).toHaveBeenCalled());
    const inline = submittedPayload().inline_study;
    expect(inline?.consent_text).toBe(
      'We record everything and share it with our client.'
    );
    // Absent, not `custom`. `custom` is the SERVER's answer, arrived at by
    // reading the wording; a client asserting it would be a client that could
    // also assert the opposite.
    expect('consent_template_id' in (inline as object)).toBe(false);
    expect('consent_template_version' in (inline as object)).toBe(false);
  });

  it('sends the duration the researcher typed, not the opportunity default', async () => {
    renderForm();
    selectType('unmoderated');
    await fillMinimalStudy();

    overrideDuration('18');
    submitFromLastStep(/^Create/i);

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const payload = submittedPayload();
    expect(payload.inline_study?.estimated_duration_minutes).toBe(18);
    // 30 is the column default that used to be sent for every recorded study.
    expect(payload.inline_study?.estimated_duration_minutes).not.toBe(
      payload.default_duration_minutes
    );
  });

  it('sends no duration at all when the author takes it over and empties it', async () => {
    // "Tell the participant no length" is still reachable, and it still has to
    // be: B2 made the estimate the default, not the floor. Telling somebody a
    // number nobody chose is the failure this field has already had once.
    renderForm();
    selectType('unmoderated');
    await fillMinimalStudy();

    overrideDuration('');
    submitFromLastStep(/^Create/i);

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    expect(submittedPayload().inline_study?.estimated_duration_minutes).toBeUndefined();
  });

  it('sends the automatic estimate when the author leaves the field alone', async () => {
    // The B2 behaviour change, pinned at the payload rather than at the input.
    // A rendered "5" proves the author was shown a number; only the payload
    // proves the participant is told one. Three minutes of setup plus two per
    // task, for the one task fillMinimalStudy writes.
    renderForm();
    selectType('unmoderated');
    await fillMinimalStudy();

    submitFromLastStep(/^Create/i);

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    expect(submittedPayload().inline_study?.estimated_duration_minutes).toBe(5);
  });

  it('moves the estimate as tasks are added, rather than pinning the first one', async () => {
    // A snapshot taken when the control first rendered would pass the test
    // above and still send a stale number the moment a second task arrived.
    renderForm();
    selectType('unmoderated');
    await fillMinimalStudy();

    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    fireEvent.change(
      screen.getAllByLabelText(/What the participant sees/i)[1],
      { target: { value: 'Download last month report' } }
    );

    submitFromLastStep(/^Create/i);

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    expect(submittedPayload().inline_study?.estimated_duration_minutes).toBe(7);
  });

  it('authors every task as a spoken-answer instruction - no response type to pick', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));

    // Sessions record screen and voice, so participants answer out loud.
    // Offering typed-response types invited them to stop talking and type;
    // there is deliberately no type selector any more.
    expect(
      screen.queryByRole('combobox', { name: /^Type$/i })
    ).toBeNull();
  });

  /**
   * Task 12: the task list gets the same list, with its own noun. A gate
   * finding names an instance; the twin is the class.
   */
  it('gives the task list the same reordering and duplication as the questions', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Open the basket' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    // Named "task", not "question" - the accessible names are what a screen
    // reader user navigates this list by.
    expect(screen.getByRole('button', { name: 'Move task 2 up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Duplicate task 1' })).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Move task 1 to position' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /question/i })).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    // An active-scheme URL is refused before it can reach the payload.
    fireEvent.change(screen.getByLabelText(/Starting URL/i), {
      target: { value: 'javascript:alert(1)' }
    });
    submitFromLastStep(/^Create/i);

    // Beside the field, not only in the summary. Since D1 both carry the same
    // sentence, so an unscoped query finds two nodes and proves neither.
    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(
      inlineErrorText(/http\(s\) address, or a path beginning with a single/i)
    ).toBeInTheDocument();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();

    // A real one goes through and lands on the payload.
    fireEvent.change(screen.getByLabelText(/Starting URL/i), {
      target: { value: 'https://example.com/checkout' }
    });
    submitFromLastStep(/^Create/i);

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const payload = submittedPayload();
    expect(payload.inline_study?.target_url).toBe('https://example.com/checkout');
  });

  // The failure this closes: a Starting URL typed the way people say addresses
  // out loud was rejected, and the message described the rule rather than the
  // one thing wrong with it.
  it('adds the missing https:// on blur, visibly, and sends the normalised url', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    const startingUrl = screen.getByLabelText(/Starting URL/i) as HTMLInputElement;
    fireEvent.change(startingUrl, { target: { value: 'example.com/checkout' } });
    fireEvent.blur(startingUrl);

    // Visible in the field, not just corrected on the way to the server: the
    // author has to be able to see what will be stored.
    await vi.waitFor(() => {
      expect(
        (screen.getByLabelText(/Starting URL/i) as HTMLInputElement).value
      ).toBe('https://example.com/checkout');
    });

    submitFromLastStep(/^Create/i);

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const normalisedPayload = submittedPayload();
    expect(normalisedPayload.inline_study?.target_url).toBe(
      'https://example.com/checkout'
    );
  });

  it('does not prepend a scheme to an active-scheme url on blur', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));

    const startingUrl = await screen.findByLabelText(/Starting URL/i);
    fireEvent.change(startingUrl, { target: { value: 'javascript:alert(1)' } });
    fireEvent.blur(startingUrl);

    // Unchanged, so the guard still gets to reject it rather than being handed
    // "https://javascript:alert(1)".
    expect((screen.getByLabelText(/Starting URL/i) as HTMLInputElement).value).toBe(
      'javascript:alert(1)'
    );
  });

  it('will not silently discard a starting url typed with no tasks', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.change(await screen.findByLabelText(/Starting URL/i), {
      target: { value: 'https://example.com/checkout' }
    });

    submitFromLastStep(/^Create/i);

    // The payload is only built when a task exists, so without this the URL
    // would vanish and the save would look like it worked.
    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(
      inlineErrorText(/a starting URL on its own has nothing/i)
    ).toBeInTheDocument();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
  });

  it('refuses to copy a task list this form cannot round-trip, and hydrates nothing', async () => {
    // The documented case: steps carrying DIFFERENT target_urls. toStudySteps
    // would stamp one study-level URL onto every step on the next save, moving
    // a step to a page it was never written against - while a screen recording
    // is running.
    vi.mocked(getFirstHandStudy).mockResolvedValueOnce(
      linkedStudy({
        steps: [
          {
            step_id: 'study_demo_step_1',
            order: 1,
            type: 'instruction',
            prompt: 'Open the basket',
            target_url: 'https://shop.test/basket'
          },
          {
            step_id: 'study_demo_step_2',
            order: 2,
            type: 'instruction',
            prompt: 'Now check out',
            target_url: 'https://shop.test/checkout'
          }
        ]
      })
    );
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));

    expect(
      await screen.findByText(
        /use something this form cannot show, so copying them here would drop part of them/i
      )
    ).toBeInTheDocument();
    // Nothing was hydrated: no provenance note, and the chooser is still on
    // screen rather than the editor.
    expect(screen.queryByText(/Copied from/i)).toBeNull();
    expect(screen.getByTestId('task-source-list')).toBeInTheDocument();
    expect(screen.queryByLabelText(/What the participant sees/i)).toBeNull();
  });

  it('sends a copied task list as content, never as the id it was copied from', async () => {
    // The sequence the link path made dangerous, now that it takes a copy: pick
    // an existing task list, then save. Sending `firsthand_study_id` here would
    // relink the opportunity to somebody else's study - the exact behaviour B3
    // removes - and the backend refuses it alongside `inline_study` anyway.
    //
    // THREE steps, and the whole array is asserted below. A single-item fixture
    // cannot tell a copy of the right list from a copy of one item, nor catch a
    // reordering.
    vi.mocked(getFirstHandStudy).mockResolvedValueOnce(
      linkedStudy({
        steps: [
          { step_id: 'study_demo_step_1', order: 1, type: 'instruction', prompt: 'Open the basket' },
          {
            step_id: 'study_demo_step_2',
            order: 2,
            type: 'open_text',
            prompt: 'What did you try first?'
          },
          {
            step_id: 'study_demo_step_3',
            order: 3,
            type: 'single_choice',
            prompt: 'Which delivery would you pick?',
            options: ['Standard', 'Next day'],
            is_required: true
          }
        ]
      })
    );
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));

    // Queried by ROLE. "Start from an existing task list" is also the wording of
    // prose on this tab, and a label matcher alone has silently returned the
    // wrong element here before.
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));

    // Waited on BEFORE opening the cards. openAllCards clicks every collapsed
    // button, and while the chooser is still on screen that includes its
    // Preview toggles - so without this the helper expands a preview instead,
    // and the failure reads as a missing editor rather than as a race.
    await screen.findByText(/Copied from/i);

    // The copied tasks are in the editor, editable. Asserting the payload alone
    // would pass against a copy that never reached the surface the author is
    // about to save from.
    await openAllCards();
    const prompts = screen.getAllByLabelText(
      /What the participant sees/i
    ) as HTMLTextAreaElement[];
    expect(prompts.map((field) => field.value)).toEqual([
      'Open the basket',
      'What did you try first?',
      'Which delivery would you pick?'
    ]);

    submitFromLastStep(/^Create/i);

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const payload = submittedPayload();
    expect(payload.firsthand_study_id).toBeUndefined();
    // The whole array, in order, carrying the fields a shallow or lossy copy
    // would flatten: the options and the required flag.
    expect(payload.inline_study?.steps).toEqual([
      { type: 'instruction', prompt: 'Open the basket' },
      { type: 'open_text', prompt: 'What did you try first?' },
      {
        type: 'single_choice',
        prompt: 'Which delivery would you pick?',
        options: ['Standard', 'Next day'],
        is_required: true
      }
    ]);
    expect(payload.inline_study?.copied_from_study_id).toBe('study_demo');
    // The source's stored duration is carried rather than re-derived: a copy of
    // a decision is still a decision. linkedStudy() stores 12; the automatic
    // estimate for three tasks is 9, so a re-derivation is visible here.
    expect(payload.inline_study?.estimated_duration_minutes).toBe(12);
  });

  it('carries the source starting URL into the field and into the payload', async () => {
    // getPrimaryTargetUrl reads it off the STORED steps; copiedRecordedFields
    // has to write it into inline_study_target_url or a copied task list loses
    // its starting page - shown as a blank field, and sent as no page at all.
    vi.mocked(getFirstHandStudy).mockResolvedValueOnce(
      linkedStudy({
        steps: [
          {
            step_id: 'study_demo_step_1',
            order: 1,
            type: 'instruction',
            prompt: 'Open the basket',
            target_url: 'https://shop.test/basket'
          }
        ]
      })
    );
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));
    await screen.findByText(/Copied from/i);

    expect(
      (screen.getByLabelText(/Starting URL/i) as HTMLInputElement).value
    ).toBe('https://shop.test/basket');

    submitFromLastStep(/^Create/i);

    await vi.waitFor(() => {
      expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
    });

    const payload = submittedPayload();
    expect(payload.inline_study?.target_url).toBe('https://shop.test/basket');
  });

  it('keeps a copied task list when the author switches back to writing their own', async () => {
    // Switching source must not be destructive. It used to be a checkbox whose
    // untick cleared the picked study; the content a copy has already put in
    // the editor is the author's, and throwing it away because they changed
    // which radio is selected would be the one thing this form must never do.
    vi.mocked(getFirstHandStudy).mockResolvedValueOnce(linkedStudy());
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));
    await screen.findByText(/Copied from/i);

    fireEvent.click(
      screen.getByRole('radio', { name: /Create tasks for this opportunity/i })
    );

    await openAllCards();
    expect(
      (screen.getByLabelText(/What the participant sees/i) as HTMLTextAreaElement).value
    ).toBe('What did you try first?');
  });

  it('offers inline authoring when editing an unmoderated draft that has no task list yet', async () => {
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-1',
      type: 'unmoderated',
      title: 'Draft saved early',
      purpose_one_liner: 'Saved before the tasks were written, which is allowed',
      status: 'draft',
      default_duration_minutes: 30,
      firsthand_study_id: null,
      participant_type_required: 'any'
    } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

    // Not locked to a chooser: the source choice is offered and writing them
    // here is the default, exactly as on create.
    expect(
      await screen.findByRole('radio', { name: /Create tasks for this opportunity/i })
    ).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Start from an existing task list/i })
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(screen.getByLabelText(/What the participant sees/i)).toBeInTheDocument();
  });

  it('offers Save Changes as soon as a copy is taken in edit mode, before anything else changes', async () => {
    // `hasChanges()` compares `study_source` and `copied_from_study_id`
    // against the baseline `loadOpportunity` seeded - both 'blank'/'' for a
    // draft with no study yet. Dropping either clause from the comparison
    // would leave the Save button hidden for exactly this action.
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-1',
      type: 'unmoderated',
      title: 'Draft saved early',
      purpose_one_liner: 'Saved before the tasks were written, which is allowed',
      status: 'draft',
      default_duration_minutes: 30,
      firsthand_study_id: null,
      participant_type_required: 'any'
    } as never);
    vi.mocked(getFirstHandStudy).mockResolvedValueOnce(linkedStudy());

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));
    expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument();

    // Phase 1: the `study_source` clause in isolation. Choosing the radio
    // alone changes `study_source` from 'blank' to 'copy' while
    // `copied_from_study_id` is still '' either side - nothing has been
    // picked yet - so only the `study_source` clause can be what shows this.
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument();

    // Phase 2: the `copied_from_study_id` clause in isolation. Taking a copy
    // sets both fields, but switching back to "Create tasks" returns
    // `study_source` to 'blank' - equal to the baseline again - while
    // `copied_from_study_id` stays set (switching source is never
    // destructive). Only the `copied_from_study_id` clause can be what keeps
    // Save Changes showing here.
    fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));
    await screen.findByText(/Copied from/i);
    fireEvent.click(
      screen.getByRole('radio', { name: /Create tasks for this opportunity/i })
    );

    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
  });

  it('keeps the authored tasks editable after saving, and saves them again in place', async () => {
    // Edit mode stays on the form after saving, so the state has to adopt the
    // study id the server just minted or the next save is answered against a
    // link the form does not know about.
    //
    // What it must NOT do any more is clear the tasks and swap to the picker.
    // That was right while a linked study could not be authored here; A0 now
    // applies the next save to the same study in place, so wiping the author's
    // content one save after they wrote it would reproduce exactly the
    // disappearance A1 exists to stop.
    const draft = {
      id: 'opp-3',
      type: 'unmoderated',
      title: 'Draft saved early',
      purpose_one_liner: 'Saved before the tasks were written, which is allowed',
      status: 'draft',
      default_duration_minutes: 30,
      firsthand_study_id: null,
      participant_type_required: 'any'
    };
    // First read: no study linked yet. Every read AFTER the save sees the study
    // the save minted, because the form now RE-READS instead of declaring that
    // what it sent is what is stored. That re-read is the thing that makes the
    // Save button's disappearance mean something.
    // `as never` rather than `as any`: the mock's declared return type is not
    // the whole Opportunity shape, and `never` sidesteps that without opening
    // the no-explicit-any lint rule up for this file.
    vi.mocked(getOpportunity)
      .mockResolvedValueOnce(draft as never)
      .mockResolvedValue({ ...draft, firsthand_study_id: 'study_created_on_save' } as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      linkedStudy({ steps: [{ step_id: 's1', order: 1, type: 'instruction', prompt: 'Find the export button' }] })
    );
    vi.mocked(updateOpportunity).mockResolvedValueOnce({
      id: 'opp-3',
      type: 'unmoderated',
      firsthand_study_id: 'study_created_on_save'
    } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-3/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    submitFromLastStep(/^Save changes$/);

    await vi.waitFor(() => {
      expect(vi.mocked(updateOpportunity)).toHaveBeenCalled();
    });

    // First save authored the study.
    expect(
      updatedPayload().inline_study
    ).toBeDefined();

    // Back to the Task List step first. The save is now made from Review, and
    // both assertions below are about what the TASK LIST step shows - on
    // Consent or Review there is no source radio and no task card, so they
    // would both pass without proving anything at all.
    //
    // Scoped to the step strip. From the Consent step there are now two
    // controls that say "Task List" - the step itself and the bottom control
    // that names where it goes back to - and an unscoped match is ambiguous.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Form steps' }))
        .getByRole('button', { name: /Task List/i })
    );

    // The source choice goes: this opportunity has its own task list now, so
    // "where does the content come from" has been answered. Waited on rather
    // than asserted straight away - updateOpportunity resolving is not the same
    // moment as the state it settles being rendered.
    await vi.waitFor(() =>
      expect(
        screen.queryByRole('radio', { name: /Start from an existing task list/i })
      ).not.toBeInTheDocument()
    );

    // The authored task is still on screen and still editable, and the picker
    // has NOT taken over. Opened first: the form re-reads after a successful
    // save, so the card comes back collapsed.
    await openAllCards();
    expect(
      (screen.getByLabelText(/What the participant sees/i) as HTMLTextAreaElement).value
    ).toBe('Find the export button');
    expect(screen.queryByTestId('task-source-list')).not.toBeInTheDocument();

    // The point of A1: a LATER save carries the tasks AGAIN, so the edit lands
    // on the same study. Asserting only that the editor is still rendered would
    // pass even if the payload had reverted to sending the id.
    //
    // A real edit is needed to trigger it - an unchanged form saves nothing.
    vi.mocked(updateOpportunity).mockResolvedValueOnce({
      id: 'opp-3',
      type: 'unmoderated',
      firsthand_study_id: 'study_created_on_save'
    } as never);

    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
    fireEvent.change(await screen.findByLabelText(/^Title/i), {
      target: { value: 'Draft saved early, now renamed' }
    });

    // Back to the Task List tab and on to Review, which is where the save
    // control lives since C3. It stays disabled while the post-save success
    // banner is up, so wait it out rather than racing it - a click during that
    // window is silently dropped.
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    walkToReview();
    const saveAgain = await screen.findByRole('button', { name: /^Save changes$/ });
    await vi.waitFor(() => expect(saveAgain).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(saveAgain);

    await vi.waitFor(() => {
      expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(2);
    });

    const secondPayload = updatedPayload(1);
    expect(secondPayload.inline_study?.steps).toEqual([
      { type: 'instruction', prompt: 'Find the export button' }
    ]);
    // Exactly one of the two, never both - the backend refuses a payload
    // carrying an id alongside authored content rather than guessing.
    expect(secondPayload.firsthand_study_id).toBeUndefined();
  });

  it('loads a linked task list into the editor rather than swapping to the picker', async () => {
    // This used to assert the opposite, and the opposite is the defect: a
    // linked list swapped the tab body to the reuse picker, so the content the
    // author had written had nowhere to render and looked like it was never
    // there. The tickbox still goes - swapping WHICH list an opportunity points
    // at is not this form's job once it points at one - but the list itself is
    // now loaded and editable.
    vi.mocked(getFirstHandStudy).mockResolvedValueOnce(linkedStudy());
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-2',
      type: 'unmoderated',
      title: 'Already wired up',
      purpose_one_liner: 'This one already points at a task list somewhere',
      status: 'draft',
      default_duration_minutes: 30,
      firsthand_study_id: 'study_demo',
      participant_type_required: 'any'
    } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-2/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));
    await openAllCards();

    expect(
      ((await screen.findByLabelText(/What the participant sees/i)) as HTMLTextAreaElement)
        .value
    ).toBe('What did you try first?');
    expect(screen.queryByTestId('task-source-list')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radio', { name: /Start from an existing task list/i })
    ).not.toBeInTheDocument();
  });

  it('offers the launched task lists to start from when copy is chosen', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );

    // Queried by role: the study's title now also appears, visually hidden,
    // inside both row buttons' accessible names, so a bare text match is
    // ambiguous.
    expect(await screen.findByRole('button', { name: /^Start from this Demo Study$/ })).toBeInTheDocument();
    expect(vi.mocked(getFirstHandStudies)).toHaveBeenCalled();
  });

  /**
   * The `kind` half of the chooser's filter. A survey-shaped study offered
   * here would be refused by the API on save, naming a rule the author never
   * saw - the same failure the survey twin's own filter exists to prevent.
   */
  it('excludes survey-kind studies from the task-list chooser', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );

    expect(
      await screen.findByRole('button', { name: /^Start from this Demo Study$/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Start from this Demo Survey$/ })
    ).not.toBeInTheDocument();
  });

  it('does not fetch the task lists until the author asks to start from one', async () => {
    // The default path is authoring, and it should cost nothing. This was true
    // of the checkbox and is easy to lose when the chooser stops being the
    // read-only branch's fallback.
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    await screen.findByRole('radio', { name: /Create tasks for this opportunity/i });

    expect(vi.mocked(getFirstHandStudies)).not.toHaveBeenCalled();
  });

  /**
   * Provenance is write-once at create, so a copy taken on one authoring
   * surface must not survive a type switch onto the other - otherwise a save
   * stamps a task list as a copy of a survey it never came from, permanently.
   * Written for BOTH directions, plus a waypoint with no authoring surface at
   * all, because the clearing logic runs once per type change and any one
   * arm missing it reintroduces the defect on that arm alone.
   */
  describe('switching the opportunity type clears a copied source', () => {
    it('clears the copy and its provenance when switching from a copied task list to a native survey', async () => {
      vi.mocked(getFirstHandStudy).mockResolvedValueOnce(linkedStudy());
      renderForm();
      selectType('unmoderated');

      fireEvent.change(screen.getByLabelText(/^Title/i), {
        target: { value: 'Checkout flow walkthrough' }
      });
      fireEvent.change(screen.getByLabelText(/purpose/i), {
        target: { value: 'Find out where people stall in the checkout flow' }
      });

      fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
      fireEvent.click(
        await screen.findByRole('radio', { name: /Start from an existing task list/i })
      );
      fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));
      await screen.findByText(/Copied from/i);

      // The switch itself.
      fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
      selectType('survey');
      fireEvent.click(screen.getByLabelText(/In Cortex/i));

      fireEvent.click(screen.getByRole('button', { name: /Questions/i }));

      // The blank arm is selected, not the copy arm, and there is no leftover
      // provenance note naming a task list this survey never came from.
      expect(
        await screen.findByRole('radio', { name: /Create questions for this opportunity/i })
      ).toBeChecked();
      expect(screen.queryByText(/Copied from/i)).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /^Add question$/i }));
      fireEvent.change(screen.getByLabelText(/What the participant is asked/i), {
        target: { value: 'How easy was checkout?' }
      });
      submitFromLastStep(/^Create/i);

      await vi.waitFor(() => {
        expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
      });

      const payload = submittedPayload();
      // Asserted on the PAYLOAD, not just the rendered radio: state can look
      // right while the field it is derived from is still carrying the old id.
      expect(payload.inline_survey?.copied_from_study_id).toBeUndefined();
    });

    it('clears the copy and its provenance when switching from a copied set of questions to unmoderated', async () => {
      vi.mocked(getFirstHandStudy).mockResolvedValueOnce(linkedStudy({ kind: 'survey' }));
      renderForm();
      selectType('survey');
      fireEvent.click(screen.getByLabelText(/In Cortex/i));

      fireEvent.change(screen.getByLabelText(/^Title/i), {
        target: { value: 'Developer experience pulse' }
      });
      fireEvent.change(screen.getByLabelText(/purpose/i), {
        target: { value: 'Ten short questions about the tools you use every day' }
      });

      fireEvent.click(screen.getByRole('button', { name: /Questions/i }));
      fireEvent.click(
        await screen.findByRole('radio', { name: /Start from an existing set of questions/i })
      );
      // "Demo Study" is recorded-kind and excluded from this chooser; "Demo
      // Survey" is the survey-kind entry the default fixture carries.
      fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Survey$/ }));
      await screen.findByText(/Copied from/i);

      fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
      selectType('unmoderated');

      fireEvent.click(screen.getByRole('button', { name: /Task List/i }));

      expect(
        await screen.findByRole('radio', { name: /Create tasks for this opportunity/i })
      ).toBeChecked();
      expect(screen.queryByText(/Copied from/i)).toBeNull();

      fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
      fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
        target: { value: 'Find the export button' }
      });
      submitFromLastStep(/^Create/i);

      await vi.waitFor(() => {
        expect(vi.mocked(createOpportunity)).toHaveBeenCalled();
      });

      const payload = submittedPayload();
      expect(payload.inline_study?.copied_from_study_id).toBeUndefined();
    });

    it('keeps the copy cleared when the type change passes through a waypoint with no authoring surface', async () => {
      // `question`, `test` and `interview` have no authoring surface at all, so
      // a copy taken before passing through one must not silently reappear on
      // the other side. Each arm of `handleInputChange`'s type switch has to
      // clear it independently, which is exactly what a "poll/survey arm only"
      // fix would miss.
      vi.mocked(getFirstHandStudy).mockResolvedValueOnce(linkedStudy());
      renderForm();
      selectType('unmoderated');

      fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
      fireEvent.click(
        await screen.findByRole('radio', { name: /Start from an existing task list/i })
      );
      fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));
      await screen.findByText(/Copied from/i);

      fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
      selectType('question');
      selectType('unmoderated');

      fireEvent.click(screen.getByRole('button', { name: /Task List/i }));

      expect(
        await screen.findByRole('radio', { name: /Create tasks for this opportunity/i })
      ).toBeChecked();
      expect(screen.queryByText(/Copied from/i)).toBeNull();
    });
  });

  describe('choosing a different task list after one is already copied in', () => {
    it('reopens the chooser without losing the content already copied in', async () => {
      vi.mocked(getFirstHandStudy).mockResolvedValueOnce(linkedStudy());
      renderForm();
      selectType('unmoderated');

      fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
      fireEvent.click(
        await screen.findByRole('radio', { name: /Start from an existing task list/i })
      );
      fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));
      await screen.findByText(/Copied from/i);

      fireEvent.click(
        screen.getByRole('button', { name: /Choose a different set of tasks/i })
      );

      // The chooser is back...
      expect(await screen.findByTestId('task-source-list')).toBeInTheDocument();
      // ...and the note (and the content it describes) is still intact, not
      // discarded just because the author is looking at the list again.
      expect(screen.getByText(/Copied from/i)).toBeInTheDocument();

      // The way back out: closes the chooser again without a new pick.
      fireEvent.click(
        screen.getByRole('button', { name: /Keep the task list already copied in/i })
      );
      expect(screen.queryByTestId('task-source-list')).not.toBeInTheDocument();
      expect(screen.getByText(/Copied from/i)).toBeInTheDocument();
    });

    it('leaves the chooser open when a reopened choice is refused', async () => {
      // A refused copy must not silently close the very list the author is
      // choosing from.
      vi.mocked(getFirstHandStudy)
        .mockResolvedValueOnce(linkedStudy())
        .mockResolvedValueOnce(
          linkedStudy({
            steps: [
              { step_id: 's1', order: 1, type: 'instruction', prompt: 'A', target_url: 'https://a.test' },
              { step_id: 's2', order: 2, type: 'instruction', prompt: 'B', target_url: 'https://b.test' }
            ]
          })
        );
      vi.mocked(getFirstHandStudies).mockResolvedValue([
        { id: 'study_demo', title: 'Demo Study', status: 'launched', kind: 'recorded' }
      ] as never);
      renderForm();
      selectType('unmoderated');

      fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
      fireEvent.click(
        await screen.findByRole('radio', { name: /Start from an existing task list/i })
      );
      fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));
      await screen.findByText(/Copied from/i);

      fireEvent.click(
        screen.getByRole('button', { name: /Choose a different set of tasks/i })
      );
      fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));

      expect(
        await screen.findByText(
          /use something this form cannot show, so copying them here would drop part of them/i
        )
      ).toBeInTheDocument();
      // Still open: the author is left where they were, not bounced back to
      // the note as though the refused pick had worked.
      expect(screen.getByTestId('task-source-list')).toBeInTheDocument();
    });
  });

  it('refuses when the source cannot even be loaded, naming the reason', async () => {
    vi.mocked(getFirstHandStudy).mockRejectedValueOnce(new Error('network down'));
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));

    expect(
      await screen.findByText(/those task list could not be loaded, so nothing was copied/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Copied from/i)).toBeNull();
  });

  it('does not offer a draft task list as a copy source', async () => {
    vi.mocked(getFirstHandStudies).mockResolvedValue([
      { id: 'study_demo', title: 'Demo Study', status: 'launched', kind: 'recorded' },
      { id: 'study_draft', title: 'Unfinished draft list', status: 'draft', kind: 'recorded' }
    ] as never);
    renderForm();
    selectType('unmoderated');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );

    expect(
      await screen.findByRole('button', { name: /^Start from this Demo Study$/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Start from this Unfinished draft list$/ })
    ).not.toBeInTheDocument();
  });

  it('shows the copy-mode publish message where the chooser actually is', async () => {
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });
    fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: 'published' } });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );

    submitFromLastStep(/^Create/i);

    // Visible, not merely present in validationErrors: the chooser is the
    // whole tab body in copy mode with nothing picked yet, so the message has
    // to render ABOVE it or it is unreachable.
    await screen.findByRole('alert', { name: /There is a problem/i });
    const message = inlineErrorText(
      /Choose a task list to start from, or switch to writing the tasks here/i
    );
    expect(message).toBeVisible();
    expect(screen.getByTestId('task-source-list')).toBeInTheDocument();
  });

  it('clears a stale task-list validation error once a copy is taken', async () => {
    vi.mocked(getFirstHandStudy).mockResolvedValueOnce(linkedStudy());
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' }
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' }
    });
    fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: 'published' } });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    submitFromLastStep(/^Create/i);
    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(summarisedErrorKeys()).toEqual(['inline_study_steps']);
    expect(
      inlineErrorText(/Add at least one task before publishing/i)
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('radio', { name: /Start from an existing task list/i })
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Start from this Demo Study$/ }));
    await screen.findByText(/Copied from/i);

    // Gone from BOTH places. Checking only the inline copy would pass while the
    // summary went on naming a problem the author has just fixed.
    expect(
      screen.queryAllByText(/Add at least one task before publishing/i)
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Silent failures in the authoring form - two live defects (2026-08-14)
//
// Both had the same shape: the author acts, nothing visible happens, and the
// only tell is a console line they will never see. The form spans up to five
// steps (three, four or five depending on the shape, since C3 added Review to
// every one of them), so "the problem is on a step you are not looking at" is
// the normal case, not an edge case.
// ---------------------------------------------------------------------------

describe('locateField', () => {
  it('puts each error key on the tab that actually renders it', () => {
    expect(locateField('title').tab).toBe(1);
    expect(locateField('participant_type_specific_details').tab).toBe(2);
    expect(locateField('external_link_optional').tab).toBe(3);
    // Step 4, since C1: consent is its own step at the end of the two authoring
    // paths. Asserted for BOTH keys, not one - the recorded and survey consent
    // fields are a twin pair and pinning one has twice let the other drift.
    expect(locateField('inline_study_consent_text').tab).toBe(4);
    expect(locateField('inline_survey_consent_text').tab).toBe(4);
    // Still step 3, and asserted here because "the consent field moved" and
    // "everything on that step moved" are different changes: the content the
    // consent is about stayed where it was.
    expect(locateField('inline_study_steps').tab).toBe(3);
    expect(locateField('inline_survey_questions').tab).toBe(3);
  });

  it('routes a per-task key to the step that renders the task list', () => {
    // No control id: the id of a task's prompt box is built from its client id,
    // which only the component holds, so these resolve to a step here and get
    // their control from `controlForError`.
    expect(locateField('inline_study_steps.0.prompt')).toEqual({ tab: 3 });
    expect(locateField('inline_study_steps.2.options')).toEqual({ tab: 3 });
    expect(locateField('inline_survey_questions.4.config')).toEqual({ tab: 3 });
  });

  it('falls back to the first step for a key it does not know', () => {
    // A new validation rule must never route the author nowhere.
    expect(locateField('some_future_field')).toEqual({ tab: 1 });
  });

  it('names a control for every field that has one on screen', () => {
    // The summary link's whole promise is that activating it lands the caret on
    // the offending control. An entry whose `control` names an id nothing
    // renders keeps that promise silently unkept - focus() on a missing id
    // throws nothing and does nothing.
    //
    // `firsthand_study_id` is the one deliberate absence: its step renders a
    // read-only list with no focusable control at all.
    const withoutControl = Object.entries(FIELD_LOCATIONS)
      .filter(([, location]) => !location.control)
      .map(([key]) => key);
    expect(withoutControl).toEqual(['firsthand_study_id']);
  });

  it('does not mistake an inherited Object property for a known field', () => {
    // A plain object answers to `constructor`, `toString` and `__proto__` with
    // truthy inherited values, which would sail past a `??` fallback and
    // produce a banner naming no field and no tab to open.
    ['constructor', 'toString', '__proto__', 'hasOwnProperty'].forEach((key) => {
      expect(locateField(key)).toEqual({ tab: 1 });
    });
  });
});

describe('firstStepHoldingError', () => {
  it('opens the earliest step holding a problem', () => {
    // Earliest, not first-inserted: the object below lists the step-4 error
    // first, and sending the author to step 4 would leave the title untouched.
    expect(
      firstStepHoldingError(
        {
          inline_study_consent_text: 'Enter the consent text participants agree to',
          title: 'Enter a title',
        },
        locateField
      )
    ).toBe(1);
  });

  it('holds the current step when there is nothing to report', () => {
    expect(firstStepHoldingError({}, locateField)).toBeNull();
  });
});

describe('FIELD_LOCATIONS completeness', () => {
  // The fallback in locateField degrades gracefully - tab 1, and the raw state
  // key as the label - which means a new validation rule shows the author
  // "Please fix these fields: some_new_key" and routes them to the wrong tab,
  // while every test still passes. Nothing else in the repo catches that: there
  // is no ESLint here and the keys are strings on both sides. So hold the map
  // to the source of truth in both directions.
  // Resolved from the vitest root (frontend/), because import.meta.url is not
  // a file: URL under the jsdom environment.
  const source = readFileSync(resolve(process.cwd(), 'src/pages/OpportunityForm.tsx'), 'utf8');
  const produced = [
    ...new Set(
      [...source.matchAll(/(?:errors|fieldErrors)\.([a-z_]+)\s*=/g)].map((match) => match[1])
    ),
  ].sort();

  it('finds the validation keys it is meant to be checking', () => {
    // Guards the regex itself: if it stops matching, the two tests below pass
    // vacuously against an empty list.
    expect(produced.length).toBeGreaterThanOrEqual(12);
    expect(produced).toContain('title');
    expect(produced).toContain('inline_study_consent_text');
  });

  it('has an entry for every error key the validators can set', () => {
    const missing = produced.filter((key) => !(key in FIELD_LOCATIONS));
    expect(missing).toEqual([]);
  });

  it('has no entry for a field that can never fail', () => {
    // A dead entry looks verified and drifts silently - two of them named
    // fields whose on-screen labels had already changed.
    const dead = Object.keys(FIELD_LOCATIONS).filter((key) => !produced.includes(key));
    expect(dead).toEqual([]);
  });
});

describe('OpportunityForm - a refused action always says so', () => {
  it('sends the author back to the type field instead of no-oping on Continue', async () => {
    // Reachable because the tab headers are directly clickable, which bypasses
    // the guard on tab 1's own Continue. With no type chosen there is no tab 3
    // to continue to, so the button used to setActiveTab(2) from tab 2 - a
    // no-op, with the label silently degraded to a bare "Continue".
    renderForm();

    // Scoped to the step strip. C3's "Continue: {next step}" label means the
    // forward control on step 1 is now ALSO named "Content & Details" -
    // "Continue: Content & Details" - so an unscoped match is ambiguous.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Form steps' }))
        .getByRole('button', { name: /Content & Details/i })
    );
    expect(screen.getByLabelText(/Description \(Optional\)/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Continue/i }));

    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(summarisedErrorKeys()).toEqual(['type']);
    // Back on the tab that holds the field, with the field itself marked.
    expect(
      screen.getByRole('combobox', { name: /Research Study Type/i })
    ).toBeInvalid();
    // The SAME sentence in both places. A summary that paraphrases the field is
    // two vocabularies wearing one coat, which is what D1 deleted.
    expect(summaryMessageFor('type')).toBe('Choose a research study type');
    expect(inlineErrorText('Choose a research study type')).toBeInTheDocument();
    expect(window.scrollTo).toHaveBeenCalled();
  });

  it('says why a save was refused, and opens the tab holding the problem', async () => {
    // The create button only exists on tab 3, so every create is submitted from
    // the furthest tab from Basic Information. A missing title failed
    // validation, logged, and returned - no banner, no scroll, no tab change.
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' },
    });

    submitFromLastStep(/^Create/i);

    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(summarisedErrorKeys()).toEqual(['title']);
    expect(screen.getByLabelText(/^Title/i)).toBeInvalid();
    expect(summaryMessageFor('title')).toBe('Enter a title');
    expect(inlineErrorText('Enter a title')).toBeInTheDocument();
    expect(window.scrollTo).toHaveBeenCalled();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
  });

  it('opens the middle tab when that is where the problem is', async () => {
    // Guards the routing rather than a hardcoded "go to tab 1": the failing
    // field here is on Content & Details, two tabs from where it was refused.
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' },
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' },
    });

    // Scoped to the step strip. C3's "Continue: {next step}" label means the
    // forward control on step 1 is now ALSO named "Content & Details" -
    // "Continue: Content & Details" - so an unscoped match is ambiguous.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Form steps' }))
        .getByRole('button', { name: /Content & Details/i })
    );
    fireEvent.change(screen.getByLabelText(/Participant Type/i), {
      target: { value: 'specific' },
    });

    // Anchored on the tab's own description: from tab 2 the forward button is
    // named "Continue: Task List", so /Task List/i alone matches both.
    fireEvent.click(
      screen.getByRole('button', { name: /What the participant does/i })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' },
    });

    submitFromLastStep(/^Create/i);

    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(summarisedErrorKeys()).toEqual(['participant_type_specific_details']);
    expect(
      inlineErrorText('Describe the participants you need')
    ).toBeInTheDocument();
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
  });

  it('takes the banner away as the author fixes what it named', () => {
    // The banner used to be a second copy of the failure held in its own state,
    // so fixing the field cleared the inline error underneath while the banner
    // went on naming it. Derived now, so it empties itself.
    const { container } = renderForm();

    // Scoped to the step strip. C3's "Continue: {next step}" label means the
    // forward control on step 1 is now ALSO named "Content & Details" -
    // "Continue: Content & Details" - so an unscoped match is ambiguous.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Form steps' }))
        .getByRole('button', { name: /Content & Details/i })
    );
    fireEvent.click(screen.getByRole('button', { name: /^Continue/i }));
    expect(summarisedErrorKeys()).toEqual(['type']);

    selectType('poll');

    expect(queryErrorSummary()).toBeNull();
    // The summary has to GO, not just empty out: rendering the alert box off a
    // flag while its list comes from elsewhere leaves a red bar saying nothing.
    expect(container.querySelector('.alert-danger')).toBeNull();
  });

  it('stays put when the earliest problem is already on the open tab', async () => {
    // Exercises setActiveTab(4) from tab 5 - the routing must not bounce the
    // author to tab 1 just because that is where most fields live. The save
    // control lives only on Review (C3) now, so the refusal is issued from
    // tab 5 and has to route back to tab 4, not "stay" on it in the literal
    // sense the earlier, four-step version of this test had - but the thing
    // being exercised (not defaulting to tab 1) is the same thing either way.
    renderForm();
    selectType('unmoderated');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout flow walkthrough' },
    });
    fireEvent.change(screen.getByLabelText(/purpose/i), {
      target: { value: 'Find out where people stall in the checkout flow' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' },
    });
    goToConsentStep();
    customiseConsent();
    fireEvent.change(screen.getByLabelText(/Consent text/i), { target: { value: '  ' } });

    submitFromLastStep(/^Create/i);

    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(summarisedErrorKeys()).toEqual(['inline_study_consent_text']);
    // Still on the Consent step, with the field that failed on screen.
    expect(screen.getByLabelText(/Consent text/i)).toBeInTheDocument();
    // And the STEP repeats the refusal beside the control, not only the banner
    // at the top. The step is handed its error through a per-kind ternary, so
    // this is also what stops the recorded and survey keys being swapped: with
    // the wrong one wired in there is simply no message here at all.
    expect(
      within(screen.getByTestId('consent-step')).getByRole('alert')
    ).toHaveTextContent('Enter the consent text participants agree to');
    expect(screen.getByLabelText(/Consent text/i)).toHaveClass('is-invalid');
    expect(vi.mocked(createOpportunity)).not.toHaveBeenCalled();
  });

  it('refuses an emptied duration instead of letting the API reject it', async () => {
    // parseInt('') is NaN, and NaN < 5 and NaN > 240 are both false, so a
    // cleared duration passed every client check and came back as an opaque
    // 400 with no field named. Driven through edit mode because Save Changes
    // is the only submit control a test/interview study has outside the
    // session manager.
    vi.mocked(getOpportunity).mockResolvedValueOnce({
      id: 'opp-9',
      type: 'test',
      title: 'Moderated walkthrough',
      purpose_one_liner: 'Watch people work through the new checkout end to end',
      status: 'draft',
      default_duration_minutes: 30,
      meeting_location_optional: 'Zoom',
      participant_type_required: 'any',
    } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-9/edit']}>
        <Routes>
          <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Basic Info/i }));
    fireEvent.change(await screen.findByLabelText(/Default Duration/i), {
      target: { value: '' },
    });

    // Scoped to the step strip. C3's "Continue: {next step}" label means the
    // forward control on step 1 is now ALSO named "Content & Details" -
    // "Continue: Content & Details" - so an unscoped match is ambiguous.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Form steps' }))
        .getByRole('button', { name: /Content & Details/i })
    );
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(summarisedErrorKeys()).toEqual(['default_duration_minutes']);
    expect(
      inlineErrorText('Enter a session length between 5 and 240 minutes')
    ).toBeInTheDocument();
    expect(vi.mocked(updateOpportunity)).not.toHaveBeenCalled();
  });
});

describe('stepAfterShapeChange', () => {
  /*
   * The landing choice for an author standing on a step the current shape does
   * not have. Unreachable through the UI - both controls that reshape the step
   * set live on step 1 - so an independent mutation pass replaced the whole
   * thing with "the first step" and all 1178 tests passed. Tested here as a
   * pure function instead, because unreachable is not the same as unspecified,
   * and the next change to the step set inherits whatever this does.
   */
  const shape = (...ids: number[]) =>
    ids.map((id) => ({
      id,
      key: 'basics' as const,
      title: `Step ${id}`,
      description: ''
    }));

  it('leaves the author where they are when the shape still has that step', () => {
    expect(stepAfterShapeChange(shape(1, 2, 3, 4, 5), 4)).toBe(4);
    // Including the sparse case, where the id is nowhere near its position.
    expect(stepAfterShapeChange(shape(1, 2, 5), 5)).toBe(5);
  });

  it('falls back to the nearest EARLIER step, not the first one', () => {
    /*
     * The distinction the mutation erased. An author on Consent (4) whose shape
     * becomes an external poll's [1, 2, 3, 5] belongs on 3 - they were working
     * forwards, and step 1 discards their place for no reason.
     */
    expect(stepAfterShapeChange(shape(1, 2, 3, 5), 4)).toBe(3);
    // And two steps back when the nearer one is gone too.
    expect(stepAfterShapeChange(shape(1, 2, 5), 4)).toBe(2);
  });

  it('never returns a step the shape does not have', () => {
    // The whole point: the caller renders by `tabs.find`, so a returned id that
    // is not in the list is a blank page rather than a wrong step.
    const shapes = [shape(1, 2, 5), shape(1, 2, 3, 5), shape(1, 2, 3, 4, 5)];
    for (const candidate of shapes) {
      for (const active of [1, 2, 3, 4, 5, 6, 99]) {
        const landing = stepAfterShapeChange(candidate, active);
        expect(candidate.map((step) => step.id)).toContain(landing);
      }
    }
  });

  it('lands on the first step when there is nothing earlier to fall back to', () => {
    expect(stepAfterShapeChange(shape(2, 3, 5), 1)).toBe(2);
  });
});
