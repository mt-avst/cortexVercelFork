import { describe, expect, it } from 'vitest';

import { buildSavePayload, type SavePayloadFormState, type SavePayloadInput } from '../save-payload';

/**
 * THE FORM NO LONGER SENDS `display_width`, AND IT DOES NOT SEND IT EVEN IF THE
 * FORM STATE STILL CARRIES ONE.
 *
 * `display_width` was a superadmin control for pod width on the user home page.
 * It never worked: neither backend schema declared the key, so it was stripped
 * from every request before a handler saw it - and separately, nothing had
 * rendered a double-width pod since 844bae8 removed the bento layout on
 * 2026-08-17. The control, the payload field and the `isSuperadmin` input that
 * existed only to gate it are gone.
 *
 * `SavePayloadFormState` is declared open (`[field: string]: unknown`) so that
 * `dirtySignature` can compare the whole form. That openness is exactly why
 * this test is worth having: a stray `display_width` on the form state is not a
 * type error, so nothing but this test stands between a re-added form field and
 * a payload key the server would silently drop again.
 */

/**
 * WHAT THIS FIXTURE IS. A MINIMAL VALID form state, not the state the form
 * starts in. It knowingly differs from `OpportunityForm`'s initial values on
 * `type` ('test' vs ''), `delivery_mode` ('native' vs 'external'), both
 * `*_duration_auto` flags (false vs true) and both consent texts ('' vs the
 * DEFAULT_* constants).
 *
 * That is safe for THIS test and only because `buildSavePayload` has a single
 * exit, so the point where the removed write used to sit is reached on every
 * input - there is no branch these values can steer us away from. It would not
 * be safe for a test asserting which fields the payload CONTAINS. If you add
 * one of those here, seed the fixture from the component's own defaults first.
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
  delivery_mode: 'native',
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

const input = (formData: SavePayloadFormState): SavePayloadInput => ({
  formData,
  originalFormData: null,
  isEdit: false,
  tabs: [{ key: 'basics' }],
  deliveryMode: 'native',
  authoringInlineStudy: false,
  authoringInlineSurvey: false,
  linkedStudyUpdatedAt: null,
  staleStudyUpdatedAt: null
});

describe('buildSavePayload and the retired display_width', () => {
  // THE CONTROL. Both assertions below are absences, and an absence passes just
  // as well when the builder returned nothing at all. This proves it produced a
  // real payload from the same input.
  it('builds a payload carrying the fields it does send', () => {
    const payload = buildSavePayload(input(formState()));

    expect(payload.title).toBe('A study worth booking');
  });

  it('sends no display_width for an ordinary form state', () => {
    const payload = buildSavePayload(input(formState()));

    expect(payload).not.toHaveProperty('display_width');
  });

  it('sends no display_width even when the form state still carries one', () => {
    const payload = buildSavePayload(input(formState({ display_width: 'double' })));

    expect(payload).not.toHaveProperty('display_width');
  });
});
