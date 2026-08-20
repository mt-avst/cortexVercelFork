import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import StudyProvenanceNote from '../StudyProvenanceNote';

const renderNote = (
  overrides: Partial<React.ComponentProps<typeof StudyProvenanceNote>> = {}
) => {
  const onChooseAnother = overrides.onChooseAnother;
  render(
    <StudyProvenanceNote
      title={overrides.title === undefined ? 'Checkout flow' : overrides.title}
      copiedAt={overrides.copiedAt}
      noun="question"
      onChooseAnother={onChooseAnother}
    />
  );
};

describe('what the note says', () => {
  it("names the source it was copied from", () => {
    renderNote({ title: 'Checkout flow' });

    expect(screen.getByText('Checkout flow')).toBeInTheDocument();
  });

  it('shows the formatted copy date', () => {
    renderNote({ copiedAt: '2026-02-03T00:00:00.000Z' });

    expect(screen.getByText(/on 3 February 2026/)).toBeInTheDocument();
  });

  /**
   * The consequence the checkbox this replaced never stated: from the moment
   * of copying, neither side affects the other again.
   */
  it('states that later changes to the original will not affect this opportunity', () => {
    renderNote();

    expect(
      screen.getByText(
        /Later changes to the original will not affect\s+this opportunity/
      )
    ).toBeInTheDocument();
  });

  it('degrades to a generic message when the source could no longer be resolved', () => {
    renderNote({ title: null });

    expect(screen.getByText('a set that no longer exists')).toBeInTheDocument();
    expect(screen.queryByText('Checkout flow')).not.toBeInTheDocument();
  });

  it('does not render "Invalid Date" for an unparseable copiedAt', () => {
    renderNote({ copiedAt: 'not-a-real-date' });

    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ on /)).not.toBeInTheDocument();
  });
});

describe('choosing a different set', () => {
  it('does not render the control when no callback is supplied', () => {
    renderNote();

    expect(
      screen.queryByRole('button', { name: /Choose a different set/ })
    ).not.toBeInTheDocument();
  });

  it('renders and calls the callback when supplied', () => {
    const onChooseAnother = vi.fn();
    renderNote({ onChooseAnother });

    fireEvent.click(
      screen.getByRole('button', { name: 'Choose a different set of questions' })
    );

    expect(onChooseAnother).toHaveBeenCalledTimes(1);
  });
});
