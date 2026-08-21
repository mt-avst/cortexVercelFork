import { describe, expect, it } from 'vitest';

import { sessionPayloadSchema } from '../../../shared/firsthand/contract';
import { DEFAULT_SURVEY_CONSENT_TEXT } from '../../../shared/firsthand/survey-authoring';
import { DEFAULT_CONSENT_TEXT } from '../../../shared/firsthand/inline-study';
import {
  buildRecordedPreview,
  buildStoredStudyPreview,
  buildSurveyPreview,
  startingUrlLabelOf,
  NO_OP_PREVIEW_TRANSPORT,
  PREVIEW_PARTICIPANT_ID,
  PREVIEW_SESSION_ID,
  PREVIEW_SESSION_TOKEN,
  PREVIEW_STUDY_ID
} from '../participant-preview';

/** One of every authorable survey type, as the manual verification asks for. */
const everyQuestionType = [
  { type: 'instruction' as const, prompt: 'A short note before the questions.' },
  { type: 'open_text' as const, prompt: 'What would you change?' },
  {
    type: 'single_choice' as const,
    prompt: 'Which product do you use most?',
    options: ['Jira', 'Confluence']
  },
  {
    type: 'multi_choice' as const,
    prompt: 'Which parts have you used?',
    options: ['Tokens', 'Components', 'Icons'],
    config: { max_selections: 2 }
  },
  {
    type: 'rating' as const,
    prompt: 'How easy was it?',
    config: { scale_max: 5 },
    is_required: true
  },
  { type: 'nps' as const, prompt: 'How likely are you to recommend it?' }
];

describe('the adapter output is checked by the contract, not by this file', () => {
  /**
   * The plan's instruction, and the reason for it: a hand-written expected
   * object proves the adapter matches THIS FILE's idea of a session payload.
   * The only thing worth proving is that it matches the parser the runtime
   * itself validates with, so the parse IS the assertion.
   */
  it('round-trips a survey of every question type through sessionPayloadSchema', () => {
    const preview = buildSurveyPreview({
      title: 'Design system survey',
      introText: 'A few questions.',
      consentText: 'Nothing is recorded.',
      questions: everyQuestionType
    });

    expect(preview.previewable).toBe(true);
    if (!preview.previewable) return;

    // Parsed again, from the outside, so the test cannot pass merely because
    // the builder returned whatever it built.
    const reparsed = sessionPayloadSchema.safeParse(preview.payload);
    expect(reparsed.success).toBe(true);
  });

  it('round-trips a recorded task list through sessionPayloadSchema', () => {
    const preview = buildRecordedPreview({
      title: 'Checkout study',
      introText: 'Three tasks.',
      consentText: 'This records your screen.',
      steps: [
        { type: 'instruction', prompt: 'Open the basket.' },
        { type: 'open_text', prompt: 'Find the delivery options.' }
      ],
      targetUrl: 'https://shop.example.com/basket'
    });

    expect(preview.previewable).toBe(true);
    if (!preview.previewable) return;
    expect(sessionPayloadSchema.safeParse(preview.payload).success).toBe(true);
  });
});

describe('the identity a preview carries', () => {
  it('names a study and a session that cannot exist', () => {
    const preview = buildSurveyPreview({
      title: 'T',
      introText: 'I',
      questions: [{ type: 'open_text', prompt: 'Why?' }]
    });

    expect(preview.previewable).toBe(true);
    if (!preview.previewable) return;

    // The `.toBe(PREVIEW_*)` half of this compares the output against the
    // very constant the code uses, so it cannot fail and proves nothing on its
    // own. The claim worth testing is the NEGATIVE one - that none of these
    // could name a row - so every one of the four gets it, including the
    // session token, which is the value the runtime looks a session up BY.
    expect(preview.payload.study.id).toBe(PREVIEW_STUDY_ID);
    expect(preview.payload.session.session_id).toBe(PREVIEW_SESSION_ID);
    expect(preview.payload.session.session_token).toBe(PREVIEW_SESSION_TOKEN);
    expect(preview.payload.participant.participant_id).toBe(PREVIEW_PARTICIPANT_ID);

    // Real ids are minted as `study_<uuid>` / `session_<uuid>`, and a real
    // token is hex from `randomBytes`.
    expect(preview.payload.study.id.startsWith('study_')).toBe(false);
    expect(preview.payload.session.session_id.startsWith('session_')).toBe(false);
    expect(preview.payload.session.session_token.startsWith('session_')).toBe(false);
    expect(/^[0-9a-f]+$/.test(preview.payload.session.session_token)).toBe(false);
    expect(
      preview.payload.participant.participant_id.startsWith('participant_')
    ).toBe(false);
    // And none of them is a bare uuid either, which is what StudyEditor and
    // the runtime both mint identities from.
    const UUID = /^[0-9a-f-]{36}$/i;
    expect(UUID.test(preview.payload.study.id)).toBe(false);
    expect(UUID.test(preview.payload.session.session_token)).toBe(false);
  });

  it('namespaces every step id with the sentinel, so no step id is a real one', () => {
    const preview = buildSurveyPreview({
      title: 'T',
      introText: 'I',
      questions: everyQuestionType
    });

    expect(preview.previewable).toBe(true);
    if (!preview.previewable) return;

    // `participant_responses.step_id` is bare TEXT with no foreign key, so a
    // step id is the value a stray write would land under. None of these could
    // be mistaken for a step of a study that exists.
    for (const step of preview.payload.steps) {
      expect(step.step_id.startsWith(`${PREVIEW_STUDY_ID}_`)).toBe(true);
    }
  });
});

describe('previewing live authoring state', () => {
  it('carries an unsaved edit through to the payload', () => {
    const preview = buildSurveyPreview({
      title: 'Edited in the form, never saved',
      introText: 'Also unsaved.',
      questions: [{ type: 'open_text', prompt: 'A prompt typed a second ago' }]
    });

    expect(preview.previewable).toBe(true);
    if (!preview.previewable) return;
    expect(preview.payload.study.title).toBe('Edited in the form, never saved');
    expect(preview.payload.steps[0].prompt).toBe('A prompt typed a second ago');
  });

  it('strips what the save strips, so a leftover config does not block a preview', () => {
    // Form state deliberately KEEPS a rating's scale when the author switches
    // that question to NPS, so switching back restores it. The contract refuses
    // it. A preview that did not run the save's own normaliser would refuse to
    // show a question that saves perfectly.
    const preview = buildSurveyPreview({
      title: 'T',
      introText: 'I',
      questions: [
        { type: 'nps', prompt: 'How likely?', config: { scale_max: 5 } }
      ]
    });

    expect(preview.previewable).toBe(true);
    if (!preview.previewable) return;
    expect(preview.payload.steps[0].config).toBeUndefined();
  });

  it('never invents consent wording, because that is the one field where it would mislead', () => {
    // Title and intro fall back to something obviously a placeholder. Consent
    // must too: the product's two default paragraphs are complete and
    // plausible, so falling back to one would show an author wording that no
    // participant will read - a save with an empty consent field is refused.
    const survey = buildSurveyPreview({
      title: 'T',
      introText: 'I',
      questions: [{ type: 'open_text', prompt: 'Q' }]
    });
    const recorded = buildRecordedPreview({
      title: 'T',
      introText: 'I',
      steps: [{ type: 'instruction', prompt: 'Do the thing' }]
    });

    for (const preview of [survey, recorded]) {
      expect(preview.previewable).toBe(true);
      if (!preview.previewable) continue;
      expect(preview.payload.study.consent_text).not.toBe(
        DEFAULT_SURVEY_CONSENT_TEXT
      );
      expect(preview.payload.study.consent_text).not.toBe(DEFAULT_CONSENT_TEXT);
      // Visibly not real wording, rather than merely different wording.
      expect(preview.payload.study.consent_text).toMatch(/^\[/);
    }
  });

  it('previews a draft that has no title yet rather than refusing', () => {
    const preview = buildSurveyPreview({
      questions: [{ type: 'open_text', prompt: 'Q' }]
    });

    expect(preview.previewable).toBe(true);
    if (!preview.previewable) return;
    // The contract requires a non-empty title, and the author is two steps
    // away from the field that fills it.
    expect(preview.payload.study.title.length).toBeGreaterThan(0);
  });
});

describe('when there is nothing to show', () => {
  it('says so rather than producing an empty survey', () => {
    expect(buildSurveyPreview({ title: 'T', questions: [] })).toEqual({
      previewable: false,
      reason: 'no-content'
    });
    expect(buildRecordedPreview({ title: 'T', steps: [] })).toEqual({
      previewable: false,
      reason: 'no-content'
    });
  });

  it('refuses a half-written question instead of showing a broken one', () => {
    // A choice question with no options is refused by `findStepShapeProblem`,
    // which runs inside `sessionPayloadSchema.superRefine` - so this is the
    // contract's own judgement, not a rule re-implemented in the adapter.
    const preview = buildSurveyPreview({
      title: 'T',
      introText: 'I',
      questions: [{ type: 'single_choice', prompt: 'Pick one', options: [] }]
    });

    expect(preview).toEqual({ previewable: false, reason: 'incomplete' });
  });
});

describe('previewing a stored set, for the reuse picker', () => {
  const storedSteps = [
    { step_id: 'study_abc_step_1', order: 1, type: 'open_text' as const, prompt: 'Q1' },
    { step_id: 'study_abc_step_end', order: 2, type: 'end' as const, prompt: 'Done' }
  ];

  it('keeps the real study id, because that study exists', () => {
    const preview = buildStoredStudyPreview(
      {
        id: 'study_abc',
        title: 'Stored set',
        intro_text: 'Intro',
        consent_text: 'Consent',
        kind: 'survey'
      },
      storedSteps
    );

    expect(preview.previewable).toBe(true);
    if (!preview.previewable) return;
    expect(preview.kind).toBe('survey');
    expect(preview.payload.study.id).toBe('study_abc');
    // Still no session: nothing has been minted and nothing will be.
    expect(preview.payload.session.session_token).toBe(PREVIEW_SESSION_TOKEN);
  });

  it('reads an absent kind as recorded, never as a survey', () => {
    // Matching `isSurveySession`. A study minted before the column existed is
    // not evidence of a survey, and guessing wrong puts the interactive runner
    // in front of a recorded task list.
    const preview = buildStoredStudyPreview(
      { id: 'study_abc', title: 'T', intro_text: 'I', consent_text: 'C' },
      storedSteps
    );

    expect(preview.previewable && preview.kind).toBe('recorded');
  });

  it('refuses a stored set the contract rejects with its OWN reason', () => {
    // A rating step with no `scale_max` - refused by `findStepShapeProblem`,
    // and storable because it predates the rule. The reason must not be
    // `incomplete`: that message tells the author to fix what the form is
    // flagging, and on this path nothing is flagged and they cannot fix it.
    const preview = buildStoredStudyPreview(
      { id: 'study_abc', title: 'T', intro_text: 'I', consent_text: 'C', kind: 'survey' },
      [
        { step_id: 'study_abc_step_1', order: 1, type: 'rating', prompt: 'How easy?' },
        ...storedSteps.slice(1)
      ]
    );

    expect(preview).toEqual({ previewable: false, reason: 'stored-unreadable' });
  });

  it('has nothing to show for a set that is only a completion marker', () => {
    expect(
      buildStoredStudyPreview(
        { id: 'study_abc', title: 'T', intro_text: 'I', consent_text: 'C' },
        [storedSteps[1]]
      )
    ).toEqual({ previewable: false, reason: 'no-content' });
  });
});

describe('the starting page, as a participant would see it', () => {
  it('shows the host of an absolute URL and the path of a same-origin one', () => {
    expect(startingUrlLabelOf('https://shop.example.com/basket?a=1')).toBe(
      'shop.example.com'
    );
    expect(startingUrlLabelOf('/internal/checkout')).toBe('/internal/checkout');
  });

  it('says nothing rather than guessing when there is no usable URL', () => {
    expect(startingUrlLabelOf(undefined)).toBeNull();
    expect(startingUrlLabelOf('   ')).toBeNull();
    expect(startingUrlLabelOf('not a url')).toBeNull();
  });

  it('is derived from the authored URL rather than from the step list', () => {
    const preview = buildRecordedPreview({
      title: 'T',
      introText: 'I',
      steps: [{ type: 'instruction', prompt: 'Go' }],
      targetUrl: 'https://app.example.com/checkout'
    });

    expect(preview.previewable && preview.kind === 'recorded').toBe(true);
    if (!preview.previewable || preview.kind !== 'recorded') return;
    expect(preview.startingUrlLabel).toBe('app.example.com');
  });
});

describe('the no-op transport', () => {
  it('resolves rather than rejects, on both members', async () => {
    // A rejecting stub would put the runner into its submission-failure path on
    // every Next, which is the opposite of showing the author what happens.
    await expect(
      NO_OP_PREVIEW_TRANSPORT.saveAnswer(PREVIEW_SESSION_TOKEN, {
        stepId: 'x',
        stepType: 'open_text',
        responsePayload: { text: 'hello' }
      })
    ).resolves.toBeUndefined();

    await expect(
      NO_OP_PREVIEW_TRANSPORT.recordEvent(PREVIEW_SESSION_TOKEN, {
        eventType: 'session_started'
      })
    ).resolves.toBeUndefined();
  });
});
