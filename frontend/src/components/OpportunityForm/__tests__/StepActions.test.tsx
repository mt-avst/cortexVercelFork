import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import StepActions from '../StepActions';

/**
 * #109: a save that succeeded gave no acknowledgement an author could see on
 * the button they had just pressed - only a banner above the fold, easily
 * scrolled past. `justSaved` is the fix: for a few seconds after a genuine
 * success, the control the author pressed says "Saved" instead of its normal
 * label.
 *
 * `justSaved` is computed by the form from `successMessage`
 * (`Boolean(successMessage)`) and passed in, exactly like `disabled` - this
 * file tests what the row does with it, not when the form sets it. The
 * OpportunityForm-level timing (the literal 1500/3000ms windows) is covered
 * in `OpportunityForm.save-confirmation.test.tsx`.
 */

const noop = () => {};

/**
 * Every test in this block uses `onNext`/`nextLabel` for the forward
 * control, deliberately - `onSubmit`'s own label also becomes "Saved" once
 * `justSaved` is true (see the next describe block), and two buttons named
 * "Saved" on the same row is exactly the ambiguity `getByRole` cannot
 * resolve. `onNext` never carries a Saved state at all (proven at the
 * bottom of this file), so it is the one combination that isolates the Save
 * Changes shortcut on its own.
 */
describe('StepActions - the Save Changes shortcut', () => {
  it('reads Save Changes by default', () => {
    render(
      <StepActions
        onNext={noop}
        nextLabel="Content & Details"
        onSave={noop}
        isEdit
        saving={false}
        disabled={false}
      />
    );
    const button = screen.getByRole('button', { name: 'Save Changes' });
    expect(button).toBeInTheDocument();
  });

  it('reads Saved, with the checkmark, once justSaved is true', () => {
    render(
      <StepActions
        onNext={noop}
        nextLabel="Content & Details"
        onSave={noop}
        isEdit
        saving={false}
        disabled={false}
        justSaved
      />
    );
    const button = screen.getByRole('button', { name: 'Saved' });
    expect(button).toBeInTheDocument();
    expect(button.querySelector('svg')).not.toBeNull();
    expect(screen.queryByText('Save Changes')).not.toBeInTheDocument();
  });

  it('reverts to Save Changes once justSaved goes back to false', () => {
    const { rerender } = render(
      <StepActions
        onNext={noop}
        nextLabel="Content & Details"
        onSave={noop}
        isEdit
        saving={false}
        disabled={false}
        justSaved
      />
    );
    expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument();

    rerender(
      <StepActions
        onNext={noop}
        nextLabel="Content & Details"
        onSave={noop}
        isEdit
        saving={false}
        disabled={false}
        justSaved={false}
      />
    );
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
  });

  it('shows Saving..., not Saved, while a save is actually in flight', () => {
    // `saving` must win: a confirmation for a save that has not resolved yet
    // would tell the author something false is already true.
    render(
      <StepActions
        onNext={noop}
        nextLabel="Content & Details"
        onSave={noop}
        isEdit
        saving
        disabled
        justSaved
      />
    );
    expect(screen.getByRole('button', { name: /Saving\.\.\./ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
  });
});

describe('StepActions - the terminal control', () => {
  it('reads the given submitLabel by default', () => {
    render(
      <StepActions onSubmit={noop} submitLabel="Create opportunity" isEdit={false} saving={false} disabled={false} />
    );
    expect(screen.getByRole('button', { name: 'Create opportunity' })).toBeInTheDocument();
  });

  it('reads Saved, with the checkmark, once justSaved is true - whatever submitLabel says', () => {
    render(
      <StepActions
        onSubmit={noop}
        submitLabel="Save changes"
        isEdit
        saving={false}
        disabled={false}
        justSaved
      />
    );
    const button = screen.getByRole('button', { name: 'Saved' });
    expect(button).toBeInTheDocument();
    expect(button.querySelector('svg')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('shows Updating..., not Saved, while an edit save is in flight', () => {
    render(
      <StepActions
        onSubmit={noop}
        submitLabel="Save changes"
        isEdit
        saving
        disabled
        justSaved
      />
    );
    expect(screen.getByRole('button', { name: /Updating\.\.\./ })).toBeInTheDocument();
  });

  it('shows Creating..., not Saved, while a create save is in flight', () => {
    render(
      <StepActions
        onSubmit={noop}
        submitLabel="Create opportunity"
        isEdit={false}
        saving
        disabled
        justSaved
      />
    );
    expect(screen.getByRole('button', { name: /Creating\.\.\./ })).toBeInTheDocument();
  });

  it('defaults justSaved to false when the caller does not pass it at all', () => {
    // The prop has a default, deliberately - a caller that forgets to wire it
    // up must get the ordinary label, not a permanent false "Saved".
    render(
      <StepActions onSubmit={noop} submitLabel="Create opportunity" isEdit={false} saving={false} disabled={false} />
    );
    expect(screen.queryByRole('button', { name: 'Saved' })).not.toBeInTheDocument();
  });
});

describe('StepActions - onNext is unaffected by justSaved', () => {
  it('never shows a Saved state on the forward control - only Save and Submit carry one', () => {
    render(
      <StepActions
        onNext={noop}
        nextLabel="Content & Details"
        onSave={noop}
        isEdit
        saving={false}
        disabled={false}
        justSaved
      />
    );
    // The forward control keeps its own label regardless of justSaved.
    expect(
      screen.getByRole('button', { name: /Content & Details/ })
    ).toBeInTheDocument();
    // Save Changes is the one that carries the confirmation here.
    expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument();
  });
});

/**
 * D9 (row 24): "Save and exit" is deleted from the row. Drafts autosave, and
 * Exit to dashboard already covers a deliberate exit, so the middle button
 * was a second way to do something the row already did - and, per
 * verify-claims #10, the one whose position drifted up to 74px as its two
 * neighbours resized around it.
 *
 * `onSaveAndExit` is still accepted (see the prop's own comment in
 * StepActions.tsx - a caller in OpportunityForm.tsx, which this build does
 * not touch, may still pass it) but must never render anything, whether or
 * not a handler is given.
 */
describe('StepActions - D9: no "Save and exit" (row 24)', () => {
  it('never renders "Save and exit", even when onSaveAndExit is passed', () => {
    render(
      <StepActions
        onSubmit={noop}
        submitLabel="Create opportunity"
        onSaveAndExit={vi.fn()}
        isEdit
        saving={false}
        disabled={false}
        justSaved
      />
    );
    expect(screen.queryByRole('button', { name: /Save and exit/ })).not.toBeInTheDocument();
  });

  it('never renders it on the forward-control shape either', () => {
    render(
      <StepActions
        onNext={noop}
        nextLabel="Content & Details"
        onSaveAndExit={vi.fn()}
        isEdit
        saving={false}
        disabled={false}
      />
    );
    expect(screen.queryByRole('button', { name: /Save and exit/ })).not.toBeInTheDocument();
  });
});

/**
 * D9: one commit colour, fixed-width Previous/Continue/terminal buttons.
 */
describe('StepActions - D9: one commit colour, fixed-width nav buttons (row 24)', () => {
  it('the terminal button defaults to btn-primary, not btn-success - one colour with Continue', () => {
    render(
      <StepActions onSubmit={noop} submitLabel="Create opportunity" isEdit={false} saving={false} disabled={false} />
    );
    const button = screen.getByRole('button', { name: 'Create opportunity' });
    expect(button).toHaveClass('btn-primary');
    expect(button).not.toHaveClass('btn-success');
  });

  it('an explicit submitVariant is still honoured, for a caller that opts back in', () => {
    render(
      <StepActions
        onSubmit={noop}
        submitLabel="Create opportunity"
        submitVariant="success"
        isEdit={false}
        saving={false}
        disabled={false}
      />
    );
    expect(screen.getByRole('button', { name: 'Create opportunity' })).toHaveClass('btn-success');
  });

  it('Previous and the forward control both carry the shared nav-button hook class', () => {
    render(
      <StepActions
        onPrevious={noop}
        previousLabel="Basic Information"
        onNext={noop}
        nextLabel="Task List"
        isEdit
        saving={false}
        disabled={false}
      />
    );
    expect(screen.getByRole('button', { name: /^Previous:/ })).toHaveClass('step-actions__nav-button');
    expect(screen.getByRole('button', { name: /^Task List/ })).toHaveClass('step-actions__nav-button');
  });

  it('the row itself carries the sticky class', () => {
    const { container } = render(
      <StepActions onSubmit={noop} submitLabel="Create opportunity" isEdit={false} saving={false} disabled={false} />
    );
    expect(container.querySelector('.step-actions')).toBeInTheDocument();
  });

  it('the terminal button carries a stable, colour-independent hook for other tests to find it by', () => {
    // OpportunityForm.save-confirmation.test.tsx used to find this control by
    // `.btn-success`; D9 made that class a moving target (it is `btn-primary`
    // by default now, and callers may still opt into `success`). This class
    // is never conditional on `submitVariant`.
    render(
      <StepActions
        onSubmit={noop}
        submitLabel="Create opportunity"
        submitVariant="success"
        isEdit={false}
        saving={false}
        disabled={false}
      />
    );
    expect(screen.getByRole('button', { name: 'Create opportunity' })).toHaveClass('step-actions__submit');
  });

  it('the per-step Save Changes shortcut is btn-primary too - "one commit colour" means every commit control', () => {
    // Row 24's own finding: the shortcut was still green (btn-success) after
    // the terminal button became btn-primary, so the row disagreed with
    // itself about which colour means "commit". Both are the commit action;
    // D9's fix is one colour for all of them, not just the terminal one.
    render(
      <StepActions
        onNext={noop}
        nextLabel="Content & Details"
        onSave={noop}
        isEdit
        saving={false}
        disabled={false}
      />
    );
    const shortcut = screen.getByRole('button', { name: 'Save Changes' });
    expect(shortcut).toHaveClass('btn-primary');
    expect(shortcut).not.toHaveClass('btn-success');
  });
});

/**
 * #167: below 900px Previous collapses to an icon-only square
 * (`_components.css`, the 899px media block) - jsdom applies no CSS, so it
 * cannot see that layout itself, only what stays true regardless of it.
 * `aria-label` is set unconditionally in StepActions.tsx (not derived from
 * the now-hidden visible label), which is what keeps the button announcing
 * "Previous: <step>" once the visible word disappears - the accessible-name
 * half a real browser is not needed for; the icon-only geometry itself is
 * pinned in the accessibility Playwright config instead.
 */
describe('StepActions - Previous keeps its accessible name for the icon-only layout', () => {
  it('carries an aria-label with the full "Previous: <step>" text, unconditionally', () => {
    render(
      <StepActions
        onPrevious={noop}
        previousLabel="Consent"
        onNext={noop}
        nextLabel="Review"
        isEdit
        saving={false}
        disabled={false}
      />
    );
    const button = screen.getByRole('button', { name: 'Previous: Consent' });
    expect(button).toHaveAttribute('aria-label', 'Previous: Consent');
    // The visible label span is still in the DOM too - CSS alone hides it
    // below 900px, React never conditionally renders it - so a regression
    // that deletes only the ATTRIBUTE cannot hide behind the visible text
    // this same query would otherwise also satisfy.
    expect(button.querySelector('.step-actions__label')).toHaveTextContent('Previous: Consent');
  });
});
