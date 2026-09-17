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
 * Row 12: the wizard edits a SHARED task list in place, and only Review said
 * so ("An existing task list, edited in place" - review-summary.ts). This
 * step never told the author, while they were the ones about to change it.
 *
 * No count of how many other studies link it - that needs a usage endpoint
 * W7 builds in a later wave - so the notice names the fact, not a number.
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
      hasLinkedStudy={false}
      studyIsReadOnly={false}
      readOnlyReason={null}
      onCopyFromStudy={vi.fn()}
      {...overrides}
    />
  );

describe('FirstHandStudyTab - shared list notice (row 12)', () => {
  it('says nothing when this opportunity has its own, unlinked task list', () => {
    renderTab({ hasLinkedStudy: false });

    expect(screen.queryByText(/shared task list/i)).not.toBeInTheDocument();
  });

  it('tells the author this task list is shared, with no number', () => {
    renderTab({ hasLinkedStudy: true });

    const notice = screen.getByText(/shared task list/i);
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).not.toMatch(/\d/);
  });

  it('says nothing while the linked list is read only - there is a separate reason for that', () => {
    renderTab({
      hasLinkedStudy: true,
      studyIsReadOnly: true,
      readOnlyReason: 'not-yours'
    });

    expect(screen.queryByText(/shared task list/i)).not.toBeInTheDocument();
  });
});
