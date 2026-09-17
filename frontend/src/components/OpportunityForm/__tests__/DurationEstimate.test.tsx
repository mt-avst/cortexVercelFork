import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DurationEstimate from '../DurationEstimate';

/**
 * What the estimate control SHOWS, as distinct from what the form sends.
 *
 * The payload side is covered against the real form. This covers the display
 * contract, which nothing reached: every page-level test clicks "Set it
 * myself" first, so the automatic mode - the default, and the one an author
 * sees before they touch anything - was rendered by no assertion at all.
 */
const renderControl = (
  props: Partial<React.ComponentProps<typeof DurationEstimate>> = {}
) => {
  const onValueChange = vi.fn();
  const onAutomaticChange = vi.fn();
  render(
    <DurationEstimate
      field="inline_survey_duration_minutes"
      value={undefined}
      automatic
      estimate={7}
      derivedFrom="6 questions"
      itemNoun="question"
      onValueChange={onValueChange}
      onAutomaticChange={onAutomaticChange}
      {...props}
    />
  );
  return { onValueChange, onAutomaticChange };
};

const field = () =>
  screen.getByLabelText(/Estimated completion time/i) as HTMLInputElement;

describe('while the estimate is in force', () => {
  /**
   * The worst of the three. A blank field with the estimate still in the
   * payload means the author is shown no number and the participant is told
   * one - and the author has no idea what.
   */
  it('shows the estimate, not the stale number underneath it', () => {
    renderControl({ value: 5000, estimate: 7 });

    expect(field()).toHaveValue(7);
  });

  /**
   * This repo has shipped an interactive-looking field that silently discarded
   * what was typed into it once already. Read-only is what makes "Set it
   * myself" a real choice rather than decoration.
   */
  it('does not accept typing until the author takes it over', () => {
    renderControl();

    expect(field()).toHaveAttribute('readonly');
  });

  it('names the list the number came from', () => {
    renderControl();

    expect(screen.getByText(/Automatically estimated/i)).toBeInTheDocument();
    expect(screen.getByText(/6 questions/)).toBeInTheDocument();
  });

  it('says there is nothing to estimate from, rather than showing nothing', () => {
    renderControl({ estimate: null });

    expect(screen.getByText(/nothing to estimate from yet/i)).toBeInTheDocument();
    expect(field()).toHaveValue(null);
  });

  /**
   * Row 19: this control is shared between the Task List step and the
   * Questions step, and the empty-state prompt used to say "Add a question"
   * unconditionally - wrong advice on the Task List step, which has no
   * question to add. The noun follows the step it is rendered on.
   */
  it('names the noun the step actually authors, in the empty-state prompt', () => {
    renderControl({ estimate: null, itemNoun: 'task', derivedFrom: '0 tasks' });

    expect(screen.getByText(/Add a task and this fills in/i)).toBeInTheDocument();
    expect(screen.queryByText(/Add a question/i)).not.toBeInTheDocument();
  });
});

describe('taking the estimate over', () => {
  /**
   * Seeded with the number the author was already looking at. Handing them an
   * empty box makes the override a retype rather than an adjustment, and an
   * empty box means "tell them nothing" - a different answer from the one they
   * asked for.
   */
  it('starts from the estimate rather than from empty', () => {
    const { onValueChange, onAutomaticChange } = renderControl({ estimate: 7 });

    fireEvent.click(screen.getByRole('button', { name: /Set it myself/i }));

    expect(onValueChange).toHaveBeenCalledWith(7);
    expect(onAutomaticChange).toHaveBeenCalledWith(false);
  });

  it('shows the author their own number once they have taken it over', () => {
    renderControl({ automatic: false, value: 25, estimate: 7 });

    expect(field()).toHaveValue(25);
    expect(field()).not.toHaveAttribute('readonly');
  });

  /**
   * Empty is a real answer, not a gap: it is how an author says "do not tell
   * the participant a length", which the field's own help text offers.
   */
  it('lets the author clear it back to nothing', () => {
    const { onValueChange } = renderControl({ automatic: false, value: 25 });

    fireEvent.change(field(), { target: { value: '' } });

    expect(onValueChange).toHaveBeenCalledWith(undefined);
  });

  it('hands it back to the estimate without touching the number', () => {
    const { onValueChange, onAutomaticChange } = renderControl({
      automatic: false,
      value: 25
    });

    fireEvent.click(screen.getByRole('button', { name: /Use the automatic estimate/i }));

    expect(onAutomaticChange).toHaveBeenCalledWith(true);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
