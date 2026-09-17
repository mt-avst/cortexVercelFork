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
 * Row 12: the wizard edits a SHARED set of questions in place, and only
 * Review said so ("An existing set of questions, edited in place" -
 * review-summary.ts). This step never told the author, while they were the
 * ones about to change it.
 *
 * No count of how many other studies link it - that needs a usage endpoint
 * W7 builds in a later wave - so the notice names the fact, not a number.
 */

const baseFormData: OpportunityFormData & InlineSurveyFormFields = {
  type: 'survey',
  title: 'A survey',
  purpose_one_liner: '',
  default_duration_minutes: 30,
  status: 'draft',
  inline_survey_questions: [
    { _clientId: 'c1', type: 'open_text', prompt: 'What did you think?' }
  ]
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

describe('SurveyQuestionsTab - shared list notice (row 12)', () => {
  it('says nothing when this opportunity has its own, unlinked questions', () => {
    renderTab({ hasLinkedStudy: false });

    expect(screen.queryByText(/shared set of questions/i)).not.toBeInTheDocument();
  });

  it('tells the author this set of questions is shared, with no number', () => {
    renderTab({ hasLinkedStudy: true });

    const notice = screen.getByText(/shared set of questions/i);
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).not.toMatch(/\d/);
  });

  it('says nothing while the linked questions are read only - there is a separate reason for that', () => {
    renderTab({
      hasLinkedStudy: true,
      studyIsReadOnly: true,
      readOnlyReason: 'not-yours'
    });

    expect(screen.queryByText(/shared set of questions/i)).not.toBeInTheDocument();
  });
});
