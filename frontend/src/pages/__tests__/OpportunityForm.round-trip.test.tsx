import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import {
  authoredStepsOf,
  studyRoundTripsCleanly,
  toInlineStudyPayloadStep,
  toInlineStudyStep,
  toSurveyQuestion
} from '../../lib/opportunity-authoring/hydrate-study';
import { toStudySteps } from '../../shared/firsthand/inline-study';
import { getOpportunity, updateOpportunity } from '../../api/client';
import { getFirstHandStudy } from '../../api/firsthand-studies';
import { logger } from '../../utils/logger';
import type { StudyStep } from '../../shared/firsthand/contract';

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

vi.mock('../../api/firsthand-studies', () => ({
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

const renderEdit = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

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
    expect(toInlineStudyPayloadStep(toInlineStudyStep(RECORDED_STEPS[1]))).toEqual({
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
    const payload = authored.map(toInlineStudyStep).map(toInlineStudyPayloadStep);
    const rewritten = authoredStepsOf(
      toStudySteps(payload, 'study_demo', 'https://shop.test/basket')
    );

    // step_id is excluded on purpose: the form does not author it, and the
    // backend preserves the stored ids positionally rather than taking the
    // payload's. Everything the participant can see must survive.
    const visible = (step: StudyStep) => ({
      type: step.type,
      prompt: step.prompt,
      options: step.options ?? null,
      helper_text: step.helper_text ?? null,
      is_required: step.is_required ?? false,
      target_url: step.target_url ?? null
    });

    expect(rewritten.map(visible)).toEqual(authored.map(visible));
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
          type: 'instruction',
          prompt: 'Open the basket and read what is in it aloud',
          // Both of these used to be hydrated and then dropped here, so the
          // save deleted them from the stored study.
          helper_text: 'Say what you notice as you go'
        },
        {
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

  it('renders the author their own tasks instead of the reuse picker', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(recordedOpportunity as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue(study() as never);

    renderEdit('/admin/opportunities/opp-1/edit');

    fireEvent.click(await screen.findByRole('button', { name: /Task List/i }));

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
    expect(
      (screen.getByLabelText(/Consent text/i) as HTMLTextAreaElement).value
    ).toBe('The bespoke wording this researcher actually wrote');
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
        { type: 'open_text', prompt: 'Which tool slows you down?' },
        {
          type: 'rating',
          prompt: 'How happy are you with the build times?',
          config: { scale_max: 7 }
        },
        { type: 'nps', prompt: 'Would you recommend it?' }
      ]
    });
    expect(savedBody().firsthand_study_id).toBeUndefined();
  });
});

describe('a study this author may not change here', () => {
  it('shows the picker, says why, and sends the id rather than the content', async () => {
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
    expect(screen.queryByLabelText(/What the participant sees/i)).not.toBeInTheDocument();

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
    await screen.findAllByLabelText(/What the participant sees/i);

    // Remove both tasks. The buttons are indexed, so the survivor becomes
    // "Remove task 1" in turn - waited on between clicks, because two
    // synchronous clicks both read the same pre-render state and only one
    // removal lands.
    fireEvent.click(screen.getByRole('button', { name: /Remove task 1/i }));
    await waitFor(() =>
      expect(screen.getAllByLabelText(/What the participant sees/i)).toHaveLength(1)
    );
    fireEvent.click(screen.getByRole('button', { name: /Remove task 1/i }));
    await waitFor(() =>
      expect(screen.queryByLabelText(/What the participant sees/i)).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: /Update Opportunity/i }));

    expect(
      await screen.findByText(/A task list needs at least one task/i)
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

    const duration = await screen.findByLabelText(/How long it takes/i);
    expect((duration as HTMLInputElement).value).toBe('18');
    fireEvent.change(duration, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: /Update Opportunity/i }));
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
    await screen.findAllByLabelText(/What the participant sees/i);
    change();
    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));
    return screen.queryByRole('button', { name: /Save Changes/i });
  };

  it('appears when only the consent wording changed', async () => {
    const save = await openAndEdit(() => {
      fireEvent.change(screen.getByLabelText(/Consent text/i), {
        target: { value: 'Rewritten consent' }
      });
    });
    expect(save).toBeInTheDocument();
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
      fireEvent.change(screen.getByLabelText(/How long it takes/i), {
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
    await screen.findAllByLabelText(/What the participant sees/i);
    fireEvent.click(screen.getByRole('button', { name: /Basic Info/i }));

    expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument();
  });
});
