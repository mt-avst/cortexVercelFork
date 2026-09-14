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
// "Recorded study". Three names for one thing. The option text may still carry
// an emoji and a short gloss - what it may not do is call the type something
// no other surface calls it.

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

describe('BasicInfoTab research study type options', () => {
  it('offers every type', () => {
    renderTab();
    const select = screen.getByLabelText(/research study type/i) as HTMLSelectElement;
    const values = [...select.querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);

    for (const type of Object.values(OPPORTUNITY_TYPES)) {
      expect(values, `no option for "${type}"`).toContain(type);
    }
  });

  it('names each one the way every other surface names it', () => {
    renderTab();
    const select = screen.getByLabelText(/research study type/i) as HTMLSelectElement;

    for (const type of Object.values(OPPORTUNITY_TYPES)) {
      const option = [...select.querySelectorAll('option')].find(
        (o) => (o as HTMLOptionElement).value === type
      );
      expect(option?.textContent, `option for "${type}"`).toContain(getParticipantFacingType(type));
    }
  });

  it('does not reintroduce the names only this form used', () => {
    renderTab();
    const select = screen.getByLabelText(/research study type/i) as HTMLSelectElement;

    expect(select.textContent).not.toMatch(/user test/i);
    expect(select.textContent).not.toMatch(/unmoderated/i);
  });

  it('reserves no empty hint slot before a type is chosen (Lane C "Then")', () => {
    // With no type selected there is no hint to show; the help element (which
    // used to reserve a fixed ~2.5rem gap holding a single space) must not be
    // rendered at all, so the label sits straight above the select.
    const { container } = renderTab();
    expect(container.querySelector('#type-help')).toBeNull();
  });

  it('shows the hint, in the help slot, once a type is chosen', () => {
    const { container } = render(
      <BasicInfoTab
        formData={{ ...formData, type: 'unmoderated' } as unknown as OpportunityFormData}
        validationErrors={{}}
        handleInputChange={vi.fn()}
        handleBlur={vi.fn()}
      />
    );
    const help = container.querySelector('#type-help');
    expect(help).not.toBeNull();
    expect(help!.textContent).toMatch(/Self-guided, recorded in the browser/i);
  });
});
