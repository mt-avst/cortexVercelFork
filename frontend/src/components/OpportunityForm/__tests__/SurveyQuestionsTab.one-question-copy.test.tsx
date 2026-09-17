import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SurveyQuestionsTab from '../SurveyQuestionsTab';
import type { OpportunityFormData } from '../../../api/types';
import type { InlineSurveyFormFields } from '../SurveyQuestionsTab';

// QuestionList renders a ConfirmationModal for its remove-confirmation
// dialog, which reads useTheme - a light stub is enough, this suite is not
// about the palette. Mirrors StudyEditor.test.tsx.
vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

/**
 * Row 18: a `question` opportunity asks exactly ONE question
 * (`maxQuestionsFor`), but this step authored every string in the plural -
 * the strip tab for the same step already reads "Question" singular
 * (verify-claims.md #23) - and the cap of 1 was stated nowhere.
 */

const baseFormData: OpportunityFormData & InlineSurveyFormFields = {
  type: 'survey',
  title: 'A survey',
  purpose_one_liner: '',
  default_duration_minutes: 30,
  status: 'draft',
  inline_survey_questions: []
};

const renderTab = (
  overrides: Partial<React.ComponentProps<typeof SurveyQuestionsTab>> = {}
) =>
  render(
    <SurveyQuestionsTab
      formData={baseFormData}
      validationErrors={{}}
      handleInputChange={vi.fn()}
      handleQuestionsChange={vi.fn()}
      hasLinkedStudy={false}
      studyIsReadOnly={false}
      readOnlyReason={null}
      onCopyFromStudy={vi.fn()}
      {...overrides}
    />
  );

describe('SurveyQuestionsTab - a survey (plural stays plural)', () => {
  it('heads the step "Questions"', () => {
    renderTab({ formData: { ...baseFormData, type: 'survey' } });

    expect(
      screen.getByRole('heading', { level: 2, name: 'Questions' })
    ).toBeInTheDocument();
  });

  it('offers to copy "an existing set of questions"', () => {
    renderTab({ formData: { ...baseFormData, type: 'survey' } });

    expect(
      screen.getByText('Start from an existing set of questions')
    ).toBeInTheDocument();
  });

  it('says "No questions yet" when empty', () => {
    renderTab({ formData: { ...baseFormData, type: 'survey' } });

    expect(
      screen.getByText(/No questions yet\. Add the first thing you want to ask\./)
    ).toBeInTheDocument();
  });
});

describe('SurveyQuestionsTab - a one-question opportunity (row 18)', () => {
  it('heads the step "Question", singular - matching the strip tab', () => {
    renderTab({ formData: { ...baseFormData, type: 'question' } });

    expect(
      screen.getByRole('heading', { level: 2, name: 'Question' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Questions' })
    ).not.toBeInTheDocument();
  });

  it('states the cap of one question, which was stated nowhere before', () => {
    renderTab({ formData: { ...baseFormData, type: 'question' } });

    expect(
      screen.getByText(/a one-question study asks exactly one question/i)
    ).toBeInTheDocument();
  });

  it('offers to copy "an existing question", singular', () => {
    renderTab({ formData: { ...baseFormData, type: 'question' } });

    expect(
      screen.getByText('Start from an existing question')
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Start from an existing set of questions')
    ).not.toBeInTheDocument();
  });

  it('says "No question yet" when empty, singular', () => {
    renderTab({ formData: { ...baseFormData, type: 'question' } });

    expect(
      screen.getByText(/No question yet\. Add the one thing you want to ask\./)
    ).toBeInTheDocument();
    expect(screen.queryByText(/No questions yet/)).not.toBeInTheDocument();
  });
});
