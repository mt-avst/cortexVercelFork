import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import BasicInfoTab from '../BasicInfoTab';
import { OPPORTUNITY_TYPES } from '@shared/constants';
import { getParticipantFacingType } from '../../../utils/opportunityUtils';
import type { OpportunityFormData } from '../../../api/types';

// The authoring form is where a type gets its name in a researcher's head, and
// it used its own vocabulary: "User Test", "Unmoderated Testing". The dashboard
// badge said "APP TESTING" and "UNMODERATED"; browse said "Usability test" and
// "Recorded study". Three names for one thing. The D2 picker replaced the old
// select, but the rule is unchanged: a card may not call a type something no
// other surface calls it.

const formData = {
  type: '',
  title: '',
  purpose_one_liner: '',
  status: 'draft',
  participant_type_required: 'any',
  participant_type_specific_details: '',
} as unknown as OpportunityFormData;

const renderTab = () =>
  render(
    <BasicInfoTab
      formData={formData}
      validationErrors={{}}
      handleInputChange={vi.fn()}
      handleBlur={vi.fn()}
    />
  );

const cardNames = () =>
  screen
    .getAllByRole('radio')
    .map((card) => card.getAttribute('aria-label') ?? '');

describe('BasicInfoTab study-type picker card names', () => {
  it('offers a card for every type', () => {
    renderTab();
    const names = cardNames();
    for (const type of Object.values(OPPORTUNITY_TYPES)) {
      const facing = getParticipantFacingType(type);
      expect(
        names.some((name) => name.startsWith(facing)),
        `no card for "${type}"`
      ).toBe(true);
    }
  });

  it('names each one the way every other surface names it', () => {
    renderTab();
    for (const type of Object.values(OPPORTUNITY_TYPES)) {
      const facing = getParticipantFacingType(type);
      // The card TITLE is the canonical participant-facing name, shown in view.
      expect(
        screen.getAllByText(facing).length,
        `no card titled "${facing}" for "${type}"`
      ).toBeGreaterThan(0);
    }
  });

  it('does not reintroduce the names only this form used', () => {
    renderTab();
    const picker = screen.getByRole('radiogroup', { name: /study type/i });
    expect(picker.textContent).not.toMatch(/user test/i);
    expect(picker.textContent).not.toMatch(/unmoderated/i);
  });

  it('keeps each type definition in view, not hidden behind a dropdown', () => {
    renderTab();
    // Interactive types have one card; the answer-based glosses appear on both
    // the in-Cortex and external cards, hence getAllByText.
    expect(screen.getByText('Research interview session')).toBeInTheDocument();
    expect(
      screen.getByText('Usability test you moderate, at a booked time')
    ).toBeInTheDocument();
    expect(screen.getAllByText('Quick opinion gathering').length).toBeGreaterThan(0);
  });
});
