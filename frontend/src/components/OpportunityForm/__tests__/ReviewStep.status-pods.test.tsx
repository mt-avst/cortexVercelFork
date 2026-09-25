import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import ReviewStep from '../ReviewStep';
import type { ReviewSection } from '../../../lib/opportunity-authoring/review-summary';

/**
 * #167: the pods themselves are covered in `ReviewStep.test.tsx`, but
 * nothing there pinned the group's own `aria-describedby` wiring - measured
 * once as removable with the rest of the suite staying green. This file is
 * that missing proof: the radiogroup's accessible structure (name, its two
 * radios, each radio's own accessible name), the checked radio tracking
 * `status`, `onStatusChange` firing from a click, and
 * `aria-invalid`/`aria-describedby` on the GROUP tracking `statusError`.
 *
 * ArrowRight/ArrowLeft are deliberately NOT exercised here: a native
 * `<input type="radio">` group's arrow-key roving selection is browser
 * behaviour with no JS behind it (`StatusPods.tsx`'s own file comment), and
 * jsdom does not implement it - `fireEvent.keyDown(radio, { key:
 * 'ArrowRight' })` moves neither focus nor `checked` here, the same class of
 * gap `test-draft-warnings.test.ts` already documents for the Enter-key
 * implicit-submission algorithm. That half of the behaviour is proven in a
 * real browser instead, in `e2e/accessibility.test.ts`'s Review-step scan.
 */

const SECTION: ReviewSection = {
  stepId: 1,
  stepKey: 'basics',
  title: 'Basic Information',
  focusFieldId: 'title',
  items: [{ label: 'Title', value: 'A study about checkout' }]
};

const baseProps = {
  sections: [SECTION],
  header: { title: 'Checkout research study', typeLabel: 'Survey' },
  publishRefusal: null,
  onEdit: vi.fn(),
  isEdit: false,
  status: 'draft' as const,
  storedStatus: null,
  onStatusChange: vi.fn(),
  shareLink: null
};

const statusGroup = () => screen.getByRole('radiogroup', { name: 'Status' });

describe('ReviewStep - Status pods, the radiogroup contract (#167)', () => {
  it('is a radiogroup named "Status" with exactly two radios, each accessible name carrying its meaning line once', () => {
    render(<ReviewStep {...baseProps} />);

    const group = statusGroup();
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);

    const draft = within(group).getByRole('radio', { name: 'Draft Not visible to users' });
    const published = within(group).getByRole('radio', { name: 'Published Visible to users' });
    expect(draft).toBeInTheDocument();
    expect(published).toBeInTheDocument();

    // The meaning is announced through the label alone: no per-radio
    // aria-describedby duplicating it. A regression back to describing it a
    // second time would not break the name assertions above, so it is
    // checked separately.
    expect(draft).not.toHaveAttribute('aria-describedby');
    expect(published).not.toHaveAttribute('aria-describedby');
  });

  it('checks the radio matching `status`, and only that one', () => {
    const { rerender } = render(<ReviewStep {...baseProps} status="draft" />);
    let group = statusGroup();
    expect(within(group).getByRole('radio', { name: /^Draft/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /^Published/ })).not.toBeChecked();

    rerender(<ReviewStep {...baseProps} status="published" />);
    group = statusGroup();
    expect(within(group).getByRole('radio', { name: /^Published/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /^Draft/ })).not.toBeChecked();
  });

  it('clicking the other pod calls onStatusChange once, with the clicked value', () => {
    const onStatusChange = vi.fn();
    render(<ReviewStep {...baseProps} status="draft" onStatusChange={onStatusChange} />);

    fireEvent.click(within(statusGroup()).getByRole('radio', { name: /^Published/ }));

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledWith('published');
  });

  it('marks the group invalid and describes it by BOTH the error and the help text, when statusError is set', () => {
    render(<ReviewStep {...baseProps} statusError="Choose a status" />);

    const group = statusGroup();
    expect(group).toHaveAttribute('aria-invalid', 'true');
    // Exact, not `.toContain`: an implementation that dropped either half of
    // this list (the error text or the standing help text) would still pass
    // a substring check. The ids named here are exactly the two elements
    // this component renders beside the control - FieldError#status-error
    // and the standing #status-help copy.
    expect(group.getAttribute('aria-describedby')).toBe('status-error status-help');
    expect(screen.getByText('Choose a status').closest('[role="alert"]')).toHaveAttribute(
      'id',
      'status-error'
    );
  });

  it('is not marked invalid, and is described by help text alone, with no error', () => {
    render(<ReviewStep {...baseProps} />);

    const group = statusGroup();
    expect(group).toHaveAttribute('aria-invalid', 'false');
    expect(group.getAttribute('aria-describedby')).toBe('status-help');
  });
});
