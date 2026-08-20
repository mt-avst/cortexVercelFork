import { describe, expect, it } from 'vitest';

import {
  copiedRecordedFields,
  copiedSurveyFields,
  isAwaitingCopiedContent,
  type CopyableStudy
} from './hydrate-study';
import {
  CUSTOM_CONSENT_TEMPLATE_ID,
  RECORDED_CONSENT_TEMPLATE,
  SURVEY_CONSENT_TEMPLATE
} from '../../shared/firsthand/consent-templates';
import type { StudyStep } from '../../shared/firsthand/contract';

const steps: StudyStep[] = [
  { step_id: 's_1', order: 1, type: 'open_text', prompt: 'What did you expect?' },
  { step_id: 's_end', order: 2, type: 'end', prompt: 'Thanks' }
];

const source = (overrides: Partial<CopyableStudy> = {}): CopyableStudy => ({
  consent_text: RECORDED_CONSENT_TEMPLATE.text,
  estimated_duration_minutes: 12,
  consent_template_id: RECORDED_CONSENT_TEMPLATE.id,
  consent_template_version: RECORDED_CONSENT_TEMPLATE.version,
  ...overrides
});

/**
 * A copy takes the source's consent wording, so it has to take the source's
 * classification with it.
 *
 * These two functions had inferred return types and structural parameter
 * literals until C1, which meant adding a field to the study was a compile
 * error nowhere: the wording would have come across while the classification
 * silently reset to the default template. A copy of somebody's custom consent
 * would then have claimed, in a column, that it ran on approved wording -
 * exactly the lie the feature exists to prevent, with a green build either side.
 */
describe('copiedRecordedFields', () => {
  it('carries an approved source template across, version and all', () => {
    const copied = copiedRecordedFields(source(), steps);

    expect(copied.inline_study_consent_text).toBe(RECORDED_CONSENT_TEMPLATE.text);
    expect(copied.inline_study_consent_template_id).toBe(RECORDED_CONSENT_TEMPLATE.id);
    expect(copied.inline_study_consent_template_version).toBe(1);
  });

  it('carries a customised source across as customised', () => {
    const copied = copiedRecordedFields(
      source({
        consent_text: 'Bespoke wording',
        consent_template_id: CUSTOM_CONSENT_TEMPLATE_ID,
        consent_template_version: null
      }),
      steps
    );

    expect(copied.inline_study_consent_text).toBe('Bespoke wording');
    expect(copied.inline_study_consent_template_id).toBe(CUSTOM_CONSENT_TEMPLATE_ID);
    expect(copied.inline_study_consent_template_version).toBeNull();
  });

  /**
   * A source whose provenance was never established is not an approved source.
   * Defaulting the other way would put an approval badge on wording nothing has
   * ever looked at, which is the only unsafe direction here.
   */
  it('treats a source with no recorded classification as custom, not as approved', () => {
    const copied = copiedRecordedFields(
      source({ consent_template_id: null, consent_template_version: null }),
      steps
    );

    expect(copied.inline_study_consent_template_id).toBe(CUSTOM_CONSENT_TEMPLATE_ID);
    expect(copied.inline_study_consent_template_version).toBeNull();
  });
});

/** The survey twin. Asserted separately, because that is the defect shape. */
describe('copiedSurveyFields', () => {
  it('carries an approved source template across, version and all', () => {
    const copied = copiedSurveyFields(
      source({
        consent_text: SURVEY_CONSENT_TEMPLATE.text,
        consent_template_id: SURVEY_CONSENT_TEMPLATE.id,
        consent_template_version: SURVEY_CONSENT_TEMPLATE.version
      }),
      steps
    );

    expect(copied.inline_survey_consent_text).toBe(SURVEY_CONSENT_TEMPLATE.text);
    expect(copied.inline_survey_consent_template_id).toBe(SURVEY_CONSENT_TEMPLATE.id);
    expect(copied.inline_survey_consent_template_version).toBe(1);
  });

  it('carries a customised source across as customised', () => {
    const copied = copiedSurveyFields(
      source({
        consent_text: 'Bespoke survey wording',
        consent_template_id: CUSTOM_CONSENT_TEMPLATE_ID,
        consent_template_version: null
      }),
      steps
    );

    expect(copied.inline_survey_consent_template_id).toBe(CUSTOM_CONSENT_TEMPLATE_ID);
    expect(copied.inline_survey_consent_template_version).toBeNull();
  });

  it('treats a source with no recorded classification as custom, not as approved', () => {
    const copied = copiedSurveyFields(
      source({ consent_template_id: undefined, consent_template_version: undefined }),
      steps
    );

    expect(copied.inline_survey_consent_template_id).toBe(CUSTOM_CONSENT_TEMPLATE_ID);
  });

  it('still drops the end marker and keeps the source duration decided', () => {
    const copied = copiedSurveyFields(source(), steps);

    // The pre-C1 behaviour, re-asserted because the return type was rewritten
    // around it: a field added to that type is a compile error, a field
    // silently dropped from the body is not.
    expect(copied.inline_survey_questions).toHaveLength(1);
    expect(copied.inline_survey_duration_minutes).toBe(12);
    expect(copied.inline_survey_duration_auto).toBe(false);
  });
});

describe('isAwaitingCopiedContent', () => {
  const state = {
    hasLinkedStudy: false,
    studyIsReadOnly: false,
    sourceMode: 'copy',
    copiedFromStudyId: ''
  };

  it('is true only while a copy has been asked for and not yet taken', () => {
    expect(isAwaitingCopiedContent(state)).toBe(true);
  });

  it.each([
    ['a copy has been taken', { copiedFromStudyId: 'study_source' }],
    ['the author is writing from blank', { sourceMode: 'blank' }],
    ['the opportunity already has content', { hasLinkedStudy: true }],
    ['the study is not theirs to change', { studyIsReadOnly: true }]
  ])('is false once %s', (_label, overrides) => {
    expect(isAwaitingCopiedContent({ ...state, ...overrides })).toBe(false);
  });
});
