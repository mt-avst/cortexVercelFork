import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { RECORDED_CONSENT_TEMPLATE } from '../../shared/firsthand/consent-templates';
import {
  authoredStepsOf,
  studyRoundTripsCleanly,
  toInlineStudyPayloadStep,
  toInlineStudyStep,
  toSurveyPayloadStep,
  toSurveyQuestion,
  withStoredIdentity
} from '../../lib/opportunity-authoring/hydrate-study';
import { withClientId } from '../../lib/opportunity-authoring/client-ids';
import { toStudySteps } from '../../shared/firsthand/inline-study';
import { toSurveySteps } from '../../shared/firsthand/survey-authoring';
import { getOpportunity, updateOpportunity } from '../../api/client';
import { getFirstHandStudy } from '../../api/firsthand-studies';
import { logger } from '../../utils/logger';
import type { StudyStep } from '../../shared/firsthand/contract';
import { inlineErrorText, summarisedErrorKeys } from './helpers/error-summary';

/**
 * Edit mode round-tripping what the author wrote (A1).
 *
 * Reopening an opportunity used to reset the authored steps to `[]` and the
 * consent to its boilerplate default, then swap the tab body to the reuse
 * picker - so twelve written questions came back as an empty form that read as
 * "you never wrote any" rather than as loss. These tests pin the round trip:
 * what the study holds is what the form shows, what the form shows is what the
 * next save sends, and a study this form cannot faithfully represent is not
 * loaded into it at all.
 *
 * Assertions are on the hydrated arrays and on the REQUEST BODY, never on a
 * rendered string: a string can match while the payload has quietly reverted to
 * sending a study id.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn().mockResolvedValue({ id: 'opp-1' }),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([
    { id: 'study_other', title: 'Someone else', status: 'launched', kind: 'recorded' },
    { id: 'study_other_survey', title: 'Someone else', status: 'launched', kind: 'survey' }
  ])
}));

vi.mock('../../api/firsthand-studies', async (importActual) => ({
  ...(await importActual<typeof import('../../api/firsthand-studies')>()),
  getFirstHandStudy: vi.fn()
}));

const recordedOpportunity = {
  id: 'opp-1',
  type: 'unmoderated',
  title: 'Checkout walkthrough',
  purpose_one_liner: 'Watch people try to complete a checkout end to end',
  description_optional: '',
  product_optional: '',
  status: 'draft',
  default_duration_minutes: 30,
  firsthand_study_id: 'study_demo',
  participant_type_required: 'any',
  start_date: '2026-09-01',
  end_date: '2026-09-30'
};

const surveyOpportunity = {
  id: 'opp-2',
  type: 'survey',
  title: 'Developer experience pulse',
  purpose_one_liner: 'Ten short questions about the tools you use every day',
  description_optional: '',
  product_optional: '',
  status: 'draft',
  default_duration_minutes: 30,
  delivery_mode: 'native',
  firsthand_study_id: 'study_questions',
  participant_type_required: 'any'
};

const RECORDED_STEPS: StudyStep[] = [
  {
    step_id: 'study_demo_step_1',
    order: 1,
    type: 'instruction',
    prompt: 'Open the basket and read what is in it aloud',
    // Authored in the Task Lists area, not here - which is the point. This
    // field was hydrated into state and then dropped from the payload, so a
    // save that changed only the opportunity's title deleted it.
    helper_text: 'Say what you notice as you go',
    target_url: 'https://shop.test/basket'
  },
  {
    step_id: 'study_demo_step_2',
    order: 2,
    type: 'single_choice',
    prompt: 'Which delivery option would you pick?',
    options: ['Standard', 'Next day'],
    is_required: true,
    target_url: 'https://shop.test/basket'
  },
  { step_id: 'study_demo_step_end', order: 3, type: 'end', prompt: 'Thanks' }
];

const SURVEY_STEPS: StudyStep[] = [
  { step_id: 'study_questions_step_1', order: 1, type: 'open_text', prompt: 'Which tool slows you down?' },
  {
    step_id: 'study_questions_step_2',
    order: 2,
    type: 'rating',
    prompt: 'How happy are you with the build times?',
    config: { scale_max: 7 }
  },
  { step_id: 'study_questions_step_3', order: 3, type: 'nps', prompt: 'Would you recommend it?' },
  { step_id: 'study_questions_step_end', order: 4, type: 'end', prompt: 'Thanks' }
];

const study = (overrides: Record<string, unknown> = {}) => ({
  study: {
    id: 'study_demo',
    title: 'Checkout walkthrough',
    intro_text: 'Intro',
    consent_text: 'The bespoke wording this researcher actually wrote',
    kind: 'recorded',
    status: 'launched',
    estimated_duration_minutes: 18,
    owner_user_id: 'admin-1',
    updated_at: '2026-08-19T09:30:00.000Z',
    ...overrides
  },
  steps: (overrides.steps as StudyStep[]) ?? RECORDED_STEPS,
  can_edit: overrides.can_edit ?? true
});

/**
 * The shape of an identity minted for a question that has never been saved.
 *
 * A v4 uuid from `mintClientId`, matched rather than compared, because the
 * value is random by design. Written as a pattern rather than `expect.any
 * (String)` so that the positional fallback - `step_1`, the very thing F2
 * replaced - would fail it.
 */
const A_MINTED_IDENTITY = expect.stringMatching(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
);

const renderEdit = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

/**
 * Open every collapsed card.
 *
 * B2 collapses authored questions and tasks by default, so their prompt fields
 * do not exist until the card is opened. Doubles as the hydration wait these
 * tests used to get from `findAllByLabelText`: the summaries are the first
 * thing rendered from server state.
 */
const openAllCards = async (): Promise<void> => {
  const summaries = await screen.findAllByRole('button', { expanded: false });
  summaries.forEach((summary) => fireEvent.click(summary));
};

/** The body of the save this interaction produced. */
const savedBody = () =>
  vi.mocked(updateOpportunity).mock.calls[0][1] as Record<string, never>;

/**
 * The same body as it actually crosses the wire.
 *
 * `{ key: undefined }` still HAS the key as far as `toHaveProperty` is
 * concerned, but JSON.stringify drops it and the API never sees it - so an
 * assertion about a field being absent has to be made after serialisation or
 * it is testing the object literal rather than the request.
 */
const sentBody = () => JSON.parse(JSON.stringify(savedBody()));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(updateOpportunity).mockResolvedValue({ id: 'opp-1' } as never);
});


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
 * The consent editor, opened the way an author opens it.
 *
 * A study whose stored wording is not the approved wording arrives classified
 * `custom`, so the editor is already unlocked; one on the template arrives
 * locked and has to be unlocked deliberately. Handling both here means a test
 * asserting on the WORDING does not also have to know which of the two it is
 * looking at - while still going through the lock rather than around it.
 */
const consentField = (): HTMLTextAreaElement => {
  const unlock = screen.queryByRole('button', { name: /Customise consent wording/i });

  if (unlock) {
    fireEvent.click(unlock);
  }

  return screen.getByLabelText(/Consent text/i) as HTMLTextAreaElement;
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

describe('the pure hydration helpers', () => {
  it('drops the appended completion marker and nothing else', () => {
    expect(authoredStepsOf(RECORDED_STEPS).map((step) => step.step_id)).toEqual([
      'study_demo_step_1',
      'study_demo_step_2'
    ]);
  });

  it('keeps only the fields the task-list form can author', () => {
    // step_id, order and target_url are bookkeeping the author never writes and
    // inlineStudyStepSchema does not accept. A spread instead of a whitelist
    // would round-trip them into state, where the payload builder would drop
    // them again - leaving the form's copy and the study disagreeing.
    expect(toInlineStudyStep(RECORDED_STEPS[1])).toEqual({
      type: 'single_choice',
      prompt: 'Which delivery option would you pick?',
      options: ['Standard', 'Next day'],
      is_required: true
    });
    // And the payload keeps what hydration kept. These two lists disagreeing is
    // the whole defect, so they are asserted together rather than in two files.
    expect(
      toInlineStudyPayloadStep({
        ...toInlineStudyStep(RECORDED_STEPS[1]),
        _clientId: 'task-identity'
      })
    ).toEqual({
      // The identity F2 promoted. Asserted here rather than only in its own
      // test because this is the list that decides what a save carries, and a
      // payload builder that stopped sending it would restore positional ids
      // with every other assertion in this file still green.
      step_key: 'task-identity',
      type: 'single_choice',
      prompt: 'Which delivery option would you pick?',
      options: ['Standard', 'Next day'],
      is_required: true
    });
  });

  it('carries a rating scale onto a hydrated question', () => {
    // surveyQuestionSchema is .strict(), so config has to survive the trip or
    // the rating comes back as an unset scale and the save is refused.
    expect(toSurveyQuestion(SURVEY_STEPS[1])).toEqual({
      type: 'rating',
      prompt: 'How happy are you with the build times?',
      config: { scale_max: 7 }
    });
  });

  it('copies the option array rather than aliasing the response', () => {
    const hydrated = toInlineStudyStep(RECORDED_STEPS[1]);
    hydrated.options![0] = 'Edited';
    expect(RECORDED_STEPS[1].options).toEqual(['Standard', 'Next day']);
  });

  it('refuses a recorded study holding a step type the task list cannot author', () => {
    const withRating: StudyStep[] = [
      { step_id: 'study_demo_step_1', order: 1, type: 'rating', prompt: 'Rate it', config: { scale_max: 5 } },
      { step_id: 'study_demo_step_end', order: 2, type: 'end', prompt: 'Thanks' }
    ];
    expect(studyRoundTripsCleanly(withRating, 'recorded', 'study_demo')).toBe(false);
    // The same steps ARE authorable as a survey - the vocabularies differ, and
    // the check has to read the study's kind rather than one global set.
    expect(studyRoundTripsCleanly(withRating, 'survey', 'study_demo')).toBe(true);
  });

  it('does not count the completion marker as unauthorable', () => {
    expect(studyRoundTripsCleanly(RECORDED_STEPS, 'recorded', 'study_demo')).toBe(true);
  });

  it('refuses a task list whose steps have DIFFERENT starting URLs', () => {
    // getPrimaryTargetUrl collapses the study to one URL and toStudySteps then
    // stamps it onto every step, so step 2 would be silently repointed at
    // step 1's page - while a screen recording is running. Nothing downstream
    // compares target_url, so nothing else would catch it.
    const divergent: StudyStep[] = [
      { step_id: 'study_demo_step_1', order: 1, type: 'instruction', prompt: 'Open the basket', target_url: 'https://shop.test/basket' },
      { step_id: 'study_demo_step_2', order: 2, type: 'instruction', prompt: 'Now check out', target_url: 'https://shop.test/checkout' },
      { step_id: 'study_demo_step_end', order: 3, type: 'end', prompt: 'Thanks' }
    ];
    expect(studyRoundTripsCleanly(divergent, 'recorded', 'study_demo')).toBe(false);

    // One shared URL is fine - that IS what this form can express.
    const shared = divergent.map((step) =>
      step.target_url ? { ...step, target_url: 'https://shop.test/basket' } : step
    );
    expect(studyRoundTripsCleanly(shared, 'recorded', 'study_demo')).toBe(true);
  });

  it('tolerates stored whitespace rather than locking the author out for it', () => {
    // The payload trims. Comparing a trimmed value against an untrimmed stored
    // one would report a difference the author did not make, and lock a study
    // read-only for a cosmetic reason.
    const padded: StudyStep[] = [
      { step_id: 'study_demo_step_1', order: 1, type: 'instruction', prompt: '  Open the basket  ' },
      { step_id: 'study_demo_step_end', order: 2, type: 'end', prompt: 'Thanks' }
    ];
    expect(studyRoundTripsCleanly(padded, 'recorded', 'study_demo')).toBe(true);
  });
});

/**
 * What the payload builders send, listed rather than spread.
 *
 * B2 hangs a client-side `_clientId` on every authored item so the list can key
 * on identity instead of position, and F2 made that value the question's
 * PERSISTED identity - sent as `step_key`, never as `_clientId` itself.
 * `surveyQuestionSchema` is `.strict()`, so a question carrying the raw field
 * would be REFUSED - the whole save, not the field. Nothing deletes it: the
 * builders name the fields they send, and these assertions are on the exact key
 * set, so widening the mapper to a spread, quietly dropping a real field, and
 * dropping the identity all fail here.
 */
/**
 * F2. Where a question's persisted identity comes from, and what happens when
 * it cannot be recovered.
 */
describe('the identity a hydrated study carries', () => {
  it('recovers each question\'s identity from the id it is already stored under', () => {
    const authored = authoredStepsOf(RECORDED_STEPS);

    expect(
      withStoredIdentity(authored.map(toInlineStudyStep), authored, 'study_demo').map(
        (item) => item._clientId
      )
    ).toEqual(['step_1', 'step_2']);
  });

  it('round-trips a stored id back to itself, unchanged', () => {
    // The one property everything rests on. If it does not hold, a save
    // renumbers every question and detaches every answer already collected.
    //
    // NOT `SURVEY_STEPS`, and that is the whole reason this fixture is local.
    // Those ids are `_step_1`.._step_3`, which is exactly what the POSITIONAL
    // fallback produces - so a `toSurveySteps` that ignored identity entirely
    // would rebuild the same three ids and this assertion would pass against
    // the defect it exists to catch. An independent mutation pass proved that:
    // the headline mutation survived the whole frontend suite. Keys that are
    // not positions are what make the test capable of failing.
    const authored: StudyStep[] = [
      { step_id: 'study_questions_aaaa1111', order: 1, type: 'open_text', prompt: 'Which tool slows you down?' },
      {
        step_id: 'study_questions_bbbb2222',
        order: 2,
        type: 'rating',
        prompt: 'How happy are you with the build times?',
        config: { scale_max: 7 }
      },
      { step_id: 'study_questions_cccc3333', order: 3, type: 'nps', prompt: 'Would you recommend it?' }
    ];

    const rewritten = toSurveySteps(
      withStoredIdentity(authored.map(toSurveyQuestion), authored, 'study_questions').map(
        toSurveyPayloadStep
      ),
      'study_questions'
    );

    expect(
      rewritten.filter((step) => step.type !== 'end').map((step) => step.step_id)
    ).toEqual([
      'study_questions_aaaa1111',
      'study_questions_bbbb2222',
      'study_questions_cccc3333'
    ]);
  });

  it('keeps each question on its own id when the author reorders them', () => {
    // The behaviour the whole step exists for, asserted on the FRONTEND side
    // rather than only in the shared module's own tests - the frontend imports
    // a committed COPY of that module, and a mutation applied to both copies at
    // once satisfies the drift check.
    const authored: StudyStep[] = [
      { step_id: 'study_questions_aaaa1111', order: 1, type: 'open_text', prompt: 'First' },
      { step_id: 'study_questions_bbbb2222', order: 2, type: 'open_text', prompt: 'Second' },
      { step_id: 'study_questions_cccc3333', order: 3, type: 'open_text', prompt: 'Third' }
    ];

    const hydrated = withStoredIdentity(
      authored.map(toSurveyQuestion),
      authored,
      'study_questions'
    );

    const rewritten = toSurveySteps(
      [...hydrated].reverse().map(toSurveyPayloadStep),
      'study_questions'
    ).filter((step) => step.type !== 'end');

    // Reversed, and every id still names the question whose prompt it arrived
    // with. Asserting the prompts alone, or the count, passes against the
    // positional ids that re-attributed four participants' answers.
    expect(rewritten.map((step) => [step.step_id, step.prompt, step.order])).toEqual([
      ['study_questions_cccc3333', 'Third', 1],
      ['study_questions_bbbb2222', 'Second', 2],
      ['study_questions_aaaa1111', 'First', 3]
    ]);
  });

  it('offers a study read-only when its ids are outside its own namespace', () => {
    // Nothing this product writes produces such an id, and if one existed this
    // form could not write it back unchanged - the save would renumber every
    // question. `studyRoundTripsCleanly` is what turns that into a read-only
    // banner instead of silent damage, and it catches it BY RUNNING THE ROUND
    // TRIP rather than by a rule anybody had to remember to add.
    const foreign: StudyStep[] = [
      { step_id: 'a-bare-id', order: 1, type: 'instruction', prompt: 'Open the basket' },
      { step_id: 'study_demo_step_end', order: 2, type: 'end', prompt: 'Thanks' }
    ];

    expect(studyRoundTripsCleanly(foreign, 'recorded', 'study_demo')).toBe(false);
  });

  it('still authors a study whose ids ARE in its namespace', () => {
    // The pair. Without it the assertion above is satisfied by a check that
    // refuses everything.
    const owned: StudyStep[] = [
      { step_id: 'study_demo_step_1', order: 1, type: 'instruction', prompt: 'Open the basket' },
      { step_id: 'study_demo_step_end', order: 2, type: 'end', prompt: 'Thanks' }
    ];

    expect(studyRoundTripsCleanly(owned, 'recorded', 'study_demo')).toBe(true);
  });
});

describe('the fields a payload carries', () => {
  it('sends exactly the survey fields the contract accepts', () => {
    const built = toSurveyPayloadStep(
      withClientId({
        type: 'single_choice',
        prompt: '  Which delivery option would you pick?  ',
        options: ['Standard', 'Next day'],
        is_required: true,
        helper_text: 'Pick the one you would actually use'
      })
    );

    expect(Object.keys(built).sort()).toEqual([
      'helper_text',
      'is_required',
      'options',
      'prompt',
      'step_key',
      'type'
    ]);
    expect(built.prompt).toBe('Which delivery option would you pick?');
  });

  it('sends exactly the task fields the contract accepts', () => {
    const built = toInlineStudyPayloadStep(
      withClientId({
        type: 'instruction',
        prompt: 'Open the basket and read what is in it aloud',
        is_required: false,
        helper_text: 'Out loud, not in your head'
      })
    );

    expect(Object.keys(built).sort()).toEqual([
      'helper_text',
      'is_required',
      'prompt',
      'step_key',
      'type'
    ]);
  });

  /**
   * `findStepShapeProblem` refuses a scale on a recommendation score outright,
   * which is why the config whitelist is per type rather than "send it if it is
   * there". Preserving a rating's scale in state through a type change is only
   * safe because of this line.
   */
  it('leaves a preserved scale behind when the question is a recommendation score', () => {
    expect(
      toSurveyPayloadStep({
        _clientId: 'k',
        type: 'nps',
        prompt: 'Would you recommend us?',
        config: { scale_max: 7 }
      })
    ).toEqual({ step_key: 'k', type: 'nps', prompt: 'Would you recommend us?' });
  });

  /**
   * `multi_choice` is in the whitelist because `findStepShapeProblem` gives it
   * `min_selections`/`max_selections`. Only the widening direction was pinned -
   * adding `nps` failed three tests - while NARROWING it, which silently drops
   * an author's selection bounds on save and flips such a stored study to
   * read-only, failed nothing. The direction that destroys content is the one
   * that needed the test.
   */
  it('sends the selection bounds a multiple choice can carry', () => {
    expect(
      toSurveyPayloadStep({
        _clientId: 'k',
        type: 'multi_choice',
        prompt: 'Which of these do you use?',
        options: ['Jira', 'Confluence', 'Bitbucket'],
        config: { min_selections: 1, max_selections: 2 }
      })
    ).toEqual({
      step_key: 'k',
      type: 'multi_choice',
      prompt: 'Which of these do you use?',
      options: ['Jira', 'Confluence', 'Bitbucket'],
      config: { min_selections: 1, max_selections: 2 }
    });
  });

  it('still authors a stored multiple choice that carries selection bounds', () => {
    const stored: StudyStep[] = [
      {
        step_id: 'study_demo_step_1',
        order: 1,
        type: 'multi_choice',
        prompt: 'Which of these do you use?',
        options: ['Jira', 'Confluence', 'Bitbucket'],
        config: { min_selections: 1, max_selections: 2 }
      },
      { step_id: 'study_demo_step_end', order: 2, type: 'end', prompt: 'Thanks' }
    ];

    expect(studyRoundTripsCleanly(stored, 'survey', 'study_demo')).toBe(true);
  });

  it('still sends the scale a rating actually needs', () => {
    expect(
      toSurveyPayloadStep({
        _clientId: 'k',
        type: 'rating',
        prompt: 'How happy are you with it?',
        config: { scale_max: 7 }
      })
    ).toEqual({
      step_key: 'k',
      type: 'rating',
      prompt: 'How happy are you with it?',
      config: { scale_max: 7 }
    });
  });

  /**
   * Narrowing the whitelist narrows `studyRoundTripsCleanly` with it, and that
   * is the safe direction: a stored question this form would now strip is
   * offered READ-ONLY rather than loaded into a surface that would drop part of
   * it on the next save. The stored shape here is one the contract refuses
   * anyway, so it could never have been saved from this form.
   */
  it('refuses to author a stored question whose config it would drop', () => {
    const stored: StudyStep[] = [
      {
        step_id: 'study_demo_step_1',
        order: 1,
        type: 'nps',
        prompt: 'Would you recommend us?',
        config: { scale_max: 7 }
      },
      { step_id: 'study_demo_step_end', order: 2, type: 'end', prompt: 'Thanks' }
    ];

    expect(studyRoundTripsCleanly(stored, 'survey', 'study_demo')).toBe(false);
  });

  it('still authors a stored rating, which is the config that means something', () => {
    const stored: StudyStep[] = [
      {
        step_id: 'study_demo_step_1',
        order: 1,
        type: 'rating',
        prompt: 'How happy are you with it?',
        config: { scale_max: 7 }
      },
      { step_id: 'study_demo_step_end', order: 2, type: 'end', prompt: 'Thanks' }
    ];

    expect(studyRoundTripsCleanly(stored, 'survey', 'study_demo')).toBe(true);
  });
});

/**
 * The property the whole class of loss reduces to.
 *
 * Hydrate, build the payload, expand it the way the backend will store it, and
 * require the result to equal what was already there. This one assertion fails
 * on a dropped `helper_text`, a dropped `is_required`, and a flattened
 * `target_url` alike - which is why it exists instead of three hand-written
 * expected bodies that each had to be remembered.
 */
describe('the hydrate → save round trip is lossless', () => {
  it('reproduces a StudyEditor-built task list exactly', () => {
    const stored: StudyStep[] = [
      {
        step_id: 'study_demo_step_001',
        order: 1,
        type: 'instruction',
        prompt: 'Open the basket',
        helper_text: 'Say what you notice',
        target_url: 'https://shop.test/basket'
      },
      {
        step_id: 'study_demo_step_002',
        order: 2,
        type: 'single_choice',
        prompt: 'Which delivery option?',
        options: ['Standard', 'Next day'],
        is_required: true,
        target_url: 'https://shop.test/basket'
      },
      { step_id: 'study_demo_step_end', order: 3, type: 'end', prompt: 'Thanks' }
    ];

    const authored = authoredStepsOf(stored);
    const payload = withStoredIdentity(
      authored.map(toInlineStudyStep),
      authored,
      'study_demo'
    ).map(toInlineStudyPayloadStep);
    const rewritten = authoredStepsOf(
      toStudySteps(payload, 'study_demo', 'https://shop.test/basket')
    );

    // Everything the participant can see must survive. step_id is checked
    // separately below rather than here, so a failure says which of the two
    // things broke.
    const visible = (step: StudyStep) => ({
      type: step.type,
      prompt: step.prompt,
      options: step.options ?? null,
      helper_text: step.helper_text ?? null,
      is_required: step.is_required ?? false,
      target_url: step.target_url ?? null
    });

    expect(rewritten.map(visible)).toEqual(authored.map(visible));

    // And the IDENTITY survives, which is the half a content comparison cannot
    // see. These stored ids are ZERO-PADDED (`_step_002`, what StudyEditor
    // mints) while the positional fallback is unpadded, so a builder that had
    // gone back to deriving ids from position would produce `_step_2` here and
    // this assertion would fail where every content assertion above still
    // passed.
    expect(rewritten.map((step) => step.step_id)).toEqual(
      authored.map((step) => step.step_id)
    );
  });
});

describe('reopening an opportunity that has a task list', () => {
  it('sends back exactly the steps the study held, with no completion marker', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');

    // Editing the title is what makes hasChanges true; the assertion is about
    // what rides along with it.
    const title = await screen.findByDisplayValue('Checkout walkthrough');
    fireEvent.change(title, { target: { value: 'Checkout walkthrough v2' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    expect(savedBody().inline_study).toEqual({
      target_url: 'https://shop.test/basket',
      consent_text: 'The bespoke wording this researcher actually wrote',
      estimated_duration_minutes: 18,
      steps: [
        {
          // The identity recovered from the STORED id (`study_demo_step_1`),
          // not a freshly minted one - so this save writes the same step id
          // back and anything already answered against it stays attached. A
          // hydrator that minted new ids would still pass every content
          // assertion below.
          step_key: 'step_1',
          type: 'instruction',
          prompt: 'Open the basket and read what is in it aloud',
          // Both of these used to be hydrated and then dropped here, so the
          // save deleted them from the stored study.
          helper_text: 'Say what you notice as you go'
        },
        {
          step_key: 'step_2',
          type: 'single_choice',
          prompt: 'Which delivery option would you pick?',
          options: ['Standard', 'Next day'],
          is_required: true
        }
      ]
    });
    // Exactly one of the two. Sending both is refused by the API, and sending
    // the id alone is the old behaviour that made the content unwritable.
    expect(savedBody().firsthand_study_id).toBeUndefined();
  });

  /**
   * F1. A1 captured the linked study's `updated_at` into form state and logged
   * it; this is where it starts being used for the thing it was captured for.
   *
   * Asserted on the REQUEST BODY, never on a rendered string, for the reason
   * this whole file states at the top: a banner can be right while the payload
   * has quietly stopped carrying the precondition, and a precondition that is
   * not sent is a lost-update protection that does not exist.
   */
  describe('optimistic concurrency on the linked study', () => {
    /** A 409 shaped as PATCH /api/opportunities/:id answers one. */
    const staleRejection = (currentUpdatedAt = '2026-08-21T11:00:00.000Z') => ({
      response: {
        status: 409,
        data: {
          error: 'stale_study',
          message:
            'Somebody else saved changes to this task list after you opened this opportunity. Nothing has been saved, and your edits are still here - save again to replace their version, or open the opportunity in a new tab to compare first.',
          current_updated_at: currentUpdatedAt
        }
      }
    });

    const openEditedForm = async () => {
      vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
      vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

      renderEdit('/admin/opportunities/opp-1/edit');

      const title = await screen.findByDisplayValue('Checkout walkthrough');
      fireEvent.change(title, { target: { value: 'Checkout walkthrough v2' } });

      return title;
    };

    const save = async () =>
      fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    it('sends the study revision it loaded as the precondition', async () => {
      await openEditedForm();
      await save();

      await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

      expect(sentBody().expected_study_updated_at).toBe('2026-08-19T09:30:00.000Z');
    });

    it('omits the precondition when the study was served without one', async () => {
      // Absent has to mean "no claim". A null would be refused by the schema
      // and would 400 every save from a study whose row predates the field.
      vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
      vi.mocked(getFirstHandStudy).mockResolvedValue(
        study({ updated_at: undefined }) as never
      );

      renderEdit('/admin/opportunities/opp-1/edit');
      const title = await screen.findByDisplayValue('Checkout walkthrough');
      fireEvent.change(title, { target: { value: 'Checkout walkthrough v2' } });
      await save();

      await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

      expect(sentBody()).not.toHaveProperty('expected_study_updated_at');
    });

    it('keeps every local edit when the save is refused as stale', async () => {
      vi.mocked(updateOpportunity).mockRejectedValueOnce(staleRejection());

      await openEditedForm();
      await save();

      await screen.findByText(/Somebody else saved this while you were editing/i);

      // The promise the banner makes, checked against the form rather than
      // against the sentence.
      expect(screen.getByDisplayValue('Checkout walkthrough v2')).toBeTruthy();
    });

    it('does not reload the opportunity behind the conflict', async () => {
      // `loadOpportunity` rebuilds the whole form from the server, so a reload
      // here would discard exactly the unsaved work the refusal protects. The
      // narrow study read that refreshes the precondition is a different call
      // and is expected.
      vi.mocked(updateOpportunity).mockRejectedValueOnce(staleRejection());

      await openEditedForm();
      const loadsBefore = vi.mocked(getOpportunity).mock.calls.length;
      await save();

      await screen.findByText(/Somebody else saved this while you were editing/i);

      expect(vi.mocked(getOpportunity).mock.calls.length).toBe(loadsBefore);
    });

    it('saves again against what is now stored, so the author is not locked out', async () => {
      // Without advancing the precondition the second save re-sends the same
      // stale revision and is refused again, forever - and there is no other
      // control anywhere that would let the author keep their work.
      vi.mocked(updateOpportunity).mockRejectedValueOnce(
        staleRejection('2026-08-21T11:00:00.000Z')
      );

      await openEditedForm();
      await save();
      await screen.findByText(/Somebody else saved this while you were editing/i);

      await save();

      await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(2));

      const second = JSON.parse(
        JSON.stringify(vi.mocked(updateOpportunity).mock.calls[1][1])
      );
      expect(second.expected_study_updated_at).toBe('2026-08-21T11:00:00.000Z');
    });

    /**
     * The regression the review caught, and it is the one an author hits within
     * minutes of the feature working as designed.
     *
     * `staleStudyUpdatedAt` takes precedence over `linkedStudyUpdatedAt` when
     * the precondition is built. Left set after a save succeeds, it permanently
     * shadows the value `loadOpportunity` has just refreshed - so every later
     * save in the session is refused against a revision two writes old, and the
     * banner accuses a colleague who did nothing.
     */
    it('does not manufacture a second conflict after recovering from a real one', async () => {
      vi.mocked(updateOpportunity).mockRejectedValueOnce(
        staleRejection('2026-08-21T11:00:00.000Z')
      );

      vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
      // What the study looks like after the second (successful) save, which is
      // what `loadOpportunity` re-reads and what the THIRD save must carry.
      vi.mocked(getFirstHandStudy)
        .mockResolvedValueOnce(study() as never)
        .mockResolvedValue(
          study({ updated_at: '2026-08-21T12:00:00.000Z' }) as never
        );

      renderEdit('/admin/opportunities/opp-1/edit');
      const title = await screen.findByDisplayValue('Checkout walkthrough');
      fireEvent.change(title, { target: { value: 'Checkout walkthrough v2' } });

      await save();
      await screen.findByText(/Somebody else saved this while you were editing/i);

      // The deliberate re-save, which succeeds.
      await save();
      await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(2));
      // Wait for the save to settle before the next one: handleSubmit has a
      // double-click guard, so clicking again while `saving` is still true is
      // refused before it builds a payload. The conflict banner clearing is
      // the observable end of that second save.
      await waitFor(() =>
        expect(
          screen.queryByText(/Somebody else saved this while you were editing/i)
        ).toBeNull()
      );

      // A third, ordinary save. It must carry what the row holds NOW, not the
      // revision the conflict handed back two writes ago.
      //
      // The successful save re-runs `loadOpportunity`, which rebuilds the form
      // from the server - so the title field is back to the stored value here,
      // and waiting for that is also how this test knows the reload finished.
      const reloaded = await screen.findByDisplayValue('Checkout walkthrough');
      fireEvent.change(reloaded, {
        target: { value: 'Checkout walkthrough v3' }
      });

      // Wait for the button to come back rather than clicking blind. The save
      // controls are disabled while `saving` is true AND for as long as the
      // success message is up - 3000ms on a draft, which this fixture is - so
      // the wait has to outlast that timer or the third click never lands.
      const saveButton = await screen.findByRole('button', {
        name: /Save Changes/i
      });
      await waitFor(() => expect(saveButton).not.toBeDisabled(), {
        timeout: 5000
      });
      fireEvent.click(saveButton);

      await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(3));

      const third = JSON.parse(
        JSON.stringify(vi.mocked(updateOpportunity).mock.calls[2][1])
      );
      expect(third.expected_study_updated_at).toBe('2026-08-21T12:00:00.000Z');
      expect(third.expected_study_updated_at).not.toBe('2026-08-21T11:00:00.000Z');
    });

    it('does not treat a lock-timeout 409 as somebody else saving', async () => {
      // errorHandler maps a unique-constraint violation and lock-not-available
      // to 409 as well. Reading the status alone would tell the author a
      // colleague had saved when none had - and then advance the precondition,
      // so the next click would overwrite a colleague who genuinely had.
      vi.mocked(updateOpportunity).mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            error: 'Resource is currently locked, please try again',
            code: 'CONFLICT'
          }
        }
      });

      await openEditedForm();
      await save();

      await screen.findByText('Resource is currently locked, please try again');
      expect(
        screen.queryByText(/Somebody else saved this while you were editing/i)
      ).toBeNull();
    });

    it('does not show the conflict banner for an ordinary failure', async () => {
      vi.mocked(updateOpportunity).mockRejectedValueOnce({
        response: { status: 400, data: { error: 'Something else went wrong' } }
      });

      await openEditedForm();
      await save();

      await screen.findByText('Something else went wrong');
      expect(
        screen.queryByText(/Somebody else saved this while you were editing/i)
      ).toBeNull();
    });
  });

  it('renders the author their own tasks instead of the reuse picker', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

    // Collapsed first, which is what B2 changed: the author sees the shape of
    // the list before they see any one task's wording. Asserted here rather
    // than only in the component suite, because it is what makes the expansion
    // below necessary at all.
    expect(
      (await screen.findAllByRole('button', { expanded: false })).length
    ).toBe(2);
    await openAllCards();

    // Two authored steps, so two identically-labelled prompts - queried as a
    // list, because getByLabelText would fail on the ambiguity and hide which
    // step is actually being asserted.
    const prompts = (await screen.findAllByLabelText(
      /What the participant sees/i
    )) as HTMLTextAreaElement[];
    expect(prompts.map((field) => field.value)).toEqual([
      'Open the basket and read what is in it aloud',
      'Which delivery option would you pick?'
    ]);
    goToConsentStep();
    // The stored wording is nobody's approved wording, so the step must say so
    // as well as showing it: asserting only the text would keep passing if the
    // classification were dropped.
    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      /Custom wording/i
    );
    expect(consentField().value).toBe(
      'The bespoke wording this researcher actually wrote'
    );
    fireEvent.click(screen.getByRole('button', { name: /^Previous: Task List$/i }));
    expect(
      (screen.getByLabelText(/Starting URL/i) as HTMLInputElement).value
    ).toBe('https://shop.test/basket');
    expect(screen.queryByText('-- Select a launched task list --')).not.toBeInTheDocument();
  });

  it('captures the study revision the form loaded', async () => {
    // The only thing this stamp can do today is name which revision an author
    // was editing when a lost update is reported; F1 turns it into a
    // precondition and D2 sends it with an autosave. Asserted through the save
    // log because that is the only place it is observable.
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');

    const title = await screen.findByDisplayValue('Checkout walkthrough');
    fireEvent.change(title, { target: { value: 'Checkout walkthrough v2' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    const submitLog = debug.mock.calls.find(([message]) => message === 'handleSubmit called');
    expect(submitLog?.[1]).toMatchObject({
      linkedStudyUpdatedAt: '2026-08-19T09:30:00.000Z'
    });
  });
});

describe('reopening an opportunity that has questions', () => {
  it('sends back every question, including a rating scale and an NPS', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(surveyOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({
        id: 'study_questions',
        kind: 'survey',
        consent_text: 'Answers are stored for research analysis',
        estimated_duration_minutes: null,
        steps: SURVEY_STEPS
      }) as never
    );

    renderEdit('/admin/opportunities/opp-2/edit');

    const title = await screen.findByDisplayValue('Developer experience pulse');
    fireEvent.change(title, { target: { value: 'Developer experience pulse 2026' } });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    expect(savedBody().inline_survey).toEqual({
      consent_text: 'Answers are stored for research analysis',
      // A null duration must stay unstated rather than becoming a number the
      // participant is then told.
      estimated_duration_minutes: undefined,
      steps: [
        // Each identity recovered from its STORED id (`study_questions_step_N`),
        // so a save writes the same three ids back. See the task-list twin.
        { step_key: 'step_1', type: 'open_text', prompt: 'Which tool slows you down?' },
        {
          step_key: 'step_2',
          type: 'rating',
          prompt: 'How happy are you with the build times?',
          config: { scale_max: 7 }
        },
        { step_key: 'step_3', type: 'nps', prompt: 'Would you recommend it?' }
      ]
    });
    expect(savedBody().firsthand_study_id).toBeUndefined();
  });

  /**
   * The survey twin of the task-list identity test, and it was missing.
   *
   * Hydrating without client ids is invisible to a payload assertion - the
   * builders do not read them - but it is exactly the defect this step exists
   * to fix, on the path an author's EXISTING content is on. With no ids every
   * card renders `key={undefined}`, so opening one opens all three and
   * `remapAuthoringErrors` maps every question to the same index.
   */
  it('gives each reopened question an identity of its own', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(surveyOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({
        id: 'study_questions',
        kind: 'survey',
        consent_text: 'Answers are stored for research analysis',
        estimated_duration_minutes: null,
        steps: SURVEY_STEPS
      }) as never
    );

    renderEdit('/admin/opportunities/opp-2/edit');
    await screen.findByDisplayValue('Developer experience pulse');
    fireEvent.click(screen.getByRole('button', { name: /Questions/i }));

    const collapsed = await screen.findAllByRole('button', { expanded: false });
    expect(collapsed).toHaveLength(3);

    // Open exactly one. Shared identity opens all of them, and the count is
    // what says so - the wording alone would not.
    fireEvent.click(collapsed[1]);

    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);
    expect(
      (screen.getByLabelText(/What the participant is asked/i) as HTMLTextAreaElement)
        .value
    ).toBe('How happy are you with the build times?');
  });
});

/**
 * Reopening a study whose content was taken as a copy. Provenance is written
 * once at create and read back on every later load - all of the existing
 * `Copied from` assertions elsewhere in this file are on the CREATE flow, so
 * none of them exercise this path at all.
 */
describe('reopening a task list that was copied from another', () => {
  const SOURCE = {
    study: {
      id: 'study_source',
      title: 'Original checkout walkthrough',
      intro_text: 'Intro',
      consent_text: 'irrelevant here',
      kind: 'recorded',
      status: 'launched',
      estimated_duration_minutes: 5,
      owner_user_id: 'someone-else',
      updated_at: '2026-08-01T00:00:00.000Z'
    },
    steps: [
      { step_id: 'study_source_step_1', order: 1, type: 'instruction', prompt: 'Open the basket' },
      { step_id: 'study_source_step_end', order: 2, type: 'end', prompt: 'Thanks' }
    ],
    can_edit: true
  };

  it('names the source and the date the copy was taken', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy)
      .mockResolvedValueOnce(
        study({
          copied_from_study_id: 'study_source',
          created_at: '2026-08-10T00:00:00.000Z'
        }) as never
      )
      .mockResolvedValueOnce(SOURCE as never);

    renderEdit('/admin/opportunities/opp-1/edit');
    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

    expect(await screen.findByText(/Copied from/i)).toBeInTheDocument();
    expect(screen.getByText('Original checkout walkthrough')).toBeInTheDocument();
    expect(screen.getByText(/10 August 2026/i)).toBeInTheDocument();
    // The id is what a later save carries; sent for real regardless of
    // whether the note above could resolve a title for it.
    expect(vi.mocked(getFirstHandStudy)).toHaveBeenCalledWith('study_source');
  });

  it('degrades to "a set that no longer exists" when the source cannot be read, rather than rethrowing', async () => {
    // The reason it degrades rather than rethrowing: `copied_from_study_id`
    // deliberately has no foreign key, so the source can be gone. None of that
    // should stop the opportunity opening - only the note's wording changes.
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy)
      .mockResolvedValueOnce(
        study({
          copied_from_study_id: 'study_source',
          created_at: '2026-08-10T00:00:00.000Z'
        }) as never
      )
      .mockRejectedValueOnce(new Error('the source study is gone'));

    renderEdit('/admin/opportunities/opp-1/edit');
    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

    expect(await screen.findByText(/Copied from/i)).toBeInTheDocument();
    expect(screen.getByText(/a set that no longer exists/i)).toBeInTheDocument();
    // The opportunity itself still opened and is still editable - a failed
    // provenance lookup is not a failed study load.
    goToConsentStep();
    expect(consentField().value).toBe(study().study.consent_text);
  });
});

describe('a study this author may not change here', () => {
  it('shows the content read-only, says why, and sends the id rather than the content', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ owner_user_id: 'someone-else', can_edit: false }) as never
    );

    renderEdit('/admin/opportunities/opp-1/edit');

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

    expect(
      await screen.findByText(/belongs to another researcher/i)
    ).toBeInTheDocument();
    // And it does NOT tell them to go and fix it in the Task Lists area, which
    // applies the same ownership rule and would refuse them there too.
    expect(screen.queryByText(/open it in the Task Lists area/i)).not.toBeInTheDocument();
    // No editing surface, and no source choice either: with linking gone there
    // is nothing to repoint at, so offering a chooser would offer an action
    // that cannot be completed.
    expect(screen.queryByLabelText(/What the participant sees/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radio', { name: /Start from an existing task list/i })
    ).not.toBeInTheDocument();
    // What replaced the picker: the tasks themselves, as text - the WHOLE
    // list, in order. RECORDED_STEPS carries two authored steps; reading only
    // the first is exactly the shape that lets `items.slice(0, 1)` survive in
    // the component.
    const readOnlyItems = within(
      screen.getByTestId('read-only-study-content')
    ).getAllByRole('listitem');
    expect(readOnlyItems.map((item) => item.textContent)).toEqual([
      'Open the basket and read what is in it aloud',
      'Which delivery option would you pick?'
    ]);

    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
    fireEvent.change(await screen.findByDisplayValue('Checkout walkthrough'), {
      target: { value: 'Checkout walkthrough v2' }
    });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    // Nothing of the colleague's study is rewritten.
    expect(savedBody().inline_study).toBeUndefined();
    expect(savedBody().firsthand_study_id).toBe('study_demo');
  });

  it('treats a step type the form cannot show the same way, even for its owner', async () => {
    // A recorded study built by hand in the Task Lists area may hold a rating
    // step, which authorableStepTypes does not include. Loading it would show
    // a SHORTER list than the study has, and A0 would then delete the missing
    // steps on the next save - silent loss dressed as a successful save.
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({
        can_edit: true,
        owner_user_id: 'admin-1',
        steps: [
          { step_id: 'study_demo_step_1', order: 1, type: 'instruction', prompt: 'Open the basket' },
          {
            step_id: 'study_demo_step_2',
            order: 2,
            type: 'rating',
            prompt: 'Rate the basket',
            config: { scale_max: 5 }
          },
          { step_id: 'study_demo_step_end', order: 3, type: 'end', prompt: 'Thanks' }
        ]
      }) as never
    );

    renderEdit('/admin/opportunities/opp-1/edit');

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));
    expect(
      await screen.findByText(/uses something this form cannot show/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
    fireEvent.change(await screen.findByDisplayValue('Checkout walkthrough'), {
      target: { value: 'Checkout walkthrough v2' }
    });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    expect(savedBody().inline_study).toBeUndefined();
    expect(savedBody().firsthand_study_id).toBe('study_demo');
  });
});

/**
 * The survey twin of the read-only rendering above. `ReadOnlyStudyContent
 * items={questions}` -> `items={[]}` survives on the survey tab even though
 * the identical mutation is killed on the task tab, so this half of the
 * property was entirely unasserted.
 */
describe('a set of questions this author may not change here', () => {
  it('shows every question read-only, in order, and sends the id rather than the content', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(surveyOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({
        id: 'study_questions',
        kind: 'survey',
        owner_user_id: 'someone-else',
        can_edit: false,
        consent_text: 'Answers are stored for research analysis',
        estimated_duration_minutes: null,
        steps: SURVEY_STEPS
      }) as never
    );

    renderEdit('/admin/opportunities/opp-2/edit');

    fireEvent.click(await screen.findByRole('button', { name: /Questions/i }));

    // "belong to", not "belongs to" - the survey twin's copy is plural
    // ("These questions belong..."), unlike the task-list twin's singular.
    expect(
      await screen.findByText(/belong to another researcher/i)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/What the participant is asked/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radio', { name: /Start from an existing set of questions/i })
    ).not.toBeInTheDocument();

    // The whole array, in order - SURVEY_STEPS carries three authored
    // questions, so a single-item read here could not tell the right question
    // from the wrong one, and `items={[]}` would satisfy an empty-list check.
    const readOnlyItems = within(
      screen.getByTestId('read-only-study-content')
    ).getAllByRole('listitem');
    expect(readOnlyItems.map((item) => item.textContent)).toEqual([
      'Which tool slows you down?',
      'How happy are you with the build times?',
      'Would you recommend it?'
    ]);

    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
    fireEvent.change(await screen.findByDisplayValue('Developer experience pulse'), {
      target: { value: 'Developer experience pulse 2026' }
    });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    expect(savedBody().inline_survey).toBeUndefined();
    expect(savedBody().firsthand_study_id).toBe('study_questions');
  });
});

describe('a linked study the form would never render', () => {
  it('is not read at all when the opportunity hands off externally', async () => {
    // An external poll can still carry a study id: the column has no foreign
    // key and nothing clears it when the delivery mode changes. Reading it
    // would be pointless work, and a failed read would then block a save that
    // has nothing to do with the study.
    vi.mocked(getOpportunity).mockResolvedValue({
      ...surveyOpportunity,
      delivery_mode: 'external',
      external_link_optional: 'https://forms.test/dx'
    } as never);

    renderEdit('/admin/opportunities/opp-2/edit');
    await screen.findByDisplayValue('Developer experience pulse');

    expect(getFirstHandStudy).not.toHaveBeenCalled();
  });

  it('refuses to author a recorded task list through the questions surface', async () => {
    // A kind mismatch would hydrate into the wrong vocabulary, so the tab would
    // show an EMPTY editor for a study that is not empty - and the API refuses
    // the mismatch on save regardless.
    vi.mocked(getOpportunity).mockResolvedValue(surveyOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ id: 'study_questions', kind: 'recorded' }) as never
    );

    renderEdit('/admin/opportunities/opp-2/edit');

    fireEvent.click(await screen.findByRole('button', { name: /Questions/i }));
    expect(
      await screen.findByText(/use something this form cannot show/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
    fireEvent.change(await screen.findByDisplayValue('Developer experience pulse'), {
      target: { value: 'Developer experience pulse 2026' }
    });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());
    expect(savedBody().inline_survey).toBeUndefined();
    expect(savedBody().firsthand_study_id).toBe('study_questions');
  });
});

describe('emptying a list that is linked', () => {
  it('refuses to save a linked task list the author emptied', async () => {
    // `authoringInline` needs at least one step, so deleting them all used to
    // flip the payload back to sending the study id: the study kept every task,
    // the save reported success, and reopening brought them all back. Removing
    // a task is never disabled, so this was one click away on a draft.
    // No starting URL on any step, deliberately. A separate, older check
    // already refuses "a URL with no tasks"; the gap this closes is a task list
    // that never had a URL, where emptying it was answered by doing nothing.
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({
        steps: RECORDED_STEPS.filter((step) => step.type !== 'end').map(
          ({ target_url: _ignored, ...step }) => step
        )
      }) as never
    );

    renderEdit('/admin/opportunities/opp-1/edit');
    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));
    await screen.findAllByRole('button', { expanded: false });

    // Remove both tasks. The buttons are indexed, so the survivor becomes
    // "Remove task 1" in turn - waited on between clicks, because two
    // synchronous clicks both read the same pre-render state and only one
    // removal lands.
    //
    // Each removal is confirmed now: B2 asks before dropping a task that has
    // wording in it, and both of these do.
    const removeFirstTask = async (remaining: number) => {
      fireEvent.click(screen.getByRole('button', { name: /Remove task 1/i }));
      fireEvent.click(await screen.findByRole('button', { name: /^Remove task$/i }));
      await waitFor(() =>
        expect(screen.queryAllByRole('button', { expanded: false })).toHaveLength(
          remaining
        )
      );
    };
    await removeFirstTask(1);
    await removeFirstTask(0);

    submitFromLastStep(/^Save changes$/);

    await screen.findByRole('alert', { name: /There is a problem/i });
    expect(summarisedErrorKeys()).toEqual(['inline_study_steps']);
    // And beside the list itself, not only at the top of the page.
    expect(
      inlineErrorText(/A task list needs at least one task/i)
    ).toBeInTheDocument();
    expect(updateOpportunity).not.toHaveBeenCalled();
  });
});

describe('a duration the author cleared', () => {
  it('is sent as an explicit null so the study can lose it', async () => {
    // `undefined` omits the key, which the in-place path reads as "this request
    // says nothing about the duration" and leaves the stored value alone. The
    // form shows the field and its help text offers to leave it empty, so an
    // author who cleared a populated one got a successful save and the old
    // number still stored, with no way to remove it at all.
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');
    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

    const duration = await screen.findByLabelText(/Estimated completion time/i);
    expect((duration as HTMLInputElement).value).toBe('18');
    fireEvent.change(duration, { target: { value: '' } });

    submitFromLastStep(/^Save changes$/);
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    // Asserted after serialisation: null survives JSON, undefined would not,
    // and that difference IS the fix.
    expect(sentBody().inline_study.estimated_duration_minutes).toBeNull();
  });

  it('stays absent when the study never had one', async () => {
    // The other half of the same decision: nothing to say must remain nothing
    // to say, or a save would erase an estimate set by hand in StudyEditor.
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ estimated_duration_minutes: null }) as never
    );

    renderEdit('/admin/opportunities/opp-1/edit');
    fireEvent.change(await screen.findByDisplayValue('Checkout walkthrough'), {
      target: { value: 'Checkout walkthrough v2' }
    });
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    expect(sentBody().inline_study).not.toHaveProperty('estimated_duration_minutes');
  });
});

describe('the automatic estimate against a study that already has a duration', () => {
  /**
   * A stored duration is a decision, so reopening must not quietly re-derive
   * over it. The study here says 18 minutes and holds two tasks, which the
   * estimate would put at 7 - so a form that turned the estimate back on at
   * hydration would rewrite the number on a save about something else.
   */
  it('keeps the stored number through a save that changed something else', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Checkout walkthrough, second pass' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    expect(sentBody().inline_study.estimated_duration_minutes).toBe(18);
  });

  /**
   * And handing it back to the estimate has to be savable. Only the automatic
   * flag changes here - the number in state stays 18 - so without its own
   * clause in hasChanges the Save button never appears and the choice cannot
   * be stored at all.
   */
  it('offers a save when the author hands the duration back to the estimate', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));

    fireEvent.click(
      await screen.findByRole('button', { name: /Use the automatic estimate/i })
    );
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    // Three minutes of setup plus two per task, for the study's two tasks.
    expect(sentBody().inline_study.estimated_duration_minutes).toBe(7);
  });
});

describe('the automatic estimate on a survey that already has one', () => {
  /**
   * The survey twin of the task-list test above, and it was missing - so the
   * survey half of the `hasChanges()` pair could be deleted and nothing failed.
   * On a survey the author could hand the duration back to the estimate and
   * never be offered a Save at all.
   */
  it('offers a save when the author hands the duration back to the estimate', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(surveyOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({
        id: 'study_questions',
        kind: 'survey',
        consent_text: 'Answers are stored for research analysis',
        estimated_duration_minutes: 40,
        steps: SURVEY_STEPS
      }) as never
    );

    renderEdit('/admin/opportunities/opp-2/edit');
    await screen.findByDisplayValue('Developer experience pulse');
    fireEvent.click(screen.getByRole('button', { name: /Questions/i }));

    expect(
      (await screen.findByLabelText(/Estimated completion time/i)) as HTMLInputElement
    ).toHaveValue(40);

    fireEvent.click(
      screen.getByRole('button', { name: /Use the automatic estimate/i })
    );

    // Read on Basic Information, because the Questions step is the one step
    // whose action row carries no Save Changes shortcut - it has `onSubmit`
    // and no `onSave`. Navigating there is also what makes this a test of
    // hasChanges() rather than of the submit button, which fires regardless.
    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    // 30s of consent, 60 for the free text, 15 for the rating, 15 for the NPS.
    // Through the serialiser, like the task-list twin: `savedBody()` is typed
    // as a bag of `never`, so a field read off it does not type-check.
    expect(sentBody().inline_survey.estimated_duration_minutes).toBe(2);
  });
});

describe('when the linked study no longer exists', () => {
  it('still lets the opportunity be saved, so it can be repointed or taken down', async () => {
    // `firsthand_study_id` has no foreign key and studies can be deleted.
    // Refusing every save for a dangling link left the opportunity uneditable
    // through the only UI that can write one - it could not be retitled,
    // repointed, or even UNPUBLISHED, while it went on serving a study that no
    // longer exists. A0's route repairs a dangling link by minting a
    // replacement, and this is what lets the author ask for that.
    const notFound = Object.assign(new Error('not found'), {
      response: { status: 404 }
    });
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockRejectedValue(notFound);

    renderEdit('/admin/opportunities/opp-1/edit');

    expect(await screen.findByText(/no longer exist/i)).toBeInTheDocument();

    fireEvent.change(await screen.findByDisplayValue('Checkout walkthrough'), {
      target: { value: 'Checkout walkthrough v2' }
    });
    const save = await screen.findByRole('button', { name: /Save Changes/i });
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());
    expect(savedBody().title).toBe('Checkout walkthrough v2');
    // No content was authored, so the save still carries the DANGLING id -
    // unpublishing (or simply retitling, as here) must stay possible without
    // forcing the author to write a replacement first.
    expect(savedBody().firsthand_study_id).toBe('study_demo');
    expect(savedBody().inline_study).toBeUndefined();
  });

  it('offers the source choice for a missing task list, not the read-only surface', async () => {
    const notFound = Object.assign(new Error('not found'), {
      response: { status: 404 }
    });
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockRejectedValue(notFound);

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByText(/no longer exist/i);

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

    expect(
      await screen.findByRole('radio', { name: /Create tasks for this opportunity/i })
    ).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Start from an existing task list/i })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('read-only-study-content')).not.toBeInTheDocument();
  });

  it('lets the author write a replacement for a missing task list, sent as inline_study', async () => {
    const notFound = Object.assign(new Error('not found'), {
      response: { status: 404 }
    });
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockRejectedValue(notFound);

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByText(/no longer exist/i);

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add task' }));
    fireEvent.change(screen.getByLabelText(/What the participant sees/i), {
      target: { value: 'Find the export button' }
    });

    submitFromLastStep(/^Save changes$/);
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    // Content reaches the payload as inline_study, which is what makes the
    // backend mint a replacement rather than 400ing on a dangling id.
    expect(sentBody().inline_study.steps).toEqual([
      // A brand new task, so its identity is freshly MINTED rather than
      // recovered - a uuid, not a position. A builder that had fallen back to
      // deriving keys from the index would send `step_1` and fail here.
      { step_key: A_MINTED_IDENTITY, type: 'instruction', prompt: 'Find the export button' }
    ]);
    expect(savedBody().firsthand_study_id).toBeUndefined();
  });
});

/**
 * The survey twin of "when the linked study no longer exists". Same 404
 * branch in `loadOpportunity`, same repair path, exercised through the
 * Questions surface instead of the Task List one.
 */
describe('when the linked set of questions no longer exists', () => {
  const notFound = Object.assign(new Error('not found'), {
    response: { status: 404 }
  });

  it('still lets the opportunity be saved with no content, sending the dangling id', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(surveyOpportunity as never);
    vi.mocked(getFirstHandStudy).mockRejectedValue(notFound);

    renderEdit('/admin/opportunities/opp-2/edit');
    expect(await screen.findByText(/no longer exist/i)).toBeInTheDocument();

    fireEvent.change(await screen.findByDisplayValue('Developer experience pulse'), {
      target: { value: 'Developer experience pulse 2026' }
    });
    const save = await screen.findByRole('button', { name: /Save Changes/i });
    expect(save).not.toBeDisabled();

    fireEvent.click(save);
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());
    expect(savedBody().title).toBe('Developer experience pulse 2026');
    expect(savedBody().firsthand_study_id).toBe('study_questions');
    expect(savedBody().inline_survey).toBeUndefined();
  });

  it('offers the source choice for a missing set of questions, not the read-only surface', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(surveyOpportunity as never);
    vi.mocked(getFirstHandStudy).mockRejectedValue(notFound);

    renderEdit('/admin/opportunities/opp-2/edit');
    await screen.findByText(/no longer exist/i);

    fireEvent.click(await screen.findByRole('button', { name: /Questions/i }));

    expect(
      await screen.findByRole('radio', { name: /Create questions for this opportunity/i })
    ).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Start from an existing set of questions/i })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('read-only-study-content')).not.toBeInTheDocument();
  });

  it('lets the author write a replacement set of questions, sent as inline_survey', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(surveyOpportunity as never);
    vi.mocked(getFirstHandStudy).mockRejectedValue(notFound);

    renderEdit('/admin/opportunities/opp-2/edit');
    await screen.findByText(/no longer exist/i);

    fireEvent.click(await screen.findByRole('button', { name: /Questions/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Add question$/i }));
    fireEvent.change(screen.getByLabelText(/What the participant is asked/i), {
      target: { value: 'How easy was that?' }
    });

    submitFromLastStep(/^Save changes$/);
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());

    expect(sentBody().inline_survey.steps).toEqual([
      { step_key: A_MINTED_IDENTITY, type: 'open_text', prompt: 'How easy was that?' }
    ]);
    expect(savedBody().firsthand_study_id).toBeUndefined();
  });
});

describe('when the linked study cannot be read', () => {
  it('refuses to save rather than writing a placeholder over it', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockRejectedValue(new Error('network down'));

    renderEdit('/admin/opportunities/opp-1/edit');

    expect(
      await screen.findByText(/could not be loaded, so this opportunity cannot be saved/i)
    ).toBeInTheDocument();

    // A real edit, so the Save control is rendered at all - the point is that
    // it is rendered DISABLED, not that an unchanged form hides it.
    fireEvent.change(await screen.findByDisplayValue('Checkout walkthrough'), {
      target: { value: 'Checkout walkthrough v2' }
    });

    const save = await screen.findByRole('button', { name: /Save Changes/i });
    expect(save).toBeDisabled();

    // The disabled attribute is the affordance; the guard in handleSubmit is
    // the refusal. Reaching the handler directly through the form's submit
    // event proves the refusal does not depend on the button being unclickable.
    fireEvent.submit(save.closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateOpportunity).not.toHaveBeenCalled();
  });

  /**
   * The green "Save Changes" shortcut is not the only save control on the row.
   * The final "Save changes" control on Review saves through the same handler
   * and has to be disabled by the same unreadable study - and it is the one no
   * test covered, so it could lose the binding with every suite still green.
   */
  /**
   * `disabled` is one shared value handed to a component that spells
   * `disabled={disabled}` twice already, so extending it to the navigation
   * controls is a plausible one-line edit. It would strand the author on the
   * step: a study that could not be read must stop the save, not the walking.
   */
  it('leaves the navigation controls usable while the study could not be read', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockRejectedValue(new Error('network down'));

    renderEdit('/admin/opportunities/opp-1/edit');

    await screen.findByText(/could not be loaded, so this opportunity cannot be saved/i);

    expect(
      await screen.findByRole('button', { name: /Continue: Content & Details/i })
    ).toBeEnabled();

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

    expect(await screen.findByRole('button', { name: /^Previous: Content & Details$/i })).toBeEnabled();

    // And onward to Consent, then Review - the step C3 added, which is now
    // the one holding the save control - so it is the step an over-broad
    // `disabled` would strand the author on, with no way back.
    expect(
      screen.getByRole('button', { name: /^Continue: Consent$/i })
    ).toBeEnabled();
    goToConsentStep();
    expect(await screen.findByRole('button', { name: /^Previous: Task List$/i })).toBeEnabled();

    expect(
      screen.getByRole('button', { name: /^Continue: Review$/i })
    ).toBeEnabled();
    walkToReview();
    expect(await screen.findByRole('button', { name: /^Previous: Consent$/i })).toBeEnabled();
  });

  it('disables the final save control too, not only the Save Changes shortcut', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockRejectedValue(new Error('network down'));

    renderEdit('/admin/opportunities/opp-1/edit');

    await screen.findByText(/could not be loaded, so this opportunity cannot be saved/i);

    // A real edit, so the Save Changes shortcut renders at all - the point
    // below is that it renders DISABLED, on the step before Review too.
    fireEvent.change(await screen.findByDisplayValue('Checkout walkthrough'), {
      target: { value: 'Checkout walkthrough v2' }
    });

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));
    goToConsentStep();

    expect(await screen.findByRole('button', { name: /Save Changes/i })).toBeDisabled();

    // And the terminal control, on Review - not only the shortcut.
    walkToReview();
    expect(
      await screen.findByRole('button', { name: /^Save changes$/ })
    ).toBeDisabled();
  });
});

describe('the Save button appearing for a change that only touches authored content', () => {
  const openAndEdit = async (
    change: () => void
  ): Promise<HTMLElement | null> => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    await openAllCards();
    change();
    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
    return screen.queryByRole('button', { name: /Save Changes/i });
  };

  it('appears when only the consent wording changed', async () => {
    const save = await openAndEdit(() => {
      goToConsentStep();
      fireEvent.change(consentField(), {
        target: { value: 'Rewritten consent' }
      });
    });
    expect(save).toBeInTheDocument();
  });

  /**
   * A save that changes ONLY the classification has to be offerable.
   *
   * A study stored `custom` whose wording is verbatim the approved template is
   * a real state - migration 0013 could not classify a row it had no template
   * for, and a copy inherits `custom` from an unclassified source. Correcting
   * it changes no text at all, so without the classification clauses in
   * `hasChanges` the Save button never appears and the row stays wrong forever.
   * An independent mutation pass found all four clauses uncovered.
   */
  it('appears when only the consent classification changed, and the wording did not', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({
        consent_text: RECORDED_CONSENT_TEMPLATE.text,
        consent_template_id: 'custom',
        consent_template_version: null
      }) as never
    );

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    goToConsentStep();

    expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument();

    // Away and back. Setting a textarea to the value it already holds fires no
    // change event at all, so the round trip is what actually exercises the
    // classification moving from `custom` to the template the wording verbatim
    // is - while leaving the TEXT exactly as it was found.
    const field = () => screen.getByLabelText(/Consent text/i) as HTMLTextAreaElement;
    fireEvent.change(field(), { target: { value: 'something else entirely' } });
    fireEvent.change(field(), { target: { value: RECORDED_CONSENT_TEMPLATE.text } });

    expect(field().value).toBe(RECORDED_CONSENT_TEMPLATE.text);

    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      'Standard recorded-session consent (version 1)'
    );
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
  });

  /**
   * And the same for the VERSION alone, which the id clause cannot detect.
   *
   * A row naming a version nothing published - reachable on a rollback after a
   * v2, and on any row written by something that got it wrong - keeps its id
   * and gains the right version. Only the version clause sees that.
   */
  it('appears when only the consent template VERSION changed', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({
        consent_text: RECORDED_CONSENT_TEMPLATE.text,
        consent_template_id: RECORDED_CONSENT_TEMPLATE.id,
        consent_template_version: 99
      }) as never
    );

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    goToConsentStep();

    // Named, but with no version claimed - the row says 99 and nothing
    // published a 99.
    expect(screen.getByTestId('consent-template-state')).toHaveTextContent(
      '(version not recorded)'
    );
    expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Customise consent wording/i }));
    const versionField = () =>
      screen.getByLabelText(/Consent text/i) as HTMLTextAreaElement;
    fireEvent.change(versionField(), { target: { value: 'something else entirely' } });
    fireEvent.change(versionField(), {
      target: { value: RECORDED_CONSENT_TEMPLATE.text }
    });

    expect(versionField().value).toBe(RECORDED_CONSENT_TEMPLATE.text);
    expect(screen.getByTestId('consent-template-state')).toHaveTextContent('(version 1)');
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
  });

  it('appears when only the starting URL changed', async () => {
    const save = await openAndEdit(() => {
      fireEvent.change(screen.getByLabelText(/Starting URL/i), {
        target: { value: 'https://shop.test/checkout' }
      });
    });
    expect(save).toBeInTheDocument();
  });

  it('appears when only the study duration changed', async () => {
    const save = await openAndEdit(() => {
      fireEvent.change(screen.getByLabelText(/Estimated completion time/i), {
        target: { value: '25' }
      });
    });
    expect(save).toBeInTheDocument();
  });

  it('appears when only a task prompt changed', async () => {
    const save = await openAndEdit(() => {
      fireEvent.change(screen.getAllByLabelText(/What the participant sees/i)[0], {
        target: { value: 'Open the basket and describe it' }
      });
    });
    expect(save).toBeInTheDocument();
  });

  it('appears when only the study period changed', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');

    // Study Period lives on the Basic Information tab, not with the content.
    fireEvent.change(screen.getByLabelText(/Start Date/i), {
      target: { value: '2026-09-02' }
    });

    expect(screen.queryByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
  });

  it('stays away while nothing has changed', async () => {
    // The control assertion. Without it every test above would pass against a
    // hasChanges() that simply returned true.
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    await openAllCards();
    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));

    expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument();
  });

  /**
   * The same control assertion, on the steps that are not Basic Information.
   * Every case above navigates back to Basic Information before looking, so the
   * `isEdit && hasChanges()` gate was pinned on exactly one of the steps that
   * render it - and those call sites are textually identical, which is when a
   * change gets applied to one and not the others.
   *
   * C1 made it FIVE call sites: the Consent step renders one, and the Questions
   * step gained one that it deliberately lacked before, since the terminal
   * control moved off it. So the walk continues onto Consent rather than
   * stopping at Task List.
   */
  it('stays away on the content steps too, not only on Basic Information', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    await openAllCards();
    expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument();

    goToConsentStep();
    expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Previous: Task List$/i }));
    await openAllCards();
    fireEvent.change(screen.getAllByLabelText(/What the participant sees/i)[0], {
      target: { value: 'Open the basket and describe it' }
    });
    expect(screen.queryByRole('button', { name: /Save Changes/i })).toBeInTheDocument();

    // And it appears on the new step too, not only on the one the edit was made
    // on - the fifth call site is the one nothing was watching.
    goToConsentStep();
    expect(screen.queryByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
  });

  /**
   * A study whose provenance was never established must NOT be badged approved.
   *
   * Migration 0013 classified everything it could and left the rest NULL. The
   * form's hydration decides what NULL means, and defaulting it to the current
   * template would put a green "Standard recorded-session consent (version 1)"
   * badge over wording nobody has ever checked - and then send that claim on
   * save. An independent mutation pass found the SURVEY twin of this fallback
   * uncovered, and both version fallbacks with it.
   */
  it('reads an unclassified study as custom, not as approved', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({ consent_template_id: null, consent_template_version: null }) as never
    );

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    goToConsentStep();

    expect(await screen.findByTestId('consent-template-state')).toHaveTextContent(
      /Custom wording/i
    );
    expect(screen.getByTestId('consent-template-state')).not.toHaveTextContent(
      /version 1/i
    );
  });

  it('carries a stored classification through to the payload, version included', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(
      study({
        consent_text: RECORDED_CONSENT_TEMPLATE.text,
        consent_template_id: RECORDED_CONSENT_TEMPLATE.id,
        consent_template_version: 1
      }) as never
    );

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    await openAllCards();
    fireEvent.change(screen.getAllByLabelText(/What the participant sees/i)[0], {
      target: { value: 'Open the basket and describe it' }
    });
    walkToReview();
    fireEvent.click(screen.getByRole('button', { name: /^Save changes$/ }));

    await vi.waitFor(() => expect(vi.mocked(updateOpportunity)).toHaveBeenCalled());
    const inline = (
      vi.mocked(updateOpportunity).mock.calls[0][1] as {
        inline_study?: Record<string, unknown>;
      }
    ).inline_study as Record<string, unknown>;

    expect(inline.consent_template_id).toBe(RECORDED_CONSENT_TEMPLATE.id);
    // The VERSION, separately. A hydration that dropped it to null would still
    // pass an id-only assertion, and the claim would then be ignored by the
    // server - which is how a v1 study quietly becomes `custom` after a v2.
    expect(inline.consent_template_version).toBe(1);
  });

  /**
   * The consent field belongs to the kind the form is authoring.
   *
   * The step is handed its `fieldId`, `validationError` and `contentStepTitle`
   * through per-kind ternaries in the parent, and all three could be swapped
   * without a single test noticing. A swapped `fieldId` breaks the label
   * association and points `FIELD_LOCATIONS`-driven error routing at a control
   * that is not there.
   */
  it('gives the consent field the recorded key, not the survey one', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');
    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    goToConsentStep();

    expect(await screen.findByLabelText(/Consent text/i)).toHaveAttribute(
      'id',
      'inline_study_consent_text'
    );
  });

  /**
   * The chooser gate, shared between the content step and the Consent step.
   *
   * `isAwaitingCopiedContent` was factored out of the tabs' own `showChooser`
   * so the two surfaces cannot disagree about whether content has been chosen.
   * The tabs still compute their own `showChooser` on top of it - deliberately,
   * because a re-opened picker after a copy HAS been taken must not blank the
   * Consent step - so this pins the shared half from the outside: both surfaces
   * must be in the awaiting state at the same moment.
   */
  it('shows the picker and the awaiting-consent note at the same time', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      { ...recordedOpportunity, firsthand_study_id: null } as never
    );
    renderEdit('/admin/opportunities/opp-1/edit');
    await screen.findByDisplayValue('Checkout walkthrough');

    fireEvent.click(screen.getByRole('button', { name: /Task List/i }));
    fireEvent.click(
      await screen.findByRole('radio', { name: /Start from an existing task list/i })
    );

    // The content step is showing the picker...
    expect(await screen.findByTestId('task-source-list')).toBeInTheDocument();

    // ...so the Consent step must be showing the awaiting note, not an editor.
    goToConsentStep();
    expect(screen.queryByLabelText(/Consent text/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Go back to Task List/i })
    ).toBeInTheDocument();
  });
});
