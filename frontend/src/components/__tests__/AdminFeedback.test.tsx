import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

describe('AdminFeedback header accessibility (row 13)', () => {
  it('exposes sortable columns as buttons carrying a live aria-sort', async () => {
    mockGetFeedback.mockResolvedValue({ items: [item(1)], has_more: false });

    render(<AdminFeedback />);
    await waitFor(() => {
      expect(screen.getByText('feedback body 1')).toBeInTheDocument();
    });

    // Default sort is created_at desc: Date starts descending, the others unsorted.
    const dateSort = screen.getByRole('button', { name: /^Date/ });
    expect(dateSort.closest('th')).toHaveAttribute('aria-sort', 'descending');

    const categorySort = screen.getByRole('button', { name: /^Category/ });
    expect(categorySort.closest('th')).toHaveAttribute('aria-sort', 'none');
    fireEvent.click(categorySort);
    expect(categorySort.closest('th')).toHaveAttribute('aria-sort', 'ascending');

    // A non-sortable header stays a plain column header with no button.
    const feedbackHeader = screen.getByRole('columnheader', { name: 'Feedback' });
    expect(feedbackHeader).toHaveAttribute('scope', 'col');
  });
});

/**
 * THE LOAD-ERROR ALERT, RENDERED - not grepped.
 *
 * cto/AdaptaLabs#141 moved this component's colour out of a `<style>` tag and
 * out of 25 inline style blocks into `admin-feedback.css`. The rule that
 * paints the load-error message is a DESCENDANT selector, written in that
 * stylesheet as the `admin-feedback` wrapper class followed by the
 * `feedback-error-text` class. During the first pass the alert lost its
 * wrapper: the element still carried `feedback-error-text`, the stylesheet
 * still carried the rule, and the words rendered in body ink because the two
 * never met in the DOM.
 *
 * The sibling `admin-feedback-styles.test.ts` stayed green through all of
 * that, because it reads the two files as text and a descendant selector is
 * satisfied on paper by both halves merely existing. Only a render can see
 * whether they are actually nested, so this arm renders.
 *
 * Both halves are load-bearing and each is mutated separately in the round's
 * mutation table: drop the wrapper, or drop the class, and this fails.
 */
describe('AdminFeedback load-error alert sits where its colour rule can reach it', () => {
  const SCOPED_ERROR = '.admin-feedback .feedback-error-text';

  it('renders the load-error text inside the admin feedback scope', async () => {
    mockGetFeedback.mockRejectedValue(new Error('network down'));

    const { container } = render(<AdminFeedback />);

    await waitFor(() => {
      expect(container.querySelector(SCOPED_ERROR)).not.toBeNull();
    });

    const scoped = container.querySelector(SCOPED_ERROR);
    // The same element the admin reads the failure from, so the assertion
    // cannot be satisfied by some other empty node that happens to nest right.
    expect(scoped).toHaveTextContent('Failed to load feedback');
    expect(scoped).toHaveTextContent('Retry');
  });

  it('keeps the error alert element itself carrying the error text class', async () => {
    mockGetFeedback.mockRejectedValue(new Error('network down'));

    const { container } = render(<AdminFeedback />);

    await waitFor(() => {
      expect(container.querySelector('.admin-feedback')).not.toBeNull();
    });

    // Named separately from the arm above so a failure says WHICH half broke:
    // this one goes red when the class is dropped but the nesting survives.
    const alert = container.querySelector('.admin-feedback .alert');
    expect(alert).not.toBeNull();
    expect(alert?.classList.contains('feedback-error-text')).toBe(true);
  });
});

/**
 * cto/AdaptaLabs#150: the view-feedback modal's scrim was rendered as a plain
 * descendant of the admin-tabs card. That card carries `backdrop-filter`
 * (styles/_components.css), which - per spec - induces a stacking context of
 * its own. Because the card itself is not elevated in the root stacking
 * context, the page-level FeedbackFooter (a later sibling of <main>, z-index:
 * 10, position: relative) paints ABOVE the whole card and everything inside
 * it, scrim included, however high the scrim's own z-index reads.
 *
 * jsdom has no layout, so this cannot assert a paint order. What it CAN
 * assert is the fix's actual mechanism: the modal escapes that ancestor via a
 * portal to document.body, the same pattern ConfirmationModal already uses
 * for the identical reason. A modal that is not a DOM descendant of the
 * backdrop-filter card is provably outside its stacking context.
 */
describe('AdminFeedback view modal escapes the tabs card stacking context (cto/AdaptaLabs#150)', () => {
  it('portals the view-feedback scrim to document.body, not the render container', async () => {
    mockGetFeedback.mockResolvedValue({ items: [item(1)], has_more: false });

    const { container } = render(<AdminFeedback />);
    await waitFor(() => {
      expect(screen.getByText('feedback body 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('feedback body 1').closest('tr') as HTMLElement);

    const scrim = await screen.findByTestId('feedback-view-modal');
    // The would-be ancestor with backdrop-filter (admin-tabs-card in Admin.tsx)
    // wraps `container` in the real page; a portal renders as a sibling of
    // `container` under document.body, so it is never one of its descendants.
    expect(container.contains(scrim)).toBe(false);
    expect(document.body.contains(scrim)).toBe(true);
  });
});
