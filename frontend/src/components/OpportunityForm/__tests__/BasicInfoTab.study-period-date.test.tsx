import React, { useState } from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import BasicInfoTab from '../BasicInfoTab';
import type { OpportunityFormData } from '../../../api/types';

// #110 (beta feedback): "typing '2026' gives me '1906'" in the Study Period
// date fields, and it round-trips into start_date/end_date - a silently wrong
// study window, not just a cosmetic glitch.
//
// Root cause: a native <input type="date"> fires onChange on every keystroke
// of the year sub-field, and while the year is only partly typed (with month
// and day already filled) it reports a short, zero-padded year embedded in an
// otherwise-complete date string - e.g. typing just the "6" of "2026" reports
// "0006-06-15". The old parse helper (`formatDateToISO`) had no check on the
// year's magnitude, so `Date.UTC(6, ...)` hit JS's legacy two-digit-year rule
// (any year 0-99 silently gets 1900 added), turning that one keystroke into
// "1906-06-15" - and because that transient value was written straight into
// `handleInputChange`, it landed in formData exactly like a deliberate edit.
// "1906" is not a coincidence: 6 + 1900 = 1906, the reported number.

const baseFormData: OpportunityFormData = {
  type: 'survey',
  title: 'Some survey',
  purpose_one_liner: 'Testing something',
  default_duration_minutes: 15,
  status: 'draft',
  delivery_mode: 'external',
  start_date: new Date(Date.UTC(2024, 5, 15, 12, 0, 0)).toISOString()
};

function ControlledBasicInfoTab({ initial }: { initial: OpportunityFormData }) {
  const [formData, setFormData] = useState(initial);
  return (
    <BasicInfoTab
      formData={formData}
      validationErrors={{}}
      handleInputChange={(field, value) =>
        setFormData((prev) => ({ ...prev, [field]: value }))
      }
    />
  );
}

describe('BasicInfoTab study period date fields (#110)', () => {
  it('ignores a mid-typed short year instead of corrupting it into the 1900s', () => {
    render(<ControlledBasicInfoTab initial={baseFormData} />);
    const input = screen.getByLabelText(/start date/i) as HTMLInputElement;

    expect(input.value).toBe('2024-06-15');

    // A native <input type="date"> reports this exact shape - a short,
    // zero-padded year with month/day already valid - while the year segment
    // is only partly typed.
    fireEvent.change(input, { target: { value: '0006-06-15' } });

    expect(input.value).not.toBe('1906-06-15');
    // The previously-valid date is preserved rather than being blown away by
    // a keystroke that never finished.
    expect(input.value).toBe('2024-06-15');
  });

  it('keeps a valid date round-tripping correctly (control)', () => {
    render(<ControlledBasicInfoTab initial={baseFormData} />);
    const input = screen.getByLabelText(/start date/i) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '2025-03-10' } });

    expect(input.value).toBe('2025-03-10');
  });

  it('lets the full typed year land, and survives a reload with 2026 intact', () => {
    const { unmount } = render(<ControlledBasicInfoTab initial={baseFormData} />);
    const input = screen.getByLabelText(/start date/i) as HTMLInputElement;

    // A stray partial-year keystroke arrives first, then the completed entry.
    fireEvent.change(input, { target: { value: '0006-06-15' } });
    fireEvent.change(input, { target: { value: '2026-06-15' } });

    expect(input.value).toBe('2026-06-15');
    unmount();

    // "Reload": remount fresh, as if the corrected value had just been saved
    // and the page were opened again.
    render(
      <ControlledBasicInfoTab
        initial={{
          ...baseFormData,
          start_date: new Date(Date.UTC(2026, 5, 15, 12, 0, 0)).toISOString()
        }}
      />
    );
    const reloaded = screen.getByLabelText(/start date/i) as HTMLInputElement;
    expect(reloaded.value).toBe('2026-06-15');
    expect(reloaded.value).not.toMatch(/^1906/);
  });

  it('still treats an explicit clear as a clear, not an ignored keystroke', () => {
    render(<ControlledBasicInfoTab initial={baseFormData} />);
    const input = screen.getByLabelText(/start date/i) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '' } });

    expect(input.value).toBe('');
  });
});
