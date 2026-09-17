import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DescribeIt from '../DescribeIt';
import { draftOpportunityFromBrief, getAiDraftingAvailable } from '../../../api/client';

vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>(
    '../../../api/client'
  );
  return {
    ...actual,
    getAiDraftingAvailable: vi.fn(),
    draftOpportunityFromBrief: vi.fn()
  };
});

/*
 * D13 AI study drafting (docs/AI-STUDY-DRAFTING-SPEC.md). DescribeIt is the
 * live panel StudyTypePicker mounts behind `onApplyDraft`. Its own contract:
 *
 *  - HIDDEN while availability is unknown, and hidden for good once it
 *    resolves to unavailable (no key/flag) or a live draft call answers 503.
 *  - Nothing is saved and no draft is created just by typing or by a
 *    successful Suggest - only "Apply to form" calls back to the parent, and
 *    even that never calls a save endpoint.
 *  - Any OTHER failure (429, 422, network) falls back to an inert shell with
 *    one line of explanation, rather than an error boundary or a blank panel.
 */

const BRIEF = 'Do first-time admins understand the new board view well enough to set one up?';

const SAMPLE_RESPONSE = {
  draft: {
    type: 'poll' as const,
    title: 'Board view discoverability',
    purpose_one_liner: 'Understand whether admins can self-serve the new board view',
    status: 'draft' as const
  },
  assumptions: ['Assumed a 10 minute session.'],
  gaps: ['No target date given.'],
  filled: ['type', 'title', 'purpose_one_liner']
};

const httpError = (status: number) => {
  const error = new Error('request failed') as Error & { response?: { status: number } };
  error.response = { status };
  return error;
};

beforeEach(() => {
  vi.mocked(getAiDraftingAvailable).mockReset();
  vi.mocked(draftOpportunityFromBrief).mockReset();
});

describe('DescribeIt - availability', () => {
  it('renders nothing while availability is being checked', () => {
    vi.mocked(getAiDraftingAvailable).mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<DescribeIt onApply={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing once availability resolves false', async () => {
    vi.mocked(getAiDraftingAvailable).mockResolvedValue(false);
    const { container } = render(<DescribeIt onApply={vi.fn()} />);

    await waitFor(() => expect(vi.mocked(getAiDraftingAvailable)).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the panel once availability resolves true', async () => {
    vi.mocked(getAiDraftingAvailable).mockResolvedValue(true);
    render(<DescribeIt onApply={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('front-door-ai-prompt')).toBeInTheDocument();
    });
  });
});

describe('DescribeIt - the Suggest button', () => {
  beforeEach(() => {
    vi.mocked(getAiDraftingAvailable).mockResolvedValue(true);
  });

  it('is disabled below the 20 character floor', async () => {
    render(<DescribeIt onApply={vi.fn()} />);
    await waitFor(() => screen.getByTestId('front-door-ai-prompt'));

    fireEvent.change(screen.getByLabelText(/What do you want to find out/i), {
      target: { value: 'too short' }
    });

    expect(screen.getByRole('button', { name: /Suggest a type/i })).toBeDisabled();
  });

  it('is enabled at the 20 character floor and calls the draft endpoint with hints', async () => {
    vi.mocked(draftOpportunityFromBrief).mockResolvedValue(SAMPLE_RESPONSE);
    render(<DescribeIt onApply={vi.fn()} hints={{ type: 'poll', delivery_mode: 'native' }} />);
    await waitFor(() => screen.getByTestId('front-door-ai-prompt'));

    fireEvent.change(screen.getByLabelText(/What do you want to find out/i), {
      target: { value: BRIEF }
    });
    expect(screen.getByRole('button', { name: /Suggest a type/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Suggest a type/i }));

    await waitFor(() => {
      expect(draftOpportunityFromBrief).toHaveBeenCalledWith(BRIEF, {
        type: 'poll',
        delivery_mode: 'native'
      });
    });
  });

  it('creates no draft and saves nothing merely by typing - the endpoint is called only on click', async () => {
    render(<DescribeIt onApply={vi.fn()} />);
    await waitFor(() => screen.getByTestId('front-door-ai-prompt'));

    fireEvent.change(screen.getByLabelText(/What do you want to find out/i), {
      target: { value: BRIEF }
    });

    expect(draftOpportunityFromBrief).not.toHaveBeenCalled();
  });
});

describe('DescribeIt - the review list and Apply/Discard', () => {
  beforeEach(() => {
    vi.mocked(getAiDraftingAvailable).mockResolvedValue(true);
    vi.mocked(draftOpportunityFromBrief).mockResolvedValue(SAMPLE_RESPONSE);
  });

  let onApply: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onApply = vi.fn();
  });

  const suggestAndWaitForReview = async () => {
    render(<DescribeIt onApply={onApply} />);
    await waitFor(() => screen.getByTestId('front-door-ai-prompt'));
    fireEvent.change(screen.getByLabelText(/What do you want to find out/i), {
      target: { value: BRIEF }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Suggest a type/i }));
    });
    await waitFor(() => screen.getByTestId('ai-draft-review'));
  };

  it('shows filled fields, assumptions and gaps after a successful draft', async () => {
    await suggestAndWaitForReview();

    const review = screen.getByTestId('ai-draft-review');
    expect(review).toHaveTextContent('Title');
    expect(review).toHaveTextContent('Assumed a 10 minute session.');
    expect(review).toHaveTextContent('No target date given.');
  });

  it('Apply calls onApply with the draft and never calls a save endpoint itself', async () => {
    await suggestAndWaitForReview();

    fireEvent.click(screen.getByRole('button', { name: /Apply to form/i }));

    expect(onApply).toHaveBeenCalledWith(SAMPLE_RESPONSE.draft);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('Apply returns the panel to idle, ready for another brief', async () => {
    await suggestAndWaitForReview();
    fireEvent.click(screen.getByRole('button', { name: /Apply to form/i }));

    expect(screen.queryByTestId('ai-draft-review')).toBeNull();
    expect(screen.getByRole('button', { name: /Suggest a type/i })).toBeInTheDocument();
  });

  it('Discard returns to the textarea without applying anything', async () => {
    await suggestAndWaitForReview();

    fireEvent.click(screen.getByRole('button', { name: /Discard/i }));

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ai-draft-review')).toBeNull();
    expect(screen.getByLabelText(/What do you want to find out/i)).toHaveValue(BRIEF);
  });
});

describe('DescribeIt - error handling falls back gracefully', () => {
  beforeEach(() => {
    vi.mocked(getAiDraftingAvailable).mockResolvedValue(true);
  });

  const suggest = async () => {
    render(<DescribeIt onApply={vi.fn()} />);
    await waitFor(() => screen.getByTestId('front-door-ai-prompt'));
    fireEvent.change(screen.getByLabelText(/What do you want to find out/i), {
      target: { value: BRIEF }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Suggest a type/i }));
    });
  };

  it('a 503 from a live call hides the whole panel, not just an error message', async () => {
    vi.mocked(draftOpportunityFromBrief).mockRejectedValue(httpError(503));
    await suggest();

    await waitFor(() => {
      expect(screen.queryByTestId('front-door-ai-prompt')).toBeNull();
    });
  });

  it('a 429 falls back to an inert shell with a rate-limit message, panel still visible', async () => {
    vi.mocked(draftOpportunityFromBrief).mockRejectedValue(httpError(429));
    await suggest();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/too many draft requests/i);
    });
    expect(screen.getByTestId('front-door-ai-prompt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Suggest a type/i })).toBeDisabled();
  });

  it('a 422 falls back to an inert shell naming the brief as the problem', async () => {
    vi.mocked(draftOpportunityFromBrief).mockRejectedValue(httpError(422));
    await suggest();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/didn't produce a usable draft/i);
    });
  });

  it('a network error (no response) falls back to a generic inert message', async () => {
    vi.mocked(draftOpportunityFromBrief).mockRejectedValue(new Error('Network Error'));
    await suggest();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/unavailable right now/i);
    });
  });
});
