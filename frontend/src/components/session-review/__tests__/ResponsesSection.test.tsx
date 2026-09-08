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
    render(<ResponsesSection steps={steps} hasRecording />);

    expect(screen.getByText('How did you find the checkout?')).toBeInTheDocument();
    expect(screen.getByText('It was straightforward.')).toBeInTheDocument();
    expect(screen.getByText('Excellent')).toBeInTheDocument();
  });

  it('reads an unanswered step as spoken when there is a recording', () => {
    render(<ResponsesSection steps={steps} hasRecording />);

    // Two unanswered steps here - one legacy open_text, one instruction -
    // and neither is data loss: capture of typed answers was removed, so
    // the recording holds them both.
    expect(
      screen.getAllByText('Answered out loud - in the recording')
    ).toHaveLength(2);
    expect(screen.queryByText('No response recorded')).toBeNull();
  });

  it('does not claim a recording holds the answer when there is none', () => {
    // An abandoned session has no recording card; pointing every unanswered
    // task at "the recording" fabricated an answer. Row 8.
    render(<ResponsesSection steps={steps} hasRecording={false} />);

    expect(
      screen.getAllByText('No response recorded')
    ).toHaveLength(2);
    expect(screen.queryByText('Answered out loud - in the recording')).toBeNull();
    // A stored answer is still shown regardless of recording state.
    expect(screen.getByText('It was straightforward.')).toBeInTheDocument();
  });

  it('still shows answers stored by sessions run before the change', () => {
    render(<ResponsesSection steps={steps} hasRecording />);

    // Historic data is not rewritten: a session that did capture typed
    // answers still shows them.
    expect(screen.getByText('It was straightforward.')).toBeInTheDocument();
    expect(screen.getByText('Excellent')).toBeInTheDocument();
  });

  it('shows an empty state when there are no steps', () => {
    render(<ResponsesSection steps={[]} hasRecording />);

    expect(screen.getByText('No steps recorded for this session.')).toBeInTheDocument();
  });
});
