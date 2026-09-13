import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import PendingApprovals from '../PendingApprovals';
import { getPendingApprovals, approveSession, rejectSession } from '../../api/client';

vi.mock('../../api/client', () => ({
  getPendingApprovals: vi.fn(),
  approveSession: vi.fn(),
  rejectSession: vi.fn(),
}));

const approval = {
  booking_id: 'b1',
  user_id: 'u1',
  session_id: 's1',
  completed_at: '2026-09-01T10:00:00.000Z',
  admin_notes: null,
  user_name: 'Ada Tester',
  user_email: 'ada@example.com',
  start_time: '2026-09-01T09:00:00.000Z',
  end_time: '2026-09-01T10:00:00.000Z',
  opportunity_title: 'Checkout study',
  opportunity_type: 'test',
  owner_user_id: 'owner-1',
};

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.clearAllMocks();
  user = userEvent.setup();
  vi.mocked(getPendingApprovals).mockResolvedValue([{ ...approval }]);
  vi.mocked(approveSession).mockResolvedValue({
    message: 'ok',
    pointsAwarded: 50,
    newLevel: 2,
    levelUp: true,
    totalPoints: 150,
  });
  vi.mocked(rejectSession).mockResolvedValue({ message: 'ok', status: 'rejected' });
});

describe('PendingApprovals', () => {
  it('refuses to reject without a reason, and never calls the API', async () => {
    render(<PendingApprovals />);
    await screen.findByRole('heading', { name: 'Ada Tester' });

    await user.click(screen.getByRole('button', { name: /Reject/i }));

    // The irreversible action is blocked and a reason is demanded in place.
    expect(rejectSession).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/add a reason before rejecting/i);
    expect(screen.getByLabelText(/Admin notes/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('rejects with the reason once one is given', async () => {
    render(<PendingApprovals />);
    await screen.findByRole('heading', { name: 'Ada Tester' });

    await user.type(screen.getByLabelText(/Admin notes/i), 'Recording was blank');
    await user.click(screen.getByRole('button', { name: /Reject/i }));

    await waitFor(() =>
      expect(rejectSession).toHaveBeenCalledWith('b1', 'Recording was blank')
    );
  });

  it('discloses the points award inline, not in a browser alert', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<PendingApprovals />);
    await screen.findByRole('heading', { name: 'Ada Tester' });

    await user.click(screen.getByRole('button', { name: /Approve/i }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/50 points awarded/i)
    );
    // The points award used to be announced in a blocking window.alert.
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('names the study type with the participant-facing label, not the raw enum (V-7)', async () => {
    render(<PendingApprovals />);
    await screen.findByRole('heading', { name: 'Ada Tester' });
    // opportunity_type 'test' reads as "Live session" everywhere else in the
    // product; the approvals card printed the raw enum.
    expect(screen.getByText('Live session')).toBeInTheDocument();
    expect(screen.queryByText('test')).not.toBeInTheDocument();
  });
});
