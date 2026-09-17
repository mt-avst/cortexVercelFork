import { OPPORTUNITY_TYPES } from '@shared/constants';
import type { PublishProblemCode } from '@shared/firsthand/publish-readiness';

import { getParticipantFacingType } from '../../utils/opportunityUtils';
import { formatStudyDate } from '../../utils/datetime';

/**
 * The check-answers screen, built by walking the same step list the stepper
 * renders rather than by asking `type` and `deliveryMode` a second set of
 * questions.
 *
 * Every other place in this form that has needed "what does this shape have"
 * has answered it by testing `type` directly, and every one of those tests is
 * a second definition of the same fact `getTabsForType` already decided. Two
 * definitions of one fact are two definitions that can stop agreeing - `id`
 * 3 meaning four different things depending on `type` is exactly the kind of
 * drift this project has already paid for once. This module never reads
 * `input.type` to decide what to SHOW; it only reads it to render the one
 * label that NAMES the study - the "Research Study Type" it once carried as a
 * basics row and now hands to `buildReviewHeader` (WZ-17). Everything else
 * about which sections exist and what they say comes from mapping over
 * `input.steps`.
 */

/** One line of the check-answers screen. */
export interface ReviewItem {
  /** What the author knows this field as, matching its on-screen label. */
  label: string;
  /** What they entered, already formatted for display. */
  value: string;
  /** An extra clarifying line under the value. Optional. */
  note?: string;
  /**
   * True when this item is not something a participant can use - either
   * nothing was entered, or what was entered cannot be made sense of.
   *
   * The wider meaning is what the renderer already acts on: it pairs the value
   * with an alert icon and the error token. Reserving it for "absent" left an
   * unusable value styled as a satisfied one, which is worse than either.
   */
  missing?: boolean;
}

/** One block of the check-answers screen, owned by exactly one step. */
export interface ReviewSection {
  /** The step this section summarises, so its Edit link can open it. */
  stepId: number;
  /** The step's key, carried so a caller can address a section without its id. */
  stepKey: string;
  /** The step's own title, so the section and the strip cannot disagree. */
  title: string;
  /**
   * The DOM id of the control to focus when the author edits this section, or
   * undefined when the step has no single relevant control.
   */
  focusFieldId?: string;
  items: ReviewItem[];
}

/** The step in the list, reduced to what a summary needs. */
export interface ReviewStepRef {
  id: number;
  key: string;
  title: string;
}

export interface ReviewSummaryInput {
  /** The steps this shape has, in order. Review itself is skipped. */
  steps: readonly ReviewStepRef[];
  type: string;
  title: string;
  purpose: string;
  /**
   * 'draft' | 'published'.
   *
   * No longer read by `itemsForStep` (#111): the choice moved off the summary
   * and onto its own live control on `ReviewStep` itself, which is not a fact
   * this module has anything to say about. Kept as a required field so the
   * caller does not have to special-case what it passes, and so existing
   * fixtures built against this shape stay valid.
   */
  status: string;
  description: string;
  product: string;
  meetingLocation: string;
  defaultDurationMinutes: number;
  participantType: string;
  participantTypeDetails: string;
  /** Roles/skills wanted: the structured, display-only advertised audience. */
  targetRoles: string[];
  startDate?: string;
  endDate?: string;
  externalLink: string;
  deliveryMode: string;
  /** Authored survey questions. */
  questionCount: number;
  /** Authored recorded tasks. */
  taskCount: number;
  /**
   * Authored screener questions, or 0 when the study has no screener.
   *
   * 0 is the "no screener" state, not a gap: a screener is optional, so an
   * empty count reads as "anyone can take part", never as something unfinished
   * (unlike sessions, where 0 slots blocks booking).
   */
  screenerQuestionCount: number;
  /** Minutes the participant is likely to need, or null when unknown. */
  estimatedMinutes: number | null;
  /** The page a recorded study opens. */
  targetUrl: string;
  consentText: string;
  /** The template the consent wording actually resolves to, or null. */
  consentTemplate: { id: string; version: number | null } | null;
  /** Non-empty when the content was copied from another study. */
  copiedFromStudyId: string;
  /** The source study's title, or '' when it could not be named. */
  copiedFromStudyTitle: string;
  /** Non-empty when a study is linked by id rather than authored here. */
  linkedStudyId: string;
  /** Time slots the author has confirmed. */
  sessionCount: number;
}

/**
 * The words this form uses elsewhere for each research study type.
 *
 * BUILT from `getParticipantFacingType` rather than spelled out again. Hand-
 * written, this table drifted: it said "Usability Test" and "Unmoderated Test"
 * while every other surface said "Usability test" and "Recorded study", so the
 * check-answers screen was the one place calling two types something nothing
 * else called them. A second list of the same facts is a second list that can
 * stop agreeing, which is the argument this whole module is built on.
 *
 * Still a lookup rather than a direct call, and that is the point: an
 * unrecognised or empty type must come back `undefined` so `buildReviewHeader`
 * falls through to the "Not chosen" label. `getParticipantFacingType` answers
 * "Study" for anything it does not know, which is right for a participant
 * reading a row and wrong for an author who has chosen nothing yet.
 */
const STUDY_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(OPPORTUNITY_TYPES).map((type) => [type, getParticipantFacingType(type)])
);

/** "1 question" against "2 questions", spelled out once rather than per call site. */
const pluralise = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The participant-facing hostname of a URL, or '' when it is not a URL.
 *
 * Showing the whole link on a check-answers screen invites reading it as
 * prose rather than as a destination; the hostname is the fact that actually
 * answers "where does this send someone", and the full value still travels in
 * the item's `note` for the author who wants to check the path too.
 */
export const hostnameOf = (raw: string): string => {
  if (!raw) {
    return '';
  }
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
};

/** First 160 characters of consent wording, with an ellipsis when it was cut. */
const truncateConsent = (text: string): string =>
  text.length > 160 ? `${text.slice(0, 160)}…` : text;

/**
 * What the approval state actually is, read from the resolved template rather
 * than from whatever the author last typed into the box. `null` and the
 * literal id `custom` are the same fact - wording nobody has signed off - and
 * collapsing them here means every caller of this module tells that fact the
 * same way.
 */
const describeConsentApproval = (
  template: { id: string; version: number | null } | null
): string => {
  if (!template || template.id === 'custom') {
    return 'Custom wording, not an approved template';
  }
  return `Approved template, version ${template.version}`;
};

/**
 * The note attached to an empty questions/tasks/sessions count. Worded around
 * the participant-facing consequence rather than the internal name of the
 * field, because that is the fact that makes an empty count worth fixing.
 */
const emptyContentNote = (whatTheParticipantSees: string): string =>
  `A participant would be shown ${whatTheParticipantSees} until this is filled in.`;

/**
 * Items shared between the two "content copied or linked" step kinds.
 *
 * The two shapes' wording is passed IN rather than selected here from a noun.
 * Written as `linkedNoun === 'questions' ? a : b` this function decided both
 * twins' copy from one string, so the recorded twin got its wording by FAILING
 * a comparison rather than by asking for it - and the fallback for a source
 * whose title could not be read said "Another set of questions" on a task
 * list. Making each caller state its own three strings means a twin cannot be
 * half-changed, which is the failure this file's tests are written to catch.
 */
const provenanceItems = (
  input: ReviewSummaryInput,
  wording: {
    /** Names the source when its title could not be read. */
    copyFallback: string;
    linkedLabel: string;
    linkedValue: string;
  }
): ReviewItem[] => {
  if (input.copiedFromStudyId) {
    return [
      {
        label: 'Copied from',
        value: input.copiedFromStudyTitle || wording.copyFallback,
        note: 'The copy is independent of its source: later changes to either will not affect the other.'
      }
    ];
  }
  if (input.linkedStudyId) {
    return [{ label: wording.linkedLabel, value: wording.linkedValue }];
  }
  return [];
};

/**
 * What a row says when the author has entered nothing.
 *
 * Written as `{ value: input.title, missing: !input.title }`, an empty title
 * rendered a `<dd>` holding an `aria-hidden` icon and NOTHING ELSE - so a
 * screen reader heard "Title" then silence, and a greyscale reader saw a glyph
 * with no words. Every other missing state in this module already carried
 * words ("Not chosen", "Not set", "Not estimated", "0 tasks"), so the four
 * that did not were an inconsistency rather than a decision.
 *
 * The icon is correctly `aria-hidden`: the words were always meant to carry
 * the meaning. There just were not any.
 */
const orNotSet = (value: string, label = 'Not set'): ReviewItem['value'] =>
  value || label;

/**
 * A URL summarised as the participant will see it, or flagged when it is not
 * one.
 *
 * `hostnameOf` returns '' for any opaque-scheme URL - `javascript:`, `mailto:`,
 * `data:` all parse, and all have no hostname. Written as
 * `value: raw ? hostnameOf(raw) : 'Not set'` with `missing: !raw`, this
 * rendered a BLANK value styled as satisfied: no icon, no error class, nothing
 * for the author to notice, on the one screen whose whole job is to be their
 * last chance to notice. Found by the security gate.
 *
 * An unusable value now shows the raw string and is flagged, because "I cannot
 * make sense of this" is more useful to an author than silence, and because the
 * raw string is the thing they need to see to understand why.
 */
const urlItem = (label: string, raw: string): ReviewItem => {
  if (!raw) {
    return { label, value: 'Not set', missing: true };
  }
  const host = hostnameOf(raw);
  return host
    ? { label, value: host, note: raw }
    : {
        label,
        value: raw,
        missing: true,
        note: 'This is not a web address a participant can open.'
      };
};

const estimatedTimeItem = (input: ReviewSummaryInput): ReviewItem =>
  input.estimatedMinutes === null
    ? { label: 'Estimated completion time', value: 'Not estimated', missing: true }
    : {
        label: 'Estimated completion time',
        // `pluralise`, not a bare `minutes`. A one-question survey estimates at
        // one minute and read "1 minutes" on screen - caught by driving the
        // form, and the same helper the counts beside it already used.
        value: pluralise(input.estimatedMinutes, 'minute')
      };

/**
 * Where "Edit Consent" puts the author, found from the step list rather than
 * from the type.
 *
 * The step's HEADING, not its textarea, and the suffix is the whole point.
 * `inline_survey_consent_text` is the id of the consent editor - the obvious
 * target - but consent is locked to the approved wording by default, and while
 * it is locked that textarea is not rendered. Focusing an id that is not on the
 * page fails silently: the step opens and focus stays where it was, which is
 * the exact failure these links exist to fix.
 *
 * Still one per vocabulary. The two never render together, so a single shared
 * id would work by coincidence rather than by rule.
 */
const consentFieldId = (steps: readonly ReviewStepRef[]): string | undefined => {
  if (steps.some((step) => step.key === 'questions')) {
    return 'inline_survey_consent_text-heading';
  }
  if (steps.some((step) => step.key === 'taskList')) {
    return 'inline_study_consent_text-heading';
  }
  // The moderated (bookable) shapes carry consent under moderated_consent_text,
  // keyed by their `sessions` step. Without this the Edit link on the Consent
  // section had no field to focus for a test/interview study and opened the
  // step with focus left where it was.
  if (steps.some((step) => step.key === 'sessions')) {
    return 'moderated_consent_text-heading';
  }
  return undefined;
};

/** One section's items, keyed on the step's own `key`. */
const itemsForStep = (step: ReviewStepRef, input: ReviewSummaryInput): ReviewItem[] => {
  switch (step.key) {
    case 'basics': {
      // Title and Research Study Type used to head this section; WZ-17 PROMOTED
      // them into the check-answers HEADER (`buildReviewHeader`), which leads
      // the screen with the study's identity. They are deliberately not
      // repeated here - two rows saying the same thing the header already says
      // is exactly the duplication the promotion set out to remove - so the
      // basics section now begins at Purpose. The header is read-only
      // orientation; editing the title or the type still happens through this
      // section's own "Edit Basic Information" link, which opens step 1.
      const items: ReviewItem[] = [
        {
          label: 'Purpose',
          value: orNotSet(input.purpose),
          missing: !input.purpose
        }
      ];

      /*
       * Only on the shapes that HAVE a duration field, found by the step list.
       *
       * This row was unconditional, so a poll's Review read "Default Duration
       * 30 minutes" - a field the author had never seen on any step, and a
       * value the payload does not send: `default_duration_minutes` goes only
       * for `test` and `interview`, and `BasicInfoTab` renders the input only
       * for those two. On a check-answers screen that is an assertion about the
       * record that is simply false.
       *
       * Gated on the presence of a `sessions` step rather than on the type,
       * because that is the same set and it cannot drift from `getTabsForType`
       * the way a sixth predicate about `type` could.
       */
      if (input.steps.some((candidate) => candidate.key === 'sessions')) {
        items.push({
          label: 'Default Duration',
          value: pluralise(input.defaultDurationMinutes, 'minute')
        });
      }
      if (input.meetingLocation) {
        items.push({ label: 'Meeting Location', value: input.meetingLocation });
      }
      /*
       * The Study Period, but only on the shapes that can edit it (row 26).
       *
       * `BasicInfoTab` renders the Start/End Date inputs for
       * poll/survey/question/unmoderated and NOT for the moderated pair - a
       * booked study's window is its slots, not a countdown. So a test or
       * interview carrying start/end dates (legacy rows, or a type change that
       * did not clear them) must not show a Study Period the author has no
       * field for. Gated on the presence of a `sessions` step - the same set
       * `BasicInfoTab` excludes - so it cannot drift from `getTabsForType`.
       *
       * Dates are formatted with the product's one date formatter in the
       * reader's zone, like every other date in the app; Review used to print
       * the raw ISO string. `?? value` keeps an unparseable value visible
       * rather than dropping the row silently.
       */
      const editsStudyPeriod = !input.steps.some(
        (candidate) => candidate.key === 'sessions'
      );
      if (editsStudyPeriod && input.startDate) {
        items.push({
          label: 'Available from',
          value: formatStudyDate(input.startDate) ?? input.startDate
        });
      }
      if (editsStudyPeriod && input.endDate) {
        items.push({
          label: 'Available until',
          value: formatStudyDate(input.endDate) ?? input.endDate
        });
      }
      return items;
    }

    case 'content': {
      const participantTypeLabels: Record<string, string> = {
        any: 'Any participant',
        internal: 'Internal only',
        external: 'External only',
        specific: 'Specific criteria'
      };
      const items: ReviewItem[] = [
        {
          label: 'Description',
          value: orNotSet(input.description),
          missing: !input.description
        }
      ];
      if (input.product) {
        items.push({ label: 'Product', value: input.product });
      }
      items.push({
        label: 'Participant Type',
        value: participantTypeLabels[input.participantType] ?? input.participantType
      });
      if (input.participantTypeDetails) {
        items.push({
          label: 'Specific Criteria',
          value: input.participantTypeDetails
        });
      }
      if (input.targetRoles.length > 0) {
        items.push({
          label: 'Roles or skills wanted',
          value: input.targetRoles.join(', ')
        });
      }
      return items;
    }

    case 'questions': {
      const items: ReviewItem[] = [
        {
          label: 'Questions',
          value: pluralise(input.questionCount, 'question'),
          missing: input.questionCount === 0,
          note:
            input.questionCount === 0
              ? emptyContentNote('no questions')
              : undefined
        },
        estimatedTimeItem(input),
        ...provenanceItems(input, {
          copyFallback: 'Another set of questions',
          linkedLabel: 'Linked questions',
          linkedValue: 'An existing set of questions, edited in place'
        })
      ];
      return items;
    }

    case 'taskList': {
      const items: ReviewItem[] = [
        {
          label: 'Tasks',
          value: pluralise(input.taskCount, 'task'),
          missing: input.taskCount === 0,
          note: input.taskCount === 0 ? emptyContentNote('no tasks') : undefined
        },
        // The recorded twin. Protected upstream by `isSafeTargetUrl` on the
        // authoring surface, so an opaque scheme should not reach here - but
        // both twins get the same treatment rather than one of them relying on
        // a guard the other does not have. A property pinned on one twin and
        // not its twin is this repo's most-repeated test failure, and it is the
        // same shape in source.
        urlItem('Starting URL', input.targetUrl),
        estimatedTimeItem(input),
        ...provenanceItems(input, {
          copyFallback: 'Another task list',
          linkedLabel: 'Linked task list',
          linkedValue: 'An existing task list, edited in place'
        })
      ];
      return items;
    }

    case 'externalLink': {
      return [
        urlItem('External Link', input.externalLink),
        {
          label: 'Where the participant goes',
          value: 'A tool outside Cortex'
        }
      ];
    }

    case 'sessions': {
      return [
        {
          label: 'Time slots',
          value: pluralise(input.sessionCount, 'slot'),
          missing: input.sessionCount === 0,
          note:
            input.sessionCount === 0
              ? 'A participant cannot book anything until at least one slot is added.'
              : undefined
        }
      ];
    }

    case 'screener': {
      // 0 is "no screener", a valid choice, so it is NOT flagged missing the
      // way an empty sessions or questions count is - a screener is optional,
      // and an author who wants everyone through leaves it off on purpose.
      if (input.screenerQuestionCount === 0) {
        return [
          {
            label: 'Screener',
            value: 'No screener',
            note: 'Anyone signed in can take part - no eligibility questions are asked.'
          }
        ];
      }
      return [
        {
          label: 'Screener questions',
          value: pluralise(input.screenerQuestionCount, 'question'),
          note: 'Anyone who does not qualify is shown the not-a-match message and cannot take part.'
        }
      ];
    }

    case 'consent': {
      // A pure hand-off (WZ-18 / Decision 9) has no consent step BODY at all -
      // the tool on the other side of the link collects it, and Cortex records
      // only that a participant followed the link. `hasExternalHandoff` is the
      // same test `OpportunityForm` uses to decide whether to render THAT
      // branch of the step (`tabs.some(tab => tab.key === 'externalLink')`),
      // read here from the step list rather than re-derived from `type` so it
      // cannot drift from what the author actually saw. Before this branch
      // existed, an external shape's Review read "Not set" or "Custom wording,
      // not an approved template, ... will be shown to the participant" -
      // describing a control the step never rendered (row 14).
      const isExternalHandoff = input.steps.some((step) => step.key === 'externalLink');
      if (isExternalHandoff) {
        return [
          {
            label: 'Consent wording',
            value: 'Handled by the external tool',
            note: 'Cortex records only that a participant followed the link.'
          }
        ];
      }

      // The moderated (bookable) shapes carry OPTIONAL consent (#79): a session
      // that stores nothing to consent to needs no wording, and an empty box is
      // how the author says so. Detected by the `sessions` step - the same set
      // that decides moderated consent everywhere else - so an empty one reads
      // as the deliberate "none" it is, not "Not set" plus a "Custom wording,
      // not an approved template" alarm about wording that does not exist
      // (row 26). Authoring shapes (questions/taskList) lock consent to an
      // approved template by default, so an empty one there is a real gap and
      // keeps the missing state below.
      const isModerated = input.steps.some((step) => step.key === 'sessions');
      if (isModerated && !input.consentText) {
        return [
          {
            label: 'Consent wording',
            value: 'No consent asked',
            note: 'A moderated session with no consent wording stores nothing for the participant to agree to.'
          }
        ];
      }
      return [
        {
          label: 'Consent wording',
          value: input.consentText
            ? truncateConsent(input.consentText)
            : 'Not set',
          missing: !input.consentText
        },
        {
          label: 'Approval state',
          value: describeConsentApproval(input.consentTemplate),
          note: 'This is the wording the participant will be shown, and it is snapshotted when they start.'
        }
      ];
    }

    default:
      return [];
  }
};

const FOCUS_FIELD_BY_KEY: Record<string, string | undefined> = {
  basics: 'title',
  content: 'participant_type_required',
  questions: 'inline_survey_questions',
  taskList: 'inline_study_steps',
  externalLink: 'external_link_optional',
  sessions: undefined,
  screener: 'screener_questions-heading'
};

/**
 * The identity that leads the check-answers screen (WZ-17): the study's title,
 * and the participant-facing label for its type.
 *
 * Both were rows in the basics section until WZ-17 promoted them here, so this
 * reads exactly the fields those rows read - `input.title`, and the same
 * `STUDY_TYPE_LABELS` lookup, falling back to 'Not chosen' for an empty or
 * unrecognised type just as the old "Research Study Type" row did. `type` is
 * used only to NAME the study, never to decide what the summary shows - the one
 * exception this module allows itself, and the same one the basics row took.
 */
export const buildReviewHeader = (
  input: ReviewSummaryInput
): { title: string; typeLabel: string } => {
  const typeLabel = input.type ? STUDY_TYPE_LABELS[input.type] : undefined;
  return {
    title: input.title,
    typeLabel: typeLabel ?? 'Not chosen'
  };
};

/** The whole check-answers screen, in step order. */
export const buildReviewSummary = (input: ReviewSummaryInput): ReviewSection[] =>
  input.steps
    .filter((step) => step.key !== 'review')
    .map((step): ReviewSection => ({
      stepId: step.id,
      stepKey: step.key,
      title: step.title,
      focusFieldId:
        step.key === 'consent'
          ? consentFieldId(input.steps)
          : FOCUS_FIELD_BY_KEY[step.key],
      items: itemsForStep(step, input)
    }));

/** Which step key answers a given publish refusal. */
const STEP_KEY_FOR_PROBLEM: Record<PublishProblemCode, string> = {
  unmoderated_study_required: 'taskList',
  unmoderated_study_removed: 'taskList',
  native_survey_study_required: 'questions',
  external_link_required: 'externalLink',
  bookable_slot_required: 'sessions',
  // The meeting location is a Basics field (row 9), so its refusal sends the
  // author back to step 1, not to Session Management.
  meeting_location_required: 'basics'
};

/**
 * Which step fixes a publish refusal, found by step KEY so it cannot disagree
 * with the shape the form is actually rendering.
 */
export const stepForPublishProblem = (
  code: PublishProblemCode,
  steps: readonly ReviewStepRef[]
): ReviewStepRef | null => {
  const key = STEP_KEY_FOR_PROBLEM[code];
  return steps.find((step) => step.key === key) ?? null;
};
