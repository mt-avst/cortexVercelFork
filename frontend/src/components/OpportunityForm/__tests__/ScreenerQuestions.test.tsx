import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ScreenerQuestions from '../ScreenerQuestions';
import { withClientId, type WithClientId } from '../../../lib/opportunity-authoring/client-ids';
import { SCREENER_QUESTION_NEEDS_PASS } from '@shared/screener';
import { VALIDATION } from '@shared/constants';
import type { ScreenerQuestion } from '@shared/types';

const question = (
  overrides: Partial<ScreenerQuestion> = {}
): WithClientId<ScreenerQuestion> =>
  withClientId({
    id: overrides.id ?? 'q1',
    prompt: overrides.prompt ?? 'Which best describes your role?',
    options: overrides.options ?? [
      { id: 'o1', label: 'Engineer', disqualifies: false },
      { id: 'o2', label: 'Something else', disqualifies: true }
    ]
  });

const renderList = (
  overrides: Partial<React.ComponentProps<typeof ScreenerQuestions>> = {}
) => {
  const onChange = vi.fn<(next: WithClientId<ScreenerQuestion>[]) => void>();
  const props: React.ComponentProps<typeof ScreenerQuestions> = {
    questions: [question()],
    onChange,
    validationErrors: {},
    ...overrides
  };
  const view = render(<ScreenerQuestions {...props} />);
  return { onChange, view, props };
};

describe('ScreenerQuestions - editing', () => {
  it('shows each question and its answers', () => {
    renderList();

    expect(
      screen.getByDisplayValue('Which best describes your role?')
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('Engineer')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Something else')).toBeInTheDocument();
  });

  it('edits a question prompt', () => {
    const { onChange } = renderList();

    fireEvent.change(
      screen.getByDisplayValue('Which best describes your role?'),
      { target: { value: 'What is your team?' } }
    );

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ prompt: 'What is your team?' })
    ]);
  });

  it('edits an answer label', () => {
    const { onChange } = renderList();

    fireEvent.change(screen.getByDisplayValue('Engineer'), {
      target: { value: 'Backend engineer' }
    });

    const next = onChange.mock.calls[0][0];
    expect(next[0].options[0].label).toBe('Backend engineer');
  });

  it('flags an answer as screen-out via its toggle', () => {
    const { onChange } = renderList();

    // The first answer starts as a Qualify; screen it out.
    const group = screen.getByRole('group', { name: /answer 1 eligibility/i });
    fireEvent.click(within(group).getByRole('button', { name: /screen out/i }));

    const next = onChange.mock.calls[0][0];
    expect(next[0].options[0].disqualifies).toBe(true);
  });

  it('reflects the current qualify/screen-out state on the toggle', () => {
    renderList();

    const group1 = screen.getByRole('group', { name: /answer 1 eligibility/i });
    expect(
      within(group1).getByRole('button', { name: /qualify/i })
    ).toHaveAttribute('aria-pressed', 'true');

    const group2 = screen.getByRole('group', { name: /answer 2 eligibility/i });
    expect(
      within(group2).getByRole('button', { name: /screen out/i })
    ).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('ScreenerQuestions - adding and removing', () => {
  it('adds a question, seeded with a qualify and a screen-out answer', () => {
    const { onChange } = renderList();

    fireEvent.click(screen.getByRole('button', { name: /add question/i }));

    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(2);
    expect(next[1].options).toHaveLength(2);
    expect(next[1].options.map((o) => o.disqualifies)).toEqual([false, true]);
  });

  it('hides Add question at the maximum', () => {
    renderList({
      questions: Array.from({ length: VALIDATION.SCREENER_MAX_QUESTIONS }, (_u, i) =>
        question({ id: `q${i}` })
      )
    });

    expect(
      screen.queryByRole('button', { name: /add question/i })
    ).not.toBeInTheDocument();
  });

  it('removes a question', () => {
    const { onChange } = renderList({
      questions: [question({ id: 'q1' }), question({ id: 'q2', prompt: 'Second?' })]
    });

    fireEvent.click(
      screen.getByRole('button', { name: /remove question 2/i })
    );

    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(1);
    expect(next[0].prompt).toBe('Which best describes your role?');
  });

  it('adds an answer to a question', () => {
    const { onChange } = renderList();

    fireEvent.click(screen.getByRole('button', { name: /add answer/i }));

    const next = onChange.mock.calls[0][0];
    expect(next[0].options).toHaveLength(3);
    expect(next[0].options[2]).toMatchObject({ label: '', disqualifies: false });
  });

  it('hides Add answer at the maximum', () => {
    const options = Array.from({ length: VALIDATION.SCREENER_MAX_OPTIONS }, (_u, i) => ({
      id: `o${i}`,
      label: `Answer ${i}`,
      disqualifies: i === 0
    }));
    renderList({ questions: [question({ options })] });

    expect(
      screen.queryByRole('button', { name: /add answer/i })
    ).not.toBeInTheDocument();
  });

  it('will not remove an answer below the minimum of two', () => {
    renderList();

    // With exactly two answers, both remove controls are disabled.
    const removeButtons = screen.getAllByRole('button', { name: /remove answer/i });
    removeButtons.forEach((button) => expect(button).toBeDisabled());
  });

  it('removes an answer when there are more than two', () => {
    const { onChange } = renderList({
      questions: [
        question({
          options: [
            { id: 'o1', label: 'Engineer', disqualifies: false },
            { id: 'o2', label: 'Designer', disqualifies: false },
            { id: 'o3', label: 'Other', disqualifies: true }
          ]
        })
      ]
    });

    fireEvent.click(screen.getByRole('button', { name: /remove answer 2/i }));

    const next = onChange.mock.calls[0][0];
    expect(next[0].options.map((o) => o.label)).toEqual(['Engineer', 'Other']);
  });
});

describe('ScreenerQuestions - validation display', () => {
  it('shows a prompt error against its question', () => {
    renderList({
      validationErrors: { 'screener_questions.0.prompt': 'Enter the question participants see' }
    });

    expect(
      screen.getByText('Enter the question participants see')
    ).toBeInTheDocument();
  });

  it('shows the shared needs-a-qualify message against the answers', () => {
    renderList({
      validationErrors: {
        'screener_questions.0.options': SCREENER_QUESTION_NEEDS_PASS
      }
    });

    expect(screen.getByText(SCREENER_QUESTION_NEEDS_PASS)).toBeInTheDocument();
  });

  it('shows an answer-label error against that answer', () => {
    renderList({
      validationErrors: {
        'screener_questions.0.options.1.label': 'Enter this answer'
      }
    });

    expect(screen.getByText('Enter this answer')).toBeInTheDocument();
  });

  it('revalidates a prompt on blur', () => {
    const onBlurField = vi.fn();
    renderList({ onBlurField });

    fireEvent.blur(screen.getByDisplayValue('Which best describes your role?'));

    expect(onBlurField).toHaveBeenCalledWith('screener_questions.0.prompt');
  });
});
