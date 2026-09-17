import { describe, it, expect } from 'vitest';

import { appliedDraftFields } from '../apply-draft';
import type { DraftedOpportunity } from '../../../api/client';

/**
 * D13 AI study drafting - the "Apply to form" mapping. Pure, no component
 * involved: given the backend's drafted payload, it must return exactly the
 * fields OpportunityForm.tsx's own `setFormData(prev => ({ ...prev, ...x }))`
 * pattern expects, with a fresh client id minted per step.
 */

const BASE: DraftedOpportunity = {
  type: 'poll',
  title: 'Board view discoverability',
  purpose_one_liner: 'Understand whether admins can self-serve the new board view',
  status: 'draft'
};

describe('appliedDraftFields - basic fields', () => {
  it('always carries type, title and purpose_one_liner', () => {
    const fields = appliedDraftFields(BASE);
    expect(fields.type).toBe('poll');
    expect(fields.title).toBe('Board view discoverability');
    expect(fields.purpose_one_liner).toBe(
      'Understand whether admins can self-serve the new board view'
    );
  });

  it('omits optional fields the draft did not fill', () => {
    const fields = appliedDraftFields(BASE);
    expect(fields.description_optional).toBeUndefined();
    expect(fields.product_optional).toBeUndefined();
    expect(fields.participant_type_required).toBeUndefined();
    expect(fields.default_duration_minutes).toBeUndefined();
    expect(fields.external_link_optional).toBeUndefined();
  });

  it('carries every optional field the draft did fill', () => {
    const fields = appliedDraftFields({
      ...BASE,
      delivery_mode: 'external',
      description_optional: 'What admins see when they open the board view.',
      product_optional: 'Board view',
      participant_type_required: 'specific',
      participant_type_specific_details: 'Admins in their first week',
      default_duration_minutes: 15,
      external_link_optional: 'https://forms.example.com/poll'
    });

    expect(fields.delivery_mode).toBe('external');
    expect(fields.description_optional).toBe('What admins see when they open the board view.');
    expect(fields.product_optional).toBe('Board view');
    expect(fields.participant_type_required).toBe('specific');
    expect(fields.participant_type_specific_details).toBe('Admins in their first week');
    expect(fields.default_duration_minutes).toBe(15);
    expect(fields.external_link_optional).toBe('https://forms.example.com/poll');
  });
});

describe('appliedDraftFields - moderated (test/interview) consent', () => {
  it('carries top-level consent when present', () => {
    const fields = appliedDraftFields({
      ...BASE,
      type: 'interview',
      consent_text: 'This is a live session...',
      consent_template_id: 'moderated-default',
      consent_template_version: 1
    });

    expect(fields.consent_text).toBe('This is a live session...');
    expect(fields.consent_template_id).toBe('moderated-default');
    expect(fields.consent_template_version).toBe(1);
  });

  it('leaves consent fields absent when the draft carries none', () => {
    const fields = appliedDraftFields(BASE);
    expect(fields.consent_text).toBeUndefined();
    expect(fields.consent_template_id).toBeUndefined();
    expect(fields.consent_template_version).toBeUndefined();
  });
});

describe('appliedDraftFields - inline_study (unmoderated)', () => {
  const withStudy: DraftedOpportunity = {
    ...BASE,
    type: 'unmoderated',
    inline_study: {
      consent_text: 'This session records your screen...',
      consent_template_id: 'recorded-default',
      consent_template_version: 1,
      estimated_duration_minutes: 10,
      target_url: 'https://app.example.com/board-view',
      steps: [
        { type: 'instruction', prompt: 'Open the app.' },
        { type: 'single_choice', prompt: 'Could you find it?', options: ['Yes', 'No'] }
      ]
    }
  };

  it('maps every step with a fresh, unique client id', () => {
    const fields = appliedDraftFields(withStudy);

    expect(fields.inline_study_steps).toHaveLength(2);
    const ids = fields.inline_study_steps!.map((step) => step._clientId);
    expect(new Set(ids).size).toBe(2);
    ids.forEach((id) => expect(typeof id).toBe('string'));
  });

  it('preserves step content exactly', () => {
    const fields = appliedDraftFields(withStudy);
    expect(fields.inline_study_steps![0]).toMatchObject({
      type: 'instruction',
      prompt: 'Open the app.'
    });
    expect(fields.inline_study_steps![1]).toMatchObject({
      type: 'single_choice',
      prompt: 'Could you find it?',
      options: ['Yes', 'No']
    });
  });

  it('carries the study-level consent, duration and target url through, and duration_auto false', () => {
    const fields = appliedDraftFields(withStudy);
    expect(fields.inline_study_consent_text).toBe('This session records your screen...');
    expect(fields.inline_study_consent_template_id).toBe('recorded-default');
    expect(fields.inline_study_consent_template_version).toBe(1);
    expect(fields.inline_study_duration_minutes).toBe(10);
    expect(fields.inline_study_duration_auto).toBe(false);
    expect(fields.inline_study_target_url).toBe('https://app.example.com/board-view');
  });

  it('leaves inline_survey fields entirely absent', () => {
    const fields = appliedDraftFields(withStudy);
    expect(fields.inline_survey_questions).toBeUndefined();
    expect(fields.inline_survey_consent_text).toBeUndefined();
  });
});

describe('appliedDraftFields - inline_survey (native poll/question/survey)', () => {
  const withSurvey: DraftedOpportunity = {
    ...BASE,
    type: 'survey',
    delivery_mode: 'native',
    inline_survey: {
      consent_text: 'Your answers are stored...',
      consent_template_id: 'survey-default',
      consent_template_version: 1,
      estimated_duration_minutes: 5,
      steps: [
        { type: 'open_text', prompt: 'What did you think?' },
        {
          type: 'rating',
          prompt: 'How easy was it?',
          config: { scale_max: 5 }
        }
      ]
    }
  };

  it('maps every question with a fresh, unique client id and preserves config', () => {
    const fields = appliedDraftFields(withSurvey);

    expect(fields.inline_survey_questions).toHaveLength(2);
    const ids = fields.inline_survey_questions!.map((q) => q._clientId);
    expect(new Set(ids).size).toBe(2);
    expect(fields.inline_survey_questions![1]).toMatchObject({
      type: 'rating',
      config: { scale_max: 5 }
    });
  });

  it('carries the survey-level consent and duration through', () => {
    const fields = appliedDraftFields(withSurvey);
    expect(fields.inline_survey_consent_text).toBe('Your answers are stored...');
    expect(fields.inline_survey_consent_template_id).toBe('survey-default');
    expect(fields.inline_survey_consent_template_version).toBe(1);
    expect(fields.inline_survey_duration_minutes).toBe(5);
    expect(fields.inline_survey_duration_auto).toBe(false);
  });

  it('has no inline_study_target_url field at all for a survey draft', () => {
    const fields = appliedDraftFields(withSurvey);
    expect(fields.inline_study_target_url).toBeUndefined();
    expect(fields.inline_study_steps).toBeUndefined();
  });
});
