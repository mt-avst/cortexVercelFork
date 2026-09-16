import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import ScreenerCheck from '../ScreenerCheck';
import type { ParticipantScreener } from '@shared/types';

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false })
}));

const SCREENER: ParticipantScreener = {
  questions: [
    {
      id: 'q1',
      prompt: 'Which best describes your role?',
      options: [
        { id: 'o1', label: 'Engineer' },
        { id: 'o2', label: 'Something else' }
      ]
    },
    {
      id: 'q2',
      prompt: 'Have you used the checkout recently?',
      options: [
        { id: 'o3', label: 'Yes' },
        { id: 'o4', label: 'No' }
      ]
    }
  ],
  screenedOutMessage: 'Sorry, not a match this round.'
};

const arrange = (
  overrides: Partial<React.ComponentProps<typeof ScreenerCheck>> = {}
) => {
  const onSubmit = vi.fn().mockResolvedValue('qualified');
  const onQualified = vi.fn();
  const onClose = vi.fn();
  const props: React.ComponentProps<typeof ScreenerCheck> = {
    screener: SCREENER,
    onSubmit,
    onQualified,
    onClose,
    ...overrides
  };
  render(<ScreenerCheck {...props} />);
  return { onSubmit, onQualified, onClose };
};

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  vi.clearAllMocks();
  user = userEvent.setup();
});

describe('ScreenerCheck - answering', () => {
  it('shows every question and its answers, but never the disqualifies flag', () => {
    arrange();

    expect(screen.getByText('Which best describes your role?')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Engineer' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeInTheDocument();
    // The redacted shape carries no qualify/screen-out wording at all.
    expect(screen.queryByText(/screen out/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/qualif/i)).not.toBeInTheDocument();
  });

  it('keeps the check disabled until every question is answered', async () => {
    arrange();

    const check = screen.getByRole('button', { name: /check eligibility/i });
    expect(check).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Engineer' }));
    expect(check).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Yes' }));
    expect(check).toBeEnabled();
  });

  it('cancels without submitting', async () => {
    const { onClose, onSubmit } = arrange();

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('moves focus into the dialog on open', () => {
    arrange();

    const modal = screen.getByTestId('screener-check');
    // A bespoke aria-modal dialog must take focus itself; without it a keyboard
    // user is left on the page behind the backdrop.
    expect(modal.contains(document.activeElement)).toBe(true);
  });
});

describe('ScreenerCheck - verdict', () => {
  it('submits the chosen answers and resumes when qualified', async () => {
    const onSubmit = vi.fn().mockResolvedValue('qualified');
    const onQualified = vi.fn();
    arrange({ onSubmit, onQualified });

    await user.click(screen.getByRole('radio', { name: 'Engineer' }));
    await user.click(screen.getByRole('radio', { name: 'Yes' }));
    await user.click(screen.getByRole('button', { name: /check eligibility/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ q1: 'o1', q2: 'o3' })
    );
    await waitFor(() => expect(onQualified).toHaveBeenCalled());
  });

  it('shows the not-a-match message and does not resume when screened out', async () => {
    const onSubmit = vi.fn().mockResolvedValue('screened_out');
    const onQualified = vi.fn();
    arrange({ onSubmit, onQualified });

    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.click(screen.getByRole('radio', { name: 'No' }));
    await user.click(screen.getByRole('button', { name: /check eligibility/i }));

    expect(
      await screen.findByText('Sorry, not a match this round.')
    ).toBeInTheDocument();
    expect(onQualified).not.toHaveBeenCalled();
    // No path onward to booking from a screen-out.
    expect(
      screen.queryByRole('button', { name: /check eligibility/i })
    ).not.toBeInTheDocument();
  });

  it('falls back to a neutral message when the screener sets none', async () => {
    const onSubmit = vi.fn().mockResolvedValue('screened_out');
    arrange({
      screener: { questions: SCREENER.questions },
      onSubmit
    });

    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.click(screen.getByRole('radio', { name: 'No' }));
    await user.click(screen.getByRole('button', { name: /check eligibility/i }));

    expect(await screen.findByText(/not a match/i)).toBeInTheDocument();
  });

  it('lets a screened-out participant change their answers and try again', async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValueOnce('screened_out')
      .mockResolvedValueOnce('qualified');
    const onQualified = vi.fn();
    arrange({ onSubmit, onQualified });

    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.click(screen.getByRole('radio', { name: 'No' }));
    await user.click(screen.getByRole('button', { name: /check eligibility/i }));
    await screen.findByText('Sorry, not a match this round.');

    await user.click(screen.getByRole('button', { name: /change my answers/i }));
    // Back to the questions, cleared.
    expect(screen.getByRole('radio', { name: 'Engineer' })).not.toBeChecked();

    await user.click(screen.getByRole('radio', { name: 'Engineer' }));
    await user.click(screen.getByRole('radio', { name: 'Yes' }));
    await user.click(screen.getByRole('button', { name: /check eligibility/i }));

    await waitFor(() => expect(onQualified).toHaveBeenCalled());
  });

  it('surfaces an error and stays open when the submit fails', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('network'));
    const onQualified = vi.fn();
    arrange({ onSubmit, onQualified });

    await user.click(screen.getByRole('radio', { name: 'Engineer' }));
    await user.click(screen.getByRole('radio', { name: 'Yes' }));
    await user.click(screen.getByRole('button', { name: /check eligibility/i }));

    expect(await screen.findByText(/could not check/i)).toBeInTheDocument();
    expect(onQualified).not.toHaveBeenCalled();
    // Still answerable.
    expect(
      screen.getByRole('button', { name: /check eligibility/i })
    ).toBeInTheDocument();
  });
});
