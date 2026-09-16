import { describe, expect, it } from 'vitest';

import {
  buildSavePayload,
  type SavePayloadFormState,
  type SavePayloadInput
} from '../save-payload';
import { withClientId } from '../client-ids';
import type { ScreenerQuestion } from '@shared/types';

/**
 * The screener in the save payload (MR2).
 *
 * Same rules as moderated consent, each in both directions:
 *  - the screener travels ONLY on a shape whose step list has the Screener step
 *  - `_clientId` (the React key) never leaves the browser
 *  - the not-a-match message is omitted when empty, sent when set
 *  - removing the screener sends an explicit null on the update path, and
 *    silence on create
 */

const screenerQuestion = (): ReturnType<typeof withClientId<ScreenerQuestion>> =>
  withClientId({
    id: 'q1',
    prompt: '  Which best describes your role?  ',
    options: [
      { id: 'o1', label: '  Engineer  ', disqualifies: false },
      { id: 'o2', label: 'Something else', disqualifies: true }
    ]
  });

const formState = (overrides: Record<string, unknown> = {}): SavePayloadFormState => ({
  type: 'unmoderated',
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
  ...overrides
});

/** An unmoderated shape, which carries the Screener step. */
const SCREENER_TABS = [
  { key: 'basics' },
  { key: 'content' },
  { key: 'taskList' },
  { key: 'screener' },
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
  tabs: SCREENER_TABS,
  deliveryMode: 'external',
  authoringInlineStudy: false,
  authoringInlineSurvey: false,
  linkedStudyUpdatedAt: null,
  staleStudyUpdatedAt: null,
  ...over
});

describe('screener in the save payload', () => {
  it('sends the screener, trimmed, with the client key stripped', () => {
    const payload = buildSavePayload(
      input(
        formState({
          has_screener: true,
          screener_questions: [screenerQuestion()],
          screener_message: '  Not a match this time.  '
        })
      )
    );

    expect(payload.screener).toEqual({
      questions: [
        {
          id: 'q1',
          prompt: 'Which best describes your role?',
          options: [
            { id: 'o1', label: 'Engineer', disqualifies: false },
            { id: 'o2', label: 'Something else', disqualifies: true }
          ]
        }
      ],
      screenedOutMessage: 'Not a match this time.'
    });
    // The React key must never reach the wire.
    expect(JSON.stringify(payload.screener)).not.toContain('_clientId');
  });

  it('omits the not-a-match message when it is blank', () => {
    const payload = buildSavePayload(
      input(
        formState({
          has_screener: true,
          screener_questions: [screenerQuestion()],
          screener_message: '   '
        })
      )
    );

    expect(payload.screener).toBeDefined();
    expect(payload.screener).not.toHaveProperty('screenedOutMessage');
  });

  it('says nothing about a screener on create when there is none', () => {
    const payload = buildSavePayload(input(formState()));

    expect(payload).not.toHaveProperty('screener');
  });

  it('sends an explicit null - a deliberate clear - when the row HAD a screener at load', () => {
    const payload = buildSavePayload(
      input(formState(), {
        isEdit: true,
        originalFormData: formState({
          has_screener: true,
          screener_questions: [screenerQuestion()]
        })
      })
    );

    expect(payload.screener).toBeNull();
  });

  it('does not clear on create even if it somehow has no screener', () => {
    // A create with no screener sends nothing, never null: there is no stored
    // row to clear.
    const payload = buildSavePayload(input(formState({ has_screener: false })));

    expect(payload).not.toHaveProperty('screener');
  });

  it('sends no screener on a shape whose step list has no Screener step', () => {
    // The control for the file: a stale screener left in state by a type change
    // must not ride out on a shape with no Screener step to repair it.
    const payload = buildSavePayload(
      input(
        formState({
          has_screener: true,
          screener_questions: [screenerQuestion()]
        }),
        {
          tabs: [
            { key: 'basics' },
            { key: 'content' },
            { key: 'review' }
          ]
        }
      )
    );

    expect(payload).not.toHaveProperty('screener');
    expect(payload.title).toBe('A study worth booking');
  });
});
