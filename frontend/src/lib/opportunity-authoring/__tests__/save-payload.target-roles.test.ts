import { describe, expect, it } from 'vitest';

import {
  buildSavePayload,
  type SavePayloadFormState,
  type SavePayloadInput
} from '../save-payload';

/**
 * Roles/skills wanted in the save payload.
 *
 * The field lives on the Screener/Audience step (D6), but the payload builder
 * reads it straight from formData, so it is sent unconditionally regardless of
 * the rendered shape. The chip list travels as authored; deduping and the caps
 * are the server's job. An empty list is sent as [] so an author who clears
 * every chip on an edit has it cleared (the backend stores null for an empty
 * list).
 */
const formState = (overrides: Record<string, unknown> = {}): SavePayloadFormState => ({
  type: 'test',
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
  ...overrides
});

const TABS = [
  { key: 'basics' },
  { key: 'content' },
  { key: 'sessions' },
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

describe('roles/skills wanted in the save payload', () => {
  it('sends the chip list as authored', () => {
    const payload = buildSavePayload(
      input(formState({ target_roles: ['Product Manager', 'ScriptRunner admin'] }))
    );
    expect(payload.target_roles).toEqual(['Product Manager', 'ScriptRunner admin']);
  });

  it('sends an empty array when there are no roles', () => {
    const payload = buildSavePayload(input(formState()));
    expect(payload.target_roles).toEqual([]);
  });

  it('sends [] on an edit that clears every chip, so the server clears the field', () => {
    const payload = buildSavePayload(
      input(formState({ target_roles: [] }), {
        isEdit: true,
        originalFormData: formState({ target_roles: ['Product Manager'] })
      })
    );
    expect(payload.target_roles).toEqual([]);
  });
});
