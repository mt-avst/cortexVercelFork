import { withClientIds, type WithClientId } from './client-ids';
import type { InlineStudyStep } from '@shared/firsthand/inline-study';
import type { SurveyQuestion } from '@shared/firsthand/survey-authoring';
import type { DraftedOpportunity, DraftedOpportunityStep } from '../../api/client';

/**
 * D13 AI study drafting (docs/AI-STUDY-DRAFTING-SPEC.md) - turning the
 * backend's drafted payload into the fields `OpportunityForm.tsx`'s own
 * `formData` already understands.
 *
 * Deliberately separate from `hydrate-study.ts`, even though it converts the
 * same per-step shapes: that module reads a STORED study (with a real study id
 * to namespace step identity against); this reads a draft that has never been
 * saved and has no study id yet - client ids are minted fresh, exactly as a
 * hand-typed question gets one. The two share nothing that would make merging
 * them safe, and forcing a shared function would either invent a fake study id
 * here or make the stored path accept one that does not exist.
 *
 * A pure mapping, on purpose: it touches no component state, so it is testable
 * without OpportunityForm.tsx's five thousand lines and reusable from wherever
 * the researcher's "Apply to form" click actually lives.
 */

/** Same field set `copiedRecordedFields`/`copiedSurveyFields` produce in
 * `hydrate-study.ts` - `OpportunityForm.tsx` already spreads a payload like
 * this straight into `formData` for the "copy an existing study" flow, so
 * applying a draft follows the same, already-proven path.
 */
export interface AppliedDraftFields {
  type: DraftedOpportunity['type'];
  delivery_mode?: 'native' | 'external';
  title: string;
  purpose_one_liner: string;
  description_optional?: string;
  product_optional?: string;
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
  default_duration_minutes?: number;
  external_link_optional?: string;
  // Moderated (test/interview) consent, at the top level - mirrors
  // CreateOpportunityRequest's own top-level consent fields.
  consent_text?: string;
  consent_template_id?: string | null;
  consent_template_version?: number | null;
  inline_study_steps?: WithClientId<InlineStudyStep>[];
  inline_study_consent_text?: string;
  inline_study_consent_template_id?: string;
  inline_study_consent_template_version?: number | null;
  inline_study_duration_minutes?: number;
  inline_study_duration_auto?: boolean;
  inline_study_target_url?: string;
  inline_survey_questions?: WithClientId<SurveyQuestion>[];
  inline_survey_consent_text?: string;
  inline_survey_consent_template_id?: string;
  inline_survey_consent_template_version?: number | null;
  inline_survey_duration_minutes?: number;
  inline_survey_duration_auto?: boolean;
}

/** A drafted step as the task-list form holds it. Mirrors `toInlineStudyStep` in hydrate-study.ts. */
const toInlineStudyStep = (step: DraftedOpportunityStep): InlineStudyStep => ({
  type: step.type as InlineStudyStep['type'],
  prompt: step.prompt,
  ...(step.options ? { options: [...step.options] } : {}),
  ...(step.helper_text ? { helper_text: step.helper_text } : {}),
  ...(step.is_required !== undefined ? { is_required: step.is_required } : {})
});

/** A drafted step as the survey form holds it. Mirrors `toSurveyQuestion` in hydrate-study.ts. */
const toSurveyQuestion = (step: DraftedOpportunityStep): SurveyQuestion => ({
  type: step.type as SurveyQuestion['type'],
  prompt: step.prompt,
  ...(step.options ? { options: [...step.options] } : {}),
  ...(step.config ? { config: step.config as SurveyQuestion['config'] } : {}),
  ...(step.helper_text ? { helper_text: step.helper_text } : {}),
  ...(step.is_required !== undefined ? { is_required: step.is_required } : {})
});

/**
 * The form-state update "Apply to form" makes. Every field is read straight
 * off the server's response - nothing here calls the API, mints a study, or
 * saves anything. `withClientIds` mints a fresh client id per step, the same
 * path a typed question takes, so the form's own reorder/edit/save machinery
 * needs no special case for a drafted one.
 */
export const appliedDraftFields = (draft: DraftedOpportunity): AppliedDraftFields => {
  const fields: AppliedDraftFields = {
    type: draft.type,
    title: draft.title,
    purpose_one_liner: draft.purpose_one_liner
  };

  if (draft.delivery_mode) {
    fields.delivery_mode = draft.delivery_mode;
  }
  if (draft.description_optional) {
    fields.description_optional = draft.description_optional;
  }
  if (draft.product_optional) {
    fields.product_optional = draft.product_optional;
  }
  if (draft.participant_type_required) {
    fields.participant_type_required = draft.participant_type_required;
  }
  if (draft.participant_type_specific_details) {
    fields.participant_type_specific_details = draft.participant_type_specific_details;
  }
  if (draft.default_duration_minutes) {
    fields.default_duration_minutes = draft.default_duration_minutes;
  }
  if (draft.external_link_optional) {
    fields.external_link_optional = draft.external_link_optional;
  }

  if (draft.consent_text) {
    fields.consent_text = draft.consent_text;
    fields.consent_template_id = draft.consent_template_id ?? null;
    fields.consent_template_version = draft.consent_template_version ?? null;
  }

  if (draft.inline_study) {
    fields.inline_study_steps = withClientIds(draft.inline_study.steps.map(toInlineStudyStep));
    fields.inline_study_consent_text = draft.inline_study.consent_text;
    fields.inline_study_consent_template_id = draft.inline_study.consent_template_id;
    fields.inline_study_consent_template_version =
      draft.inline_study.consent_template_version ?? null;
    fields.inline_study_duration_auto = false;
    if (draft.inline_study.estimated_duration_minutes) {
      fields.inline_study_duration_minutes = draft.inline_study.estimated_duration_minutes;
    }
    if (draft.inline_study.target_url) {
      fields.inline_study_target_url = draft.inline_study.target_url;
    }
  }

  if (draft.inline_survey) {
    fields.inline_survey_questions = withClientIds(
      draft.inline_survey.steps.map(toSurveyQuestion)
    );
    fields.inline_survey_consent_text = draft.inline_survey.consent_text;
    fields.inline_survey_consent_template_id = draft.inline_survey.consent_template_id;
    fields.inline_survey_consent_template_version =
      draft.inline_survey.consent_template_version ?? null;
    fields.inline_survey_duration_auto = false;
    if (draft.inline_survey.estimated_duration_minutes) {
      fields.inline_survey_duration_minutes = draft.inline_survey.estimated_duration_minutes;
    }
  }

  return fields;
};
