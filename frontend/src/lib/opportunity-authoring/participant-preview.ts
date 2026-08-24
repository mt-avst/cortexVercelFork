import {
  sessionPayloadSchema,
  type SessionPayload,
  type StudyStep
} from '@shared/firsthand/contract';
import type { SurveyTransport } from '../../components/survey/SurveyRunner';
import {
  toStudySteps,
  type InlineStudyStep
} from '@shared/firsthand/inline-study';
import {
  toSurveySteps,
  type SurveyQuestion
} from '@shared/firsthand/survey-authoring';
import type { WithClientId } from './client-ids';
import {
  toInlineStudyPayloadStep,
  toSurveyPayloadStep
} from './hydrate-study';

/**
 * The identity a preview session carries, and the reason it cannot be a real one.
 *
 * Every real study id is minted as `study_${crypto.randomUUID()}` - in
 * `studies-repository.createStudy`, in the four inline-authoring branches of
 * `routes/opportunities.ts`, and in StudyEditor - and every real session id as
 * `session_${randomUUID()}`. A value that does not start with those prefixes
 * therefore cannot name a row that exists, whatever else happens to it.
 *
 * That matters because these ids are what `toSurveySteps` namespaces step ids
 * with. If a preview answer ever DID reach the runtime, it would have to be
 * against a session token that no session row has, so the write 404s rather
 * than landing under a plausible-looking id - and since migration 0015,
 * `participant_responses` has a foreign key to `study_steps (study_id, id)`, so
 * a step id under a study that does not exist cannot be stored at all. THREE
 * independent guards now, because the whole promise of this feature is that it
 * writes nothing.
 *
 * They are also readable on sight, so a value that surfaces in a log or a
 * database says what it is rather than looking like an id somebody could chase.
 */
export const PREVIEW_STUDY_ID = 'preview_not_a_real_study';
export const PREVIEW_SESSION_ID = 'preview_not_a_real_session';
export const PREVIEW_SESSION_TOKEN = 'preview_not_a_real_session_token';
export const PREVIEW_PARTICIPANT_ID = 'preview_not_a_real_participant';

/**
 * The transport a preview runs on. It is the entire safety mechanism.
 *
 * `SurveyRunner` takes an injectable transport and defaults to the real runtime
 * client, so a preview that forgot to pass this would write real answers
 * against whatever session token the payload carried. Passing it is asserted by
 * a test rather than left to review, and the assertion is made against the
 * runtime-client module itself - "no network call was made" - because a test
 * that merely checks this object was passed proves nothing about what the
 * runner does with it.
 *
 * Both members resolve rather than reject. A rejecting stub would exercise the
 * runner's submission-failure path on every Next, which is the opposite of
 * showing the author what a participant sees.
 */
export const NO_OP_PREVIEW_TRANSPORT: SurveyTransport = {
  saveAnswer: async () => undefined,
  recordEvent: async () => undefined
};

/**
 * Why a preview cannot be shown, in terms the author can act on.
 *
 * `incomplete` is deliberately not the Zod error. The contract's message names
 * a schema path, and the author is looking at a form: the useful thing to say
 * is which step to go back to, which the caller knows and the schema does not.
 */
export type PreviewBlockedReason =
  | 'no-content'
  | 'incomplete'
  /**
   * A STORED set the contract refuses - a legacy step written before the rule
   * that now rejects it, say. Distinct from `incomplete` because the remedy is
   * different: an author looking at somebody else's set in the reuse picker has
   * nothing flagged on screen and no way to fix it from here.
   */
  | 'stored-unreadable';

export type ParticipantPreview =
  | { previewable: true; kind: 'survey'; payload: SessionPayload }
  | {
      previewable: true;
      kind: 'recorded';
      payload: SessionPayload;
      /** The starting page, as the participant would see it. Null when unset. */
      startingUrlLabel: string | null;
    }
  | { previewable: false; reason: PreviewBlockedReason };

/**
 * Stand-ins for the two frame fields a half-filled draft has not reached yet.
 *
 * `studySchema` requires a non-empty title and intro, and the real save takes
 * them from `title` and `purpose_one_liner` - fields that live two steps before
 * the one this preview is opened from. Refusing to preview until they are
 * filled would make the feature unavailable exactly when it is most useful, so
 * the frame gets a placeholder and the questions - the thing being previewed -
 * get the author's own words.
 */
const PLACEHOLDER_TITLE = 'Untitled opportunity';
const PLACEHOLDER_INTRO = 'This opportunity does not have a summary yet.';
/**
 * Consent gets a visibly-unreal stand-in rather than the default wording.
 *
 * Title and intro fall back to something obviously a placeholder. Consent
 * cannot: the two defaults are complete, plausible, real-looking paragraphs, so
 * an author who cleared the field would be shown wording no participant will
 * ever read - and a save with an empty consent field is REFUSED, so it is not
 * even wording that would be stored. Consent is the one field where showing
 * text that will not be used is worst.
 */
const PLACEHOLDER_CONSENT =
  '[No consent wording has been written yet. A participant cannot be asked to agree to this.]';

const orPlaceholder = (value: string | undefined, fallback: string): string =>
  value && value.trim() ? value.trim() : fallback;

type FrameFields = {
  title?: string;
  introText?: string;
  consentText?: string;
};

/**
 * The payload frame every preview shares.
 *
 * `studyId` is a parameter rather than always the sentinel because previewing a
 * STORED set is previewing a study that does exist, and saying otherwise in the
 * payload would be a small lie in the one structure this feature is about being
 * honest with. The session identity is a sentinel either way: no session has
 * been minted, and none is going to be.
 */
const frameOf = (
  fields: FrameFields,
  kind: 'recorded' | 'survey',
  steps: StudyStep[],
  studyId: string
) => ({
  contract_version: '1.0',
  study: {
    id: studyId,
    title: orPlaceholder(fields.title, PLACEHOLDER_TITLE),
    intro_text: orPlaceholder(fields.introText, PLACEHOLDER_INTRO),
    consent_text: orPlaceholder(fields.consentText, PLACEHOLDER_CONSENT),
    kind
  },
  participant: { participant_id: PREVIEW_PARTICIPANT_ID },
  session: {
    session_id: PREVIEW_SESSION_ID,
    session_token: PREVIEW_SESSION_TOKEN,
    study_id: studyId,
    participant_id: PREVIEW_PARTICIPANT_ID
  },
  steps
});

/**
 * The starting page as a participant would recognise it.
 *
 * A host for an absolute URL, because that is the fact that decides whether
 * they are about to be sent somewhere they expected. A same-origin path is
 * shown whole - there is no host to show, and the path IS the identifying part.
 * Null rather than a guess when the value is not a URL at all: the read-through
 * says "not set yet" rather than showing something that would not open.
 */
export const startingUrlLabelOf = (raw: string | undefined): string | null => {
  const value = raw?.trim();
  if (!value) return null;
  if (value.startsWith('/')) return value;

  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
};

/**
 * Everything below builds a candidate and hands it to the contract's OWN
 * parser.
 *
 * Not a hand-built object typed as `SessionPayload`. The runner is given
 * whatever this returns, so a preview built to this file's idea of the contract
 * would show the author a survey the real runtime could never serve - and the
 * mismatch would surface as a participant-facing bug rather than here. Parsing
 * also means `superRefine` runs: duplicate step ids, mismatched study ids and
 * every per-type step shape rule are checked by the same code the server uses.
 */
const parseOrBlocked = (
  candidate: unknown,
  // Which "it did not validate" this is. The caller knows whether the author
  // can act on it; the schema does not.
  refusal: PreviewBlockedReason
): { payload: SessionPayload } | { reason: PreviewBlockedReason } => {
  const parsed = sessionPayloadSchema.safeParse(candidate);
  return parsed.success ? { payload: parsed.data } : { reason: refusal };
};

/** A survey preview from live authoring state, unsaved edits included. */
export const buildSurveyPreview = (
  fields: FrameFields & { questions: readonly WithClientId<SurveyQuestion>[] }
): ParticipantPreview => {
  if (fields.questions.length === 0) {
    return { previewable: false, reason: 'no-content' };
  }

  // Through the SAVE's own normaliser first. Form state deliberately keeps
  // leftovers the contract refuses - a rating's scale_max on a question since
  // switched to NPS - and `toSurveyPayloadStep` is where they are stripped. A
  // preview that skipped it would refuse to show questions that save perfectly.
  const steps = toSurveySteps(
    fields.questions.map(toSurveyPayloadStep),
    PREVIEW_STUDY_ID
  );

  const result = parseOrBlocked(
    frameOf(fields, 'survey', steps, PREVIEW_STUDY_ID),
    'incomplete'
  );

  return 'payload' in result
    ? { previewable: true, kind: 'survey', payload: result.payload }
    : { previewable: false, reason: result.reason };
};

/** A recorded-study read-through from live authoring state. */
export const buildRecordedPreview = (
  fields: FrameFields & {
    steps: readonly WithClientId<InlineStudyStep>[];
    targetUrl?: string;
  }
): ParticipantPreview => {
  if (fields.steps.length === 0) {
    return { previewable: false, reason: 'no-content' };
  }

  const startingUrlLabel = startingUrlLabelOf(fields.targetUrl);
  const expanded = toStudySteps(
    fields.steps.map(toInlineStudyPayloadStep),
    PREVIEW_STUDY_ID,
    fields.targetUrl?.trim() || undefined
  );

  const result = parseOrBlocked(
    frameOf(fields, 'recorded', expanded, PREVIEW_STUDY_ID),
    'incomplete'
  );

  return 'payload' in result
    ? { previewable: true, kind: 'recorded', payload: result.payload, startingUrlLabel }
    : { previewable: false, reason: result.reason };
};

/**
 * A preview of a set that is already stored, for the reuse picker.
 *
 * Takes the stored steps as they are rather than round-tripping them through
 * the authoring vocabulary. The picker's question is "what will a participant
 * get if I copy this", and the honest answer is the stored content - including
 * anything this form could not author, which `studyRoundTripsCleanly` would
 * otherwise quietly drop before the author ever saw it.
 *
 * An absent `kind` reads as recorded, matching `isSurveySession`: a study
 * minted before the column existed is not evidence of a survey, and treating it
 * as one would put the interactive runner in front of a recorded task list.
 */
export const buildStoredStudyPreview = (
  study: {
    id: string;
    title: string;
    intro_text: string;
    consent_text: string;
    kind?: 'recorded' | 'survey';
  },
  steps: readonly StudyStep[]
): ParticipantPreview => {
  const authored = steps.filter((step) => step.type !== 'end');
  if (authored.length === 0) {
    return { previewable: false, reason: 'no-content' };
  }

  const fields: FrameFields = {
    title: study.title,
    introText: study.intro_text,
    consentText: study.consent_text
  };

  const kind = study.kind === 'survey' ? 'survey' : 'recorded';
  const result = parseOrBlocked(
    frameOf(fields, kind, [...steps], study.id),
    'stored-unreadable'
  );

  if (!('payload' in result)) {
    return { previewable: false, reason: result.reason };
  }

  return kind === 'survey'
    ? { previewable: true, kind, payload: result.payload }
    : {
        previewable: true,
        kind,
        payload: result.payload,
        startingUrlLabel: startingUrlLabelOf(
          authored.find((step) => step.target_url)?.target_url
        )
      };
};
