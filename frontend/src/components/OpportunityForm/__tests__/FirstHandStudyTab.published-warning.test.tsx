import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import FirstHandStudyTab from '../FirstHandStudyTab';
import type { OpportunityFormData } from '../../../api/types';
import type { InlineStudyFormFields } from '../FirstHandStudyTab';

// QuestionList renders a ConfirmationModal for its remove-confirmation
// dialog, which reads useTheme - a light stub is enough, this suite is not
// about the palette. Mirrors StudyEditor.test.tsx.
vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

/**
 * Row 11: the standalone Task Lists editor has always told an author that
 * changes to a published study apply only to new participant sessions
 * ("Sessions already in flight keep their original task payload" -
 * StudyEditor.tsx). This wizard step let the same list be reordered and
 * removed from with no such warning.
 */

const baseFormData: OpportunityFormData & InlineStudyFormFields = {
  type: 'unmoderated',
  title: 'A study',
  purpose_one_liner: '',
  default_duration_minutes: 30,
  status: 'draft',
  inline_study_steps: [
    { _clientId: 'c1', type: 'instruction', prompt: 'Do the thing' }
  ]
};

const renderTab = (
  overrides: Partial<React.ComponentProps<typeof FirstHandStudyTab>> = {}
) =>
  render(
    <FirstHandStudyTab
      formData={baseFormData}
      validationErrors={{}}
      handleInputChange={vi.fn()}
      handleStepsChange={vi.fn()}
      hasLinkedStudy
      studyIsReadOnly={false}
      readOnlyReason={null}
      onCopyFromStudy={vi.fn()}
      {...overrides}
    />
  );

describe('FirstHandStudyTab - published in-flight warning (row 11)', () => {
  it('says nothing on a draft study', () => {
    renderTab({ formData: { ...baseFormData, status: 'draft' } });

    expect(
      screen.queryByText(/sessions already in flight/i)
    ).not.toBeInTheDocument();
  });

  it('warns that sessions already in flight keep their original task payload once published', () => {
    renderTab({ formData: { ...baseFormData, status: 'published' } });

    expect(
      screen.getByText(/sessions already in flight keep their original task payload/i)
    ).toBeInTheDocument();
  });

  it('does not warn while the task list is read only, where there is nothing to reorder or remove', () => {
    renderTab({
      formData: { ...baseFormData, status: 'published' },
      studyIsReadOnly: true,
      readOnlyReason: 'not-yours'
    });

    expect(
      screen.queryByText(/sessions already in flight/i)
    ).not.toBeInTheDocument();
  });
});
