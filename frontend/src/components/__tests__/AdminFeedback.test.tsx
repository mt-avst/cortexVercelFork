import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AdminFeedback from '../AdminFeedback';
import { getFeedback } from '../../api/client';

// cto/AdaptaLabs#81: GET /api/feedback is capped at FEEDBACK_LIST_LIMIT rows
// server-side and reports `has_more`. The UI's obligations under that contract
// are what this file pins: an overflowing table must be VISIBLE to the admin
// (a truncated list that looks complete is the silent-cap failure #24 refused
// on points-history), and an under-cap table must not nag about truncation
// that did not happen.

vi.mock('../../api/client', () => ({
  getFeedback: vi.fn(),
  deleteFeedback: vi.fn(),
  exportFeedbackCsv: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'A', email: 'a@example.com', role: 'superadmin' } }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({
    isDarkMode: false,
    toggleTheme: vi.fn(),
  }),
}));

const mockGetFeedback = vi.mocked(getFeedback);

const item = (n: number) => ({
  id: `id-${n}`,
  user_id: 'u1',
  user_name: `User ${n}`,
  user_email: `user${n}@example.com`,
  category: 'bug' as const,
  feedback: `feedback body ${n}`,
  url: 'https://example.com',
  user_agent: 'vitest',
  created_at: `2026-08-2${(n % 9) + 1}T00:00:00.000Z`,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AdminFeedback under the bounded list contract', () => {
  it('renders the rows and no truncation notice when has_more is false', async () => {
    mockGetFeedback.mockResolvedValue({ items: [item(1), item(2)], has_more: false });

    render(<AdminFeedback />);

    await waitFor(() => {
      expect(screen.getByText('feedback body 1')).toBeInTheDocument();
    });
    expect(screen.getByText('feedback body 2')).toBeInTheDocument();
    expect(screen.queryByTestId('feedback-truncation-notice')).not.toBeInTheDocument();
  });

  it('shows a truncation notice pointing at the export when has_more is true', async () => {
    mockGetFeedback.mockResolvedValue({ items: [item(1), item(2), item(3)], has_more: true });

    render(<AdminFeedback />);

    await waitFor(() => {
      expect(screen.getByText('feedback body 1')).toBeInTheDocument();
    });

    const notice = screen.getByTestId('feedback-truncation-notice');
    // The count in the copy is the number of rows actually shown, so the
    // sentence stays true whatever the server cap is - it cannot drift from a
    // second copy of the constant.
    expect(notice.textContent).toContain('Showing the most recent 3');
    expect(notice.textContent).toContain('Export');
  });

  it('marks the count badge as a floor, not a total, when the list is truncated', async () => {
    mockGetFeedback.mockResolvedValue({ items: [item(1), item(2), item(3)], has_more: true });

    render(<AdminFeedback />);

    await waitFor(() => {
      expect(screen.getByText('feedback body 1')).toBeInTheDocument();
    });

    // "3+" - a bare "3" would present the visible slice as the whole table.
    expect(screen.getByText('3+')).toBeInTheDocument();
  });

  it('keeps the count badge exact when nothing was cut off', async () => {
    mockGetFeedback.mockResolvedValue({ items: [item(1), item(2)], has_more: false });

    render(<AdminFeedback />);

    await waitFor(() => {
      expect(screen.getByText('feedback body 1')).toBeInTheDocument();
    });

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('2+')).not.toBeInTheDocument();
  });
});
