import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ScreenerStep from '../ScreenerStep';
import { withClientId, type WithClientId } from '../../../lib/opportunity-authoring/client-ids';
import { SCREENER_NEEDS_SCREEN_OUT } from '@shared/screener';
import type { ScreenerQuestion } from '@shared/types';

const aQuestion = (): WithClientId<ScreenerQuestion> =>
  withClientId({
    id: 'q1',
    prompt: 'Which best describes your role?',
    options: [
      { id: 'o1', label: 'Engineer', disqualifies: false },
      { id: 'o2', label: 'Something else', disqualifies: true }
    ]
  });

const renderStep = (
  overrides: Partial<React.ComponentProps<typeof ScreenerStep>> = {}
) => {
  const handlers = {
    onEnable: vi.fn(),
    onRemove: vi.fn(),
    onQuestionsChange: vi.fn(),
    onMessageChange: vi.fn(),
    onBlurField: vi.fn()
  };
  const props: React.ComponentProps<typeof ScreenerStep> = {
    hasScreener: true,
    questions: [aQuestion()],
    message: '',
    validationErrors: {},
    ...handlers,
    ...overrides
  };
  const view = render(<ScreenerStep {...props} />);
  return { ...handlers, view, props };
};

describe('ScreenerStep - the opt-in gate', () => {
  it('offers to add a screener when there is none', () => {
    const { onEnable } = renderStep({ hasScreener: false });

    // No builder while the study has no screener.
    expect(
      screen.queryByDisplayValue('Which best describes your role?')
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add a screener/i }));
    expect(onEnable).toHaveBeenCalled();
  });

  it('explains what a screener does before the author commits to one', () => {
    renderStep({ hasScreener: false });

    expect(screen.getByTestId('screener-step')).toHaveTextContent(
      /anyone signed in/i
    );
  });
});

describe('ScreenerStep - the builder', () => {
  it('shows the questions once a screener is on', () => {
    renderStep();

    expect(
      screen.getByDisplayValue('Which best describes your role?')
    ).toBeInTheDocument();
  });

  it('forwards a question change from the builder', () => {
    const { onQuestionsChange } = renderStep();

    fireEvent.change(
      screen.getByDisplayValue('Which best describes your role?'),
      { target: { value: 'What team are you on?' } }
    );

    expect(onQuestionsChange).toHaveBeenCalled();
  });

  it('edits the not-a-match message', () => {
    const { onMessageChange } = renderStep();

    fireEvent.change(screen.getByLabelText(/not a match/i), {
      target: { value: 'Thanks - not this time.' }
    });

    expect(onMessageChange).toHaveBeenCalledWith('Thanks - not this time.');
  });

  it('removes the screener', () => {
    const { onRemove } = renderStep();

    fireEvent.click(screen.getByRole('button', { name: /remove screener/i }));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe('ScreenerStep - validation display', () => {
  it('shows the whole-screener needs-a-screen-out message', () => {
    renderStep({
      validationErrors: { screener_questions: SCREENER_NEEDS_SCREEN_OUT }
    });

    expect(screen.getByText(SCREENER_NEEDS_SCREEN_OUT)).toBeInTheDocument();
  });

  it('shows a message-too-long error against the message field', () => {
    renderStep({
      message: 'way too long',
      validationErrors: { screener_message: 'Shorten this message to 1000 characters or fewer' }
    });

    expect(
      screen.getByText('Shorten this message to 1000 characters or fewer')
    ).toBeInTheDocument();
  });
});
