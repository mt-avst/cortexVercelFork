import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import StudySourceChoice from '../StudySourceChoice';

const renderChoice = (
  overrides: Partial<React.ComponentProps<typeof StudySourceChoice>> = {}
) => {
  const onChange = overrides.onChange ?? vi.fn();
  render(
    <StudySourceChoice
      noun="question"
      idPrefix="survey"
      value={overrides.value ?? 'blank'}
      onChange={onChange}
      copyLabel={overrides.copyLabel ?? 'Start from an existing set of questions'}
    />
  );
  return { onChange };
};

describe('choosing an arm', () => {
  /**
   * Every existing caller clicks the copy radio and never clicks back to
   * blank, so a mis-wired blank `onChange` had nothing to fail against. Both
   * arms are exercised here, each asserted against its OWN value.
   */
  it('reports "blank" when the create-here radio is chosen', () => {
    const { onChange } = renderChoice({ value: 'copy' });

    fireEvent.click(
      screen.getByRole('radio', { name: 'Create questions for this opportunity' })
    );

    expect(onChange).toHaveBeenCalledWith('blank');
    expect(onChange).not.toHaveBeenCalledWith('copy');
  });

  it('reports "copy" when the copy radio is chosen', () => {
    const { onChange } = renderChoice({ value: 'blank' });

    fireEvent.click(
      screen.getByRole('radio', { name: /Start from an existing set of questions/ })
    );

    expect(onChange).toHaveBeenCalledWith('copy');
    expect(onChange).not.toHaveBeenCalledWith('blank');
  });

  /**
   * The whole reason the checkbox was replaced: the consequence of taking a
   * copy is stated on the control itself, not discovered afterwards.
   */
  it('states what taking a copy means, on the control itself', () => {
    renderChoice();

    expect(
      screen.getByText(
        'A copy is taken, so you can edit it here and the original is left alone.'
      )
    ).toBeInTheDocument();
  });

  /** Without a shared name, two radios are two separate one-option groups. */
  it('puts both radios in the same named group', () => {
    renderChoice();

    const blank = screen.getByRole('radio', {
      name: 'Create questions for this opportunity'
    }) as HTMLInputElement;
    const copy = screen.getByRole('radio', {
      name: /Start from an existing set of questions/
    }) as HTMLInputElement;

    expect(blank.name).toBe('survey_source');
    expect(copy.name).toBe('survey_source');
    expect(blank.name).toBe(copy.name);
  });
});
