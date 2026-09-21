import {
  estimateRecordedMinutes,
  estimateSurveyMinutes
} from './estimate-duration';
import { toInlineStudyPayloadStep, toSurveyPayloadStep } from './hydrate-study';
import { CUSTOM_CONSENT_TEMPLATE_ID } from '@shared/firsthand/consent-templates';
import { QUESTION_CARRYING_TYPES } from '@shared/firsthand/delivery';
import type { InlineSurvey as InlineSurveyPayload, SurveyQuestion } from '@shared/firsthand/survey-authoring';
import type { InlineStudy as InlineStudyPayload, InlineStudyStep } from '@shared/firsthand/inline-study';
import { normaliseTargetUrl } from '../../utils/targetUrl';
import type { CreateOpportunityRequest, Screener, ScreenerQuestion } from '../../api/types';
import type { WithClientId } from './client-ids';

/**
 * ONE payload builder, for the manual save and the autosave alike.
 *
 * D2 gives this form a second caller that saves on a timer, and a second copy
 * of this logic is the drift this repository has been bitten by more than
 * once: the two would agree on the day they were written and disagree the
 * first time either was touched, with the timer-driven one - the one nobody
 * watches - free to be the wrong half. Every rule encoded below was put there
 * by a defect, and an autosave that rebuilt the body from scratch would
 * reintroduce all of them at once.
 *
 * Extracted verbatim from `handleSubmit`. The only change is that what were
 * closure reads are now named inputs, which is also the point: the list of
 * inputs IS the list of things a save depends on, and it is now impossible to
 * add a dependency without declaring it.
 *
 * Pure. No state, no network, no clock - so the tests for it assert on the
 * object that would be sent rather than on a mock's call arguments.
 */

/**
 * The fields of the form's state that a save actually reads.
 *
 * Declared structurally rather than by importing the component's state type,
 * which is not exported. The component's state has to remain assignable to
 * this, so a field renamed there fails the typecheck HERE, at the call site,
 * rather than silently sending undefined.
 */
export interface SavePayloadFormState {
  /**
   * The form carries fields this builder never reads - `copied_from_title`,
   * the source mode, and whatever is added next. Declared open so the same
   * object can be handed to `dirtySignature`, which compares the WHOLE form
   * and must not be given a narrowed copy: a signature taken over a subset
   * would report "nothing has changed" for a field it could not see.
   */
  [field: string]: unknown;
  type: 'test' | 'interview' | 'poll' | 'survey' | 'question' | 'unmoderated' | '';
  title: string;
  purpose_one_liner: string;
  description_optional: string;
  product_optional: string;
  meeting_location_optional: string;
  default_duration_minutes: number;
  external_link_optional: string;
  participant_type_required: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details: string;
  status: 'draft' | 'published';
  start_date: string | undefined;
  end_date: string | undefined;
  firsthand_study_id: string | undefined;
  inline_study_target_url: string;
  inline_study_duration_minutes: number | undefined;
  inline_study_duration_auto: boolean;
  inline_study_consent_text: string;
  inline_study_consent_template_id: string;
  inline_study_consent_template_version: number | null;
  inline_study_steps: WithClientId<InlineStudyStep>[];
  delivery_mode: 'native' | 'external';
  inline_survey_duration_minutes: number | undefined;
  inline_survey_duration_auto: boolean;
  inline_survey_consent_text: string;
  inline_survey_consent_template_id: string;
  inline_survey_consent_template_version: number | null;
  inline_survey_questions: WithClientId<SurveyQuestion>[];
  copied_from_study_id: string;
  // Moderated consent (#79): the third consent home, on the opportunity row.
  moderated_consent_text: string;
  moderated_consent_template_id: string;
  moderated_consent_template_version: number | null;
  // The eligibility screener (MR2). `has_screener` is the opt-in; the questions
  // carry a client key that never leaves the browser.
  has_screener: boolean;
  screener_questions: WithClientId<ScreenerQuestion>[];
  screener_message: string;
  // Roles/skills wanted: the structured, display-only advertised audience.
  // The chip list as authored; deduped and capped server-side.
  target_roles: string[];
  // The author's affirmation that the external tool collects its own consent
  // (row 13, cto/AdaptaLabs#136), as stored. Null is "never recorded".
  external_consent_confirmed: boolean | null;
}

export interface SavePayloadInput {
  formData: SavePayloadFormState;
  /** The form as the server last served it, for the deliberate-clear rules. */
  originalFormData: SavePayloadFormState | null;
  isEdit: boolean;
  /**
   * The step list this shape renders. Read rather than derived from `type`,
   * for the reason the external-link rule below states: the field is sent only
   * where there is a control to repair it.
   */
  tabs: readonly { key: string }[];
  deliveryMode: 'native' | 'external';
  authoringInlineStudy: boolean;
  authoringInlineSurvey: boolean;
  linkedStudyUpdatedAt: string | null;
  staleStudyUpdatedAt: string | null;
}

export type SavePayload = Partial<Omit<CreateOpportunityRequest, 'consent_text' | 'screener'> & {
  inline_study?: InlineStudyPayload;
  inline_survey?: InlineSurveyPayload;
  delivery_mode?: 'native' | 'external';
  expected_study_updated_at?: string;
  // Null is a deliberate CLEAR on the update path; the create interface only
  // knows string, so the widening lives here where both shapes are built.
  consent_text?: string | null;
  // Same widening for the screener: null clears it on the update path, an
  // object replaces it, and it is omitted when there is nothing to say.
  screener?: Screener | null;
}>;

/**
 * What to send for a duration the author may have cleared.
 *
 * `undefined` omits the key, which the in-place update path reads as "this
 * request says nothing about the duration" and leaves the stored value alone.
 * That is right for a form that never showed the field - and wrong now that it
 * does: an author who cleared a populated field got a successful save and the
 * old number still stored, with no way to remove it at all.
 *
 * So an empty field is `null` when the study HAD one at load (a deliberate
 * clear) and `undefined` when it did not (nothing to say).
 */
export const durationToSend = (
  current: number | undefined,
  original: number | undefined
): number | null | undefined => {
  if (current) return current;
  return original === undefined ? undefined : null;
};

export const buildSavePayload = ({
  formData,
  originalFormData,
  isEdit,
  tabs,
  deliveryMode,
  authoringInlineStudy,
  authoringInlineSurvey,
  linkedStudyUpdatedAt,
  staleStudyUpdatedAt
}: SavePayloadInput): SavePayload => {
  const data: Partial<Omit<CreateOpportunityRequest, 'consent_text' | 'screener'> & {
    // Null is a deliberate CLEAR on the update path - see SavePayload.
    consent_text?: string | null;
    // Same widening for the screener - see SavePayload.
    screener?: Screener | null;
    inline_study?: InlineStudyPayload;
    // Same reason as inline_study: the survey contract cannot be imported
    // into the flattened shared types, so it is added at the call site.
    inline_survey?: InlineSurveyPayload;
    delivery_mode?: 'native' | 'external';
    /**
     * Optimistic-concurrency precondition for the LINKED STUDY, sent only
     * on an edit that authors content into one. Top-level rather than
     * inside `inline_study`/`inline_survey` because both branches feed the
     * same in-place update on the server and a concurrency token is not
     * authored content - see UpdateOpportunitySchema for the rest.
     */
    expected_study_updated_at?: string;
  }> = {
    type: formData.type as CreateOpportunityRequest['type'],
    title: formData.title.trim(),
    purpose_one_liner: formData.purpose_one_liner.trim(),
    description_optional: formData.description_optional.trim() || undefined,
    product_optional: formData.product_optional.trim() || undefined,
    meeting_location_optional: formData.meeting_location_optional.trim(),
    /*
     * Sent only on the shapes that HAVE an External Link step.
     *
     * It used to be sent unconditionally, which is what made a legacy bad
     * value unrepairable. An unmoderated, test, interview or native-survey
     * row holding a `javascript:` link from before the schema was hardened
     * resends it on every save, is refused 400 by the schema, and has no
     * External Link input anywhere in its step list to fix it in - the
     * refusal banner even routes to tab 3, which on those shapes is Task
     * List or Session Management. Found by the security gate; my own repair
     * test only covered `question`, the one shape that has the step.
     *
     * Derived from the step list, not from a type test, for the same reason
     * everything else on this form is.
     */
    ...(tabs.some((step) => step.key === 'externalLink')
      ? { external_link_optional: formData.external_link_optional.trim() || undefined }
      : {}),
    /*
     * The external-tool consent affirmation (cto/AdaptaLabs#136). Travels with
     * its control, like the link above: only a shape with the Your link step
     * has the checkbox to set or repair it.
     *
     * Sent only as a boolean. Null - "never recorded" - is omitted, never sent:
     * it can only become a boolean by the author touching the checkbox, so a
     * legacy row that is merely re-saved stays unrecorded rather than silently
     * turning into an explicit "no". On create an absent key stores null too.
     *
     * NO RELINK CHECK LIVES HERE, DELIBERATELY - and its absence is what made
     * the backend reset unreachable from this form until the UI was fixed.
     * This builder is handed ONE form state, and "the author repointed the
     * study" is a fact about two: the state before the edit and the state
     * after it. Comparing against `originalFormData` would answer a different
     * question - is this the link the SERVER holds - which is the backend's
     * comparison restated a second time in a place with a worse view of it.
     * The rule is enforced at the two points that can see what they need:
     * `handleInputChange` clears the affirmation in state the moment the link
     * is edited, so a null reaches here and this key drops out; and the PATCH
     * handler resets the column for any client that sends a changed link and
     * no affirmation. A third copy in the middle is a rule written three times
     * and killable in one.
     */
    ...(tabs.some((step) => step.key === 'externalLink') &&
    typeof formData.external_consent_confirmed === 'boolean'
      ? { external_consent_confirmed: formData.external_consent_confirmed }
      : {}),
    participant_type_required: formData.participant_type_required,
    participant_type_specific_details: formData.participant_type_specific_details.trim() || undefined,
    /*
     * Structured, display-only advertised audience ("roles/skills wanted"). On
     * the Content & Details step, which every shape has, so it is sent
     * unconditionally like participant_type. The current chip list, deduped and
     * capped server-side; an empty list clears it (the backend stores null), so
     * an author who removes every chip on an edit has it cleared.
     */
    target_roles: formData.target_roles ?? [],
    /*
     * The author's own choice, always. This used to be forced to `draft` when
     * `allowUserSubmission` was set - the non-admin submission mode removed in
     * #46, whose only caller was a page nothing imported. An unreachable branch
     * deciding an opportunity's status is the kind that goes wrong silently.
     */
    status: formData.status
  };

  // Only include default_duration_minutes for test and interview types
  if (formData.type === 'test' || formData.type === 'interview') {
    data.default_duration_minutes = formData.default_duration_minutes;

    /*
     * Moderated consent (#79). Sent only on the two shapes that have the
     * moderated Consent step, by the same field-travels-with-its-control rule
     * as the external link above.
     *
     * The template pair is a CLAIM, never an instruction - the server checks
     * it against the wording beside it and stores `custom` when they disagree,
     * so nothing this form sends can make an opportunity claim approval it
     * does not have. `custom` is omitted rather than sent: it is the server's
     * answer, never the client's assertion.
     *
     * An empty field is a deliberate CLEAR (null) when the row HAD wording at
     * load, and silence (omitted) when it never did - the durationToSend rule,
     * applied to consent.
     */
    const consentText = formData.moderated_consent_text.trim();
    if (consentText) {
      data.consent_text = consentText;
      if (
        formData.moderated_consent_template_id !== CUSTOM_CONSENT_TEMPLATE_ID &&
        formData.moderated_consent_template_version !== null
      ) {
        data.consent_template_id = formData.moderated_consent_template_id;
        data.consent_template_version = formData.moderated_consent_template_version;
      }
    } else if (isEdit && (originalFormData?.moderated_consent_text ?? '').trim()) {
      data.consent_text = null;
    }
  }

  // Include start_date, end_date, and firsthand_study_id for external link / unmoderated types
  if (['poll', 'survey', 'question', 'unmoderated'].includes(formData.type)) {
    data.start_date = formData.start_date || undefined;
    data.end_date = formData.end_date || undefined;
  }

  if (formData.type === 'unmoderated') {
    // Authoring is available on create, on an edit of a draft saved before
    // its tasks were written, AND on an edit of a task list this author may
    // change - which A1 added and A0 made safe by updating the linked study
    // in place instead of minting a second one. Only a list this form
    // cannot author here (someone else's, or one holding a step type this
    // form cannot represent) still sends its id and is edited in the Task
    // Lists area.
    const authoringInline = authoringInlineStudy;

    // Exactly one of the two, never both. An opportunity that already has
    // a study keeps `firsthand_study_id` in state, so authoring content
    // into it must OMIT the id rather than send it or null it: the PATCH
    // guards test `!== undefined`, and a null would be read as "clear the
    // link" in the same breath as rewriting the study it pointed at.
    data.firsthand_study_id = authoringInline
      ? undefined
      : formData.firsthand_study_id?.trim() || undefined;

    if (authoringInline) {
      // Must match what collectValidationErrors checked, or a value could pass
      // validation and then be sent in a different shape.
      const targetUrl = normaliseTargetUrl(formData.inline_study_target_url);

      data.inline_study = {
        // Omitted rather than sent empty: its absence is meaningful, and
        // the contract rejects an empty string.
        ...(targetUrl ? { target_url: targetUrl } : {}),
        consent_text: formData.inline_study_consent_text.trim(),
        // Sent as a claim, not as an instruction. The server checks it
        // against the wording beside it and writes `custom` when the two
        // disagree, so nothing this form sends can make a study claim
        // approval it does not have. `custom` is omitted rather than sent:
        // it is the server's answer, never the client's assertion.
        ...(formData.inline_study_consent_template_id !== CUSTOM_CONSENT_TEMPLATE_ID &&
        formData.inline_study_consent_template_version !== null
          ? {
              consent_template_id: formData.inline_study_consent_template_id,
              consent_template_version:
                formData.inline_study_consent_template_version
            }
          : {}),
        // The study's OWN duration, not the opportunity's. This used to
        // send `default_duration_minutes`, which unmoderated never shows,
        // so every recorded study inherited that field's default and told
        // participants a length nobody had chosen.
        // The automatic estimate is what a save sends while it is in
        // force. Derived HERE from the same list the tab shows it from, so
        // a stale copy in state cannot be sent instead of the number the
        // author was actually looking at.
        estimated_duration_minutes: durationToSend(
          formData.inline_study_duration_auto
            ? estimateRecordedMinutes(formData.inline_study_steps) ?? undefined
            : formData.inline_study_duration_minutes,
          originalFormData?.inline_study_duration_minutes
        ),
        // Built by the same function studyRoundTripsCleanly checks with,
        // so the fields this sends and the fields the form claims it can
        // reproduce cannot drift apart again. They did, and it deleted
        // helper_text and is_required from every task list built in the
        // Task Lists area.
        steps: formData.inline_study_steps.map(toInlineStudyPayloadStep),
        // Provenance travels with the content that came from it. Omitted
        // rather than sent empty: `inlineStudySchema` takes a non-empty
        // string, and the column is NULL for anything authored from blank.
        ...(formData.copied_from_study_id
          ? { copied_from_study_id: formData.copied_from_study_id }
          : {})
      };
    }
  }

  if (QUESTION_CARRYING_TYPES.has(formData.type)) {
    // Sent only when it actually CHANGED.
    //
    // The backend deliberately gates its publish and linkage checks on the
    // request changing the shape, so an unrelated edit to a row already in
    // a bad state stays allowed and the row can be repaired. Sending this
    // on every save made both conditions permanently true for polls and
    // surveys: a published poll whose external link was somehow null could
    // no longer have its TITLE corrected through the form, and a native
    // survey whose study had been deleted was refused every edit. That is
    // the same lock-out the backend guard was gated to prevent,
    // reintroduced from the client.
    if (
      !isEdit ||
      deliveryMode !== (originalFormData?.delivery_mode ?? 'external')
    ) {
      data.delivery_mode = deliveryMode;
    }

    if (deliveryMode === 'native') {
      // Same shape as the task-list branch above, and the same reason for
      // exactly one of the two: the stored id stays in state, and copy mode
      // authors content rather than pointing at somebody else's study.
      const authoringInline = authoringInlineSurvey;

      data.firsthand_study_id = authoringInline
        ? undefined
        : formData.firsthand_study_id?.trim() || undefined;

      if (authoringInline) {
        data.inline_survey = {
          consent_text: formData.inline_survey_consent_text.trim(),
          ...(formData.inline_survey_consent_template_id !== CUSTOM_CONSENT_TEMPLATE_ID &&
          formData.inline_survey_consent_template_version !== null
            ? {
                consent_template_id: formData.inline_survey_consent_template_id,
                consent_template_version:
                  formData.inline_survey_consent_template_version
              }
            : {}),
          // Same rule as the task-list branch above.
          estimated_duration_minutes: durationToSend(
            formData.inline_survey_duration_auto
              ? estimateSurveyMinutes(formData.inline_survey_questions) ?? undefined
              : formData.inline_survey_duration_minutes,
            originalFormData?.inline_survey_duration_minutes
          ),
          // Same function studyRoundTripsCleanly checks with. This branch
          // was already faithful; sharing the serialiser is what stops it
          // drifting the way the task-list branch did.
          steps: formData.inline_survey_questions.map(toSurveyPayloadStep),
          // The recorded twin carries this too. `inlineSurveySchema` is
          // `.strict()`, so an unknown key here is a refused save rather
          // than a dropped field - which is exactly why both twins were
          // changed in the same breath.
          ...(formData.copied_from_study_id
            ? { copied_from_study_id: formData.copied_from_study_id }
            : {})
        };
      }
    }
    // No `else` clearing inline_survey: the payload is built fresh on every
    // submit and only the native branch above ever sets it, so an external
    // handoff cannot carry authored questions. A defensive assignment here
    // was dead code, and the mutation proved it - the test asserting their
    // absence passes without it, because the absence is structural.
  }

  // The eligibility screener (MR2). Sent only on a shape whose step list has
  // the Screener step - the same field-travels-with-its-control rule as the
  // external link and moderated consent above, so a stale screener left in
  // state by a type change cannot ride out on a shape with no screener control
  // to repair it.
  //
  // An empty not-a-match message is omitted, not sent empty: `screenerSchema`
  // takes it optional. Removing the screener sends an explicit null on the
  // update path when the row HAD one - the durationToSend rule, applied to the
  // whole screener - and silence on create, where there is no stored row to
  // clear. `_clientId` is the React key and is deliberately NOT spread across:
  // each question and option is rebuilt field by field, so the key never
  // reaches the wire (the server schema is strict and would refuse it).
  if (tabs.some((step) => step.key === 'screener')) {
    if (formData.has_screener) {
      const screener: Screener = {
        questions: formData.screener_questions.map((question) => ({
          id: question.id,
          prompt: question.prompt.trim(),
          options: question.options.map((option) => ({
            id: option.id,
            label: option.label.trim(),
            disqualifies: option.disqualifies
          }))
        }))
      };
      const message = formData.screener_message.trim();
      if (message) {
        screener.screenedOutMessage = message;
      }
      data.screener = screener;
    } else if (isEdit && originalFormData?.has_screener) {
      data.screener = null;
    }
  }

  // The optimistic-concurrency precondition, and the only thing this
  // revision stamp is for. Captured by A1 at load (`linkedStudyUpdatedAt`),
  // refreshed by a conflict, and sent only where it can be acted on: a save
  // that authors content into an EXISTING linked study. A create has no
  // stored row to race, and a save that carries no inline content performs
  // no study write for the server to refuse.
  //
  // `staleStudyUpdatedAt` takes precedence when set: after a conflict it
  // holds what is actually stored, which is what makes the next save a
  // deliberate overwrite rather than a guaranteed second refusal.
  if (isEdit && (data.inline_study || data.inline_survey)) {
    const precondition = staleStudyUpdatedAt ?? linkedStudyUpdatedAt;
    if (precondition) {
      data.expected_study_updated_at = precondition;
    }
  }

  return data;
};
