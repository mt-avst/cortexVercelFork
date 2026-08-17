import React from 'react';
import { render, screen } from '@testing-library/react';
import ResponsesSection from '../ResponsesSection';
import { FirstHandOutputStep } from '../../../api/types';

const steps: FirstHandOutputStep[] = [
  {
    step_id: 'step_1',
    order: 1,
    type: 'open_text',
    prompt: 'How did you find the checkout?',
    response: {
      text: 'It was straightforward.',
      selected_option: null,
      saved_at: '2026-07-15T10:05:00.000Z'
    }
  },
  {
    step_id: 'step_2',
    order: 2,
    type: 'single_choice',
    prompt: 'Rate the experience',
    response: {
      text: null,
      selected_option: 'Excellent',
      saved_at: '2026-07-15T10:08:00.000Z'
    }
  },
  {
    step_id: 'step_3',
    order: 3,
    type: 'open_text',
    prompt: 'Anything else?',
    response: null
  },
  {
    step_id: 'step_4',
    order: 4,
    type: 'instruction',
    prompt: 'Find a holiday offer on the front page',
    response: null
  }
];

describe('ResponsesSection', () => {
  it('renders prompts with text and choice responses', () => {
    render(<ResponsesSection steps={steps} />);

    expect(screen.getByText('How did you find the checkout?')).toBeInTheDocument();
    expect(screen.getByText('It was straightforward.')).toBeInTheDocument();
    expect(screen.getByText('Excellent')).toBeInTheDocument();
  });

  it('reads an unanswered step as spoken, not as missing data', () => {
    render(<ResponsesSection steps={steps} />);

    // Two unanswered steps here - one legacy open_text, one instruction -
    // and neither is data loss: capture of typed answers was removed, so
    // the recording holds them both.
    expect(
      screen.getAllByText('Answered out loud - in the recording')
    ).toHaveLength(2);
    expect(screen.queryByText('No response recorded')).toBeNull();
  });

  it('still shows answers stored by sessions run before the change', () => {
    render(<ResponsesSection steps={steps} />);

    // Historic data is not rewritten: a session that did capture typed
    // answers still shows them.
    expect(screen.getByText('It was straightforward.')).toBeInTheDocument();
    expect(screen.getByText('Excellent')).toBeInTheDocument();
  });

  it('shows an empty state when there are no steps', () => {
    render(<ResponsesSection steps={[]} />);

    expect(screen.getByText('No steps recorded for this session.')).toBeInTheDocument();
  });
});
