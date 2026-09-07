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

describe('StepActions - onSaveAndExit', () => {
  it('renders Save and exit independently of justSaved', () => {
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
    expect(screen.getByRole('button', { name: /Save and exit/ })).toBeInTheDocument();
  });
});
