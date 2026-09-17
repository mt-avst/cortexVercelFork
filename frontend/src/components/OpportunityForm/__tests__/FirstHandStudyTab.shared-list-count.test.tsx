import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import FirstHandStudyTab from '../FirstHandStudyTab';
import { getFirstHandStudyUsage } from '../../../api/firsthand-studies';
import type { OpportunityFormData } from '../../../api/types';
import type { InlineStudyFormFields } from '../FirstHandStudyTab';

vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

vi.mock('../../../api/firsthand-studies', () => ({
  getFirstHandStudyUsage: vi.fn(),
}));

const mockedUsage = vi.mocked(getFirstHandStudyUsage);

/**
 * Row 12 follow-up: now that the usage endpoint exists (W7-backend), the
 * shared-list notice on the wizard's Task List step names the real count
 * rather than only the bare fact of sharing.
 */

const baseFormData: OpportunityFormData & InlineStudyFormFields = {
  type: 'unmoderated',
  title: 'A study',
  purpose_one_liner: '',
  default_duration_minutes: 30,
  status: 'draft',
  firsthand_study_id: 'study_shared_1',
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FirstHandStudyTab - shared list notice names the real count (row 12)', () => {
  it('names the number of studies once the usage endpoint answers', async () => {
    mockedUsage.mockResolvedValue({
      count: 3,
      studies: [
        { id: 'o1', title: 'One', status: 'published' },
        { id: 'o2', title: 'Two', status: 'draft' },
        { id: 'o3', title: 'Three', status: 'published' }
      ]
    });

    renderTab();

    await waitFor(() => {
      expect(screen.getByText(/used by 3 studies/i)).toBeInTheDocument();
    });
    expect(mockedUsage).toHaveBeenCalledWith('study_shared_1');
  });

  it('falls back to the un-numbered notice if the usage lookup fails', async () => {
    mockedUsage.mockRejectedValue(new Error('network'));

    renderTab();

    await waitFor(() => {
      expect(screen.getByText(/shared task list/i)).toBeInTheDocument();
    });
  });

  it('does not fetch usage for a read-only linked list', () => {
    renderTab({ studyIsReadOnly: true, readOnlyReason: 'not-yours' });

    expect(mockedUsage).not.toHaveBeenCalled();
  });
});
