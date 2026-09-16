import { describe, expect, it } from 'vitest';

import {
  MODERATED_CONSENT_TEMPLATE,
  DEFAULT_MODERATED_CONSENT_TEXT
} from '@shared/firsthand/consent-templates';
import {
  buildSavePayload,
  type SavePayloadFormState,
  type SavePayloadInput
} from '../save-payload';

/**
 * Moderated consent in the save payload (#79, step 1a).
 *
 * The rules, each asserted in both directions:
 *  - consent travels ONLY on the shapes whose step list has the moderated
 *    Consent step - the field-travels-with-its-control rule
 *  - the template pair is a claim, sent only when it names a real template;
 *    `custom` is the server's answer and is never sent
 *  - an empty field is a deliberate CLEAR (null) when the row HAD wording at
 *    load, and silence (omitted) when it never did
 */

const formState = (overrides: Record<string, unknown> = {}): SavePayloadFormState => ({
  type: 'test',
  title: 'A study worth booking',
  purpose_one_liner: 'Ten characters at the very least',
  description_optional: '',
  product_optional: '',
  meeting_location_optional: 'https://meet.google.com/abc',
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
  moderated_consent_text: '',
  moderated_consent_template_id: 'custom',
  moderated_consent_template_version: null,
  inline_survey_questions: [],
  copied_from_study_id: '',
  has_screener: false,
  screener_questions: [],
  screener_message: '',
  ...overrides
});

/** The moderated step list, as getTabsForType returns it for test/interview. */
const MODERATED_TABS = [
  { key: 'basics' },
  { key: 'content' },
  { key: 'sessions' },
  { key: 'consent' },
  { key: 'review' }
];

const input = (
  formData: SavePayloadFormState,
  over: Partial<SavePayloadInput> = {}
): SavePayloadInput => ({
  formData,
  originalFormData: null,
  isEdit: false,
  tabs: MODERATED_TABS,
  deliveryMode: 'external',
  authoringInlineStudy: false,
  authoringInlineSurvey: false,
  linkedStudyUpdatedAt: null,
  staleStudyUpdatedAt: null,
  ...over
});

describe('moderated consent in the save payload', () => {
  it('sends the wording, and the claim when it names the approved template', () => {
    const payload = buildSavePayload(
      input(
        formState({
          moderated_consent_text: DEFAULT_MODERATED_CONSENT_TEXT,
          moderated_consent_template_id: MODERATED_CONSENT_TEMPLATE.id,
          moderated_consent_template_version: MODERATED_CONSENT_TEMPLATE.version
        })
      )
    );

    expect(payload.consent_text).toBe(DEFAULT_MODERATED_CONSENT_TEXT);
    expect(payload.consent_template_id).toBe(MODERATED_CONSENT_TEMPLATE.id);
    expect(payload.consent_template_version).toBe(MODERATED_CONSENT_TEMPLATE.version);
  });

  it('sends custom wording with NO claim - custom is the server`s answer, never the client`s assertion', () => {
    const payload = buildSavePayload(
      input(
        formState({
          moderated_consent_text: 'Wording the author typed themselves.',
          moderated_consent_template_id: 'custom',
          moderated_consent_template_version: null
        })
      )
    );

    expect(payload.consent_text).toBe('Wording the author typed themselves.');
    expect(payload).not.toHaveProperty('consent_template_id');
    expect(payload).not.toHaveProperty('consent_template_version');
  });

  it('says NOTHING for an empty field on a row that never had wording', () => {
    const payload = buildSavePayload(input(formState()));

    expect(payload).not.toHaveProperty('consent_text');
    expect(payload).not.toHaveProperty('consent_template_id');
  });

  it('sends an explicit null - a deliberate clear - when the row HAD wording at load', () => {
    const payload = buildSavePayload(
      input(formState(), {
        isEdit: true,
        originalFormData: formState({
          moderated_consent_text: 'The wording this row held when it loaded.'
        })
      })
    );

    expect(payload.consent_text).toBeNull();
  });

  it('sends no consent at all on a non-moderated shape, whatever the state holds', () => {
    // The control for the whole file: a stale moderated_consent_text left in
    // state by a type change must not ride out on a shape whose step list has
    // no Consent control to repair it with.
    const payload = buildSavePayload(
      input(
        formState({
          type: 'question',
          moderated_consent_text: DEFAULT_MODERATED_CONSENT_TEXT
        }),
        {
          tabs: [
            { key: 'basics' },
            { key: 'content' },
            { key: 'externalLink' },
            { key: 'review' }
          ]
        }
      )
    );

    expect(payload).not.toHaveProperty('consent_text');
    expect(payload).not.toHaveProperty('consent_template_id');
    // And the payload is real, not empty - the absence above is meaningful.
    expect(payload.title).toBe('A study worth booking');
  });
});
