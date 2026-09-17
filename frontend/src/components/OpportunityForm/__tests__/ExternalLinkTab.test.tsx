import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ExternalLinkTab from '../ExternalLinkTab';
import type { OpportunityFormData } from '../../../api/types';

/**
 * Row 36: "Configure the external tool for polls, surveys, and questions" is
 * plural throughout, and rendered unconditionally - including for a
 * one-question study, which is not a plural "questions" study.
 */

const baseFormData: OpportunityFormData = {
  type: 'poll',
  title: 'A poll',
  purpose_one_liner: '',
  default_duration_minutes: 30,
  status: 'draft',
  external_link_optional: ''
};

const renderTab = (
  overrides: Partial<React.ComponentProps<typeof ExternalLinkTab>> = {}
) =>
  render(
    <ExternalLinkTab
      formData={baseFormData}
      validationErrors={{}}
      handleInputChange={vi.fn()}
      handleBlur={vi.fn()}
      {...overrides}
    />
  );

describe('ExternalLinkTab - copy follows the shape (row 36)', () => {
  it('describes polls, surveys, and questions for a poll', () => {
    renderTab({ formData: { ...baseFormData, type: 'poll' } });

    expect(
      screen.getByText('Configure the external tool for polls, surveys, and questions')
    ).toBeInTheDocument();
  });

  it('describes a one-question study, not "questions" plural, for type=question', () => {
    renderTab({ formData: { ...baseFormData, type: 'question' } });

    expect(
      screen.getByText('Configure the external tool for this one-question study')
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/for polls, surveys, and questions/i)
    ).not.toBeInTheDocument();
  });
});
