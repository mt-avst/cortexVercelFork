import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { createRef } from 'react';
import { PhoneStudyFilters, PhoneStudyFiltersProps } from '../PhoneStudyFilters';
import type { QuickFilter } from '../../../utils/adminDashboard';

/**
 * PhoneStudyFilters (<576px filter toolbar), TESTLANE-C section 2:
 * - aria-expanded/aria-controls on the disclosure toggle
 * - focus goes to Status on open
 * - Escape is scoped to the panel and its toggle: closes the panel, returns
 *   focus, and does not reach a row menu open elsewhere on the page
 * - the badge counts non-default filters and sort
 */

const counts: Record<QuickFilter, number> = {
  broken: 1,
  'needs-recruitment': 2,
  draft: 0,
  'closing-soon': 3,
  'fully-booked': 0,
};

const baseProps: PhoneStudyFiltersProps = {
  searchQuery: '',
  onSearchChange: vi.fn(),
  searchInputRef: createRef<HTMLInputElement>(),
  statusFilter: '',
  onStatusChange: vi.fn(),
  typeFilter: '',
  onTypeChange: vi.fn(),
  showSort: true,
  sortField: 'status',
  sortDirection: 'asc',
  onSortFieldChange: vi.fn(),
  onToggleSortDirection: vi.fn(),
  sortIsDefault: true,
  quickFilter: null,
  quickFilterCounts: counts,
  onToggleQuickFilter: vi.fn(),
  hasActiveFilters: false,
  resultShown: 4,
  resultTotal: 6,
  onClearFilters: vi.fn(),
  resultCountRef: createRef<HTMLSpanElement>(),
};

const renderFilters = (over: Partial<PhoneStudyFiltersProps> = {}) =>
  render(<PhoneStudyFilters {...baseProps} {...over} />);

const openPanel = () => {
  fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PhoneStudyFilters', () => {
  it('the toggle carries aria-expanded (false, then true) and aria-controls naming the panel id once it exists', () => {
    renderFilters();
    const toggle = screen.getByRole('button', { name: /^Filters/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const panelId = toggle.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId as string)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', panelId);
    expect(document.getElementById(panelId as string)).toBeInTheDocument();
  });

  it('focus goes to the Status field on open', () => {
    renderFilters();
    openPanel();
    expect(document.activeElement).toBe(screen.getByLabelText('Status'));
  });

  it('Escape closes the panel and returns focus to the toggle', () => {
    renderFilters();
    const toggle = screen.getByRole('button', { name: /^Filters/ });
    openPanel();
    const status = screen.getByLabelText('Status');
    expect(status).toBeInTheDocument();

    // Escape from inside the panel (where focus already sits, on Status).
    fireEvent.keyDown(status, { key: 'Escape' });
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(toggle);
  });

  it('Escape scoped to the panel does not reach a row menu open elsewhere on the page', () => {
    render(
      <div>
        <PhoneStudyFilters {...baseProps} />
        <div role="menu" data-testid="row-menu">
          <button type="button" role="menuitem">Edit</button>
        </div>
      </div>
    );
    openPanel();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();

    // Escape fired with the row menu as the target, not the filters panel or
    // its toggle - PhoneStudyFilters must not react to it.
    fireEvent.keyDown(screen.getByTestId('row-menu'), { key: 'Escape' });
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('the badge is absent with no active filters and default sort', () => {
    renderFilters({ statusFilter: '', typeFilter: '', sortIsDefault: true });
    const toggle = screen.getByRole('button', { name: /^Filters/ });
    expect(within(toggle).queryByText(/^\d+$/)).not.toBeInTheDocument();
  });

  it('the badge counts Status, Study Type and a non-default sort independently', () => {
    const { rerender } = render(<PhoneStudyFilters {...baseProps} statusFilter="published" />);
    let toggle = screen.getByRole('button', { name: /^Filters/ });
    expect(within(toggle).getByText('1')).toBeInTheDocument();

    rerender(<PhoneStudyFilters {...baseProps} statusFilter="published" typeFilter="interview" />);
    toggle = screen.getByRole('button', { name: /^Filters/ });
    expect(within(toggle).getByText('2')).toBeInTheDocument();

    rerender(
      <PhoneStudyFilters
        {...baseProps}
        statusFilter="published"
        typeFilter="interview"
        sortIsDefault={false}
      />
    );
    toggle = screen.getByRole('button', { name: /^Filters/ });
    expect(within(toggle).getByText('3')).toBeInTheDocument();
  });

  it('a non-default sort counts toward the badge only while sort is shown', () => {
    renderFilters({ showSort: false, sortIsDefault: false });
    const toggle = screen.getByRole('button', { name: /^Filters/ });
    expect(within(toggle).queryByText(/^\d+$/)).not.toBeInTheDocument();
  });

  it('does not render the Sort by field when showSort is false', () => {
    renderFilters({ showSort: false });
    openPanel();
    expect(screen.queryByLabelText('Sort by')).not.toBeInTheDocument();
  });

  it('shows the total idle and "shown of total" with Clear while a filter is active, in one always-mounted role="status" slot', () => {
    const { rerender } = render(<PhoneStudyFilters {...baseProps} hasActiveFilters={false} />);
    const status = document.querySelector('.admin-result-count') as HTMLElement;
    expect(status).toBeInTheDocument();
    // LOW-2: the slot is a live region by role, not merely by class name -
    // an announcement depends on this attribute, not on `.admin-result-count`.
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent(/^6 studies$/);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();

    rerender(<PhoneStudyFilters {...baseProps} hasActiveFilters resultShown={4} resultTotal={6} />);
    expect(status).toHaveTextContent('4 of 6 studies');
    expect(document.querySelector('.admin-result-count')).toBe(status);
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('LOW-3: the idle count carries tabIndex=-1, as the desktop count does, and receives focus programmatically - the fallback focusStudy relies on', () => {
    renderFilters({ hasActiveFilters: false });
    const status = document.querySelector('.admin-result-count') as HTMLElement;
    // A plain <span> is not focusable at all without an explicit tabindex -
    // `focusStudy`'s fallback calls `.focus()` on this exact element when no
    // row is on screen, so a missing/negative-gated tabIndex here means that
    // fallback silently lands nowhere on a real browser.
    expect(status).toHaveAttribute('tabindex', '-1');
    status.focus();
    expect(document.activeElement, 'the fallback can actually move focus here').toBe(status);
  });

  it('calls onToggleQuickFilter with the chip key, and disables a zero-count chip unless it is active', () => {
    const onToggleQuickFilter = vi.fn();
    renderFilters({ onToggleQuickFilter, quickFilter: 'draft' });
    const draftChip = screen.getByRole('button', { name: /Draft/ });
    // count 0, but currently active - must stay enabled so it can be toggled off.
    expect(draftChip).toBeEnabled();
    fireEvent.click(draftChip);
    expect(onToggleQuickFilter).toHaveBeenCalledWith('draft');

    const fullyBooked = screen.getByRole('button', { name: /Fully booked/ });
    expect(fullyBooked).toBeDisabled();
  });
});
