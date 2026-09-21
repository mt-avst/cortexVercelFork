import { describe, expect, it } from 'vitest';

import {
  buildSavePayload,
  type SavePayloadFormState,
  type SavePayloadInput
} from '../save-payload';

/**
 * The external-tool consent affirmation in the save payload
 * (cto/AdaptaLabs#136).
 *
 * The form-level round trip lives in OpportunityForm.external-consent.test.tsx;
 * this pins the builder's own rules, including the create path that one does
 * not drive: sent only as a boolean, only on a shape with the Your link step,
 * and never as null - "never recorded" is left for the server to default.
 */
const formState = (overrides: Record<string, unknown> = {}): SavePayloadFormState => ({
  type: 'question',
  title: 'A study worth booking',
  purpose_one_liner: 'Ten characters at the very least',
  description_optional: '',
  product_optional: '',
  meeting_location_optional: '',
  default_duration_minutes: 30,
  external_link_optional: '',
  participant_type_required: 'any',
  participant_type_specific_details: '',
  status: 'draft',
  start_date: undefined,
  end_date: undefined,
  firsthand_study_id: undefined,
  inline_study_target_url: '',
  inline_study_duration_minutes: undefined,
  inline_study_duration_auto: false,
  inline_study_consent_text: '',
  inline_study_consent_template_id: '',
  inline_study_consent_template_version: null,
  inline_study_steps: [],
  delivery_mode: 'external',
  inline_survey_duration_minutes: undefined,
  inline_survey_duration_auto: false,
  inline_survey_consent_text: '',
  inline_survey_consent_template_id: '',
  inline_survey_consent_template_version: null,
  inline_survey_questions: [],
  moderated_consent_text: '',
  moderated_consent_template_id: 'custom',
  moderated_consent_template_version: null,
  copied_from_study_id: '',
  has_screener: false,
  screener_questions: [],
  screener_message: '',
  target_roles: [],
  external_consent_confirmed: null,
  ...overrides
});

const TABS = [
  { key: 'basics' },
  { key: 'basicInfo' },
  { key: 'screener' },
  { key: 'externalLink' },
  { key: 'review' }
];

const input = (
  formData: SavePayloadFormState,
  over: Partial<SavePayloadInput> = {}
): SavePayloadInput => ({
  formData,
  originalFormData: null,
  isEdit: false,
  tabs: TABS,
  deliveryMode: 'external',
  authoringInlineStudy: false,
  authoringInlineSurvey: false,
  linkedStudyUpdatedAt: null,
  staleStudyUpdatedAt: null,
  ...over
});

describe('the external consent affirmation in the save payload', () => {
  it('a create with the box ticked sends true', () => {
    const payload = buildSavePayload(input(formState({ external_consent_confirmed: true })));
    expect(payload.external_consent_confirmed).toBe(true);
  });

  it('an edit that unticks the box sends an explicit false', () => {
    const payload = buildSavePayload(
      input(formState({ external_consent_confirmed: false }), {
        isEdit: true,
        originalFormData: formState({ external_consent_confirmed: true })
      })
    );
    expect(payload.external_consent_confirmed).toBe(false);
  });

  it('a never-recorded affirmation is omitted, not sent as null or false', () => {
    const payload = buildSavePayload(input(formState({ external_consent_confirmed: null })));
    expect(Object.keys(payload)).not.toContain('external_consent_confirmed');
  });

  it('a shape without the Your link step never carries it', () => {
    const payload = buildSavePayload(
      input(formState({ type: 'test', external_consent_confirmed: true }), {
        tabs: [{ key: 'basics' }, { key: 'sessions' }, { key: 'review' }]
      })
    );
    expect(Object.keys(payload)).not.toContain('external_consent_confirmed');
  });
});
