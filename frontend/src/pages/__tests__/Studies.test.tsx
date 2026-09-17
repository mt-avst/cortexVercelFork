import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Studies from '../Studies';
import { getFirstHandStudies } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';

// The page is admin-gated via AuthContext and lists via the shared API client.
// Stub both so no real HTTP is attempted and the guard resolves deterministically.
//
// This file merges two suites written independently on different branches: the
// Task List vocabulary tests (MR !94) and the ownership affordance tests
// (MR !95). Both landed as new files, so the rebase had to pick or combine -
// they pin different behaviour, so both stay.
vi.mock('../../api/client', () => ({ getFirstHandStudies: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: vi.fn() }));

const mockedList = vi.mocked(getFirstHandStudies);
const mockedUseAuth = vi.mocked(useAuth) as unknown as ReturnType<typeof vi.fn>;

const study = (overrides: Record<string, unknown> = {}) => ({
  id: 'study_abc',
  title: 'Checkout walkthrough',
  intro_text: 'Thanks for helping',
  consent_text: 'Consent',
  status: 'launched' as const,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue([] as never);
  mockedUseAuth.mockReturnValue({
    user: { id: 'user-viewer', role: 'researcher_admin' },
    loading: false,
  });
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <Studies />
    </MemoryRouter>
  );

// ---------------------------------------------------------------------------
// Vocabulary. This page carries the Task List rename's most load-bearing copy
// and previously had no test at all. "Task list" names the authored script
// object; the OPPORTUNITY keeps the word "study" elsewhere in the admin UI,
// which is the distinction these assertions exist to hold.
// ---------------------------------------------------------------------------
describe('Studies page - task list vocabulary', () => {
  it('is titled Task Lists and offers creating one', async () => {
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Task Lists' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'New Task List' })
    ).toBeInTheDocument();
    // The old name must be gone, or a half-done rename reads as a pass.
    expect(screen.queryByRole('heading', { name: 'Studies' })).toBeNull();
  });

  it('names task lists in the empty state', async () => {
    renderPage();

    expect(
      await screen.findByText(/No task lists yet\./i)
    ).toBeInTheDocument();
  });

  it('names task lists in the load error', async () => {
    mockedList.mockRejectedValueOnce(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load task lists.')
    ).toBeInTheDocument();
  });

  it('lists an existing task list by title', async () => {
    mockedList.mockResolvedValueOnce([
      study({ owner_user_id: 'user-viewer' }),
    ] as never);

    renderPage();

    expect(await screen.findByText('Checkout walkthrough')).toBeInTheDocument();
    // The edit link is the only route into the editor from here.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
        'href',
        '/admin/studies/study_abc/edit'
      )
    );
  });
});

describe('Studies page - status label, vocabulary and dates (Lane C "Then")', () => {
  it('shows a launched task list as Published, not the raw enum "launched"', async () => {
    mockedList.mockResolvedValue([
      study({ status: 'launched', owner_user_id: 'user-viewer' }),
    ] as never);

    renderPage();

    const row = (await screen.findByText('Checkout walkthrough')).closest('li');
    expect(row).not.toBeNull();
    expect(row!.textContent).toMatch(/Published/);
    expect(row!.textContent).not.toMatch(/launched/i);
  });

  it('shows a draft task list as Draft', async () => {
    mockedList.mockResolvedValue([
      study({ status: 'draft', owner_user_id: 'user-viewer' }),
    ] as never);

    renderPage();

    const row = (await screen.findByText('Checkout walkthrough')).closest('li');
    expect(row!.textContent).toMatch(/Draft/);
  });

  it('describes a task list in study vocabulary, not "opportunity"', async () => {
    renderPage();

    await screen.findByRole('heading', { name: 'Task Lists' });
    expect(
      screen.getByText(/An unmoderated study references a task list by id/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/unmoderated opportunity/i)).toBeNull();
  });

  it('formats the updated date in en-GB, not the US default', async () => {
    mockedList.mockResolvedValue([
      study({ updated_at: '2026-08-18T09:15:30.123Z', owner_user_id: 'user-viewer' }),
    ] as never);

    renderPage();

    const row = (await screen.findByText('Checkout walkthrough')).closest('li');
    expect(row!.textContent).toMatch(/Updated .*18 Aug 2026/);
    // The US m/d/yyyy shape the default toLocaleString produced must be gone.
    expect(row!.textContent).not.toMatch(/8\/18\/2026/);
  });
});

// ---------------------------------------------------------------------------
// Ownership affordance. The list shows every task list, including other
// researchers' - reuse across owners is a designed feature. What it must not
// do is offer "Edit" on one the viewer cannot save, which walks them into a
// form that refuses the save.
// ---------------------------------------------------------------------------
describe('Studies list ownership affordance', () => {
  it('offers Edit on your own task list', async () => {
    mockedList.mockResolvedValue([
      study({ owner_user_id: 'user-viewer' }),
    ] as never);

    renderPage();

    expect(await screen.findByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(
      screen.queryByText('Owned by another researcher')
    ).not.toBeInTheDocument();
  });

  it('offers View, and says why, on a task list owned elsewhere', async () => {
    mockedList.mockResolvedValue([
      study({ owner_user_id: 'user-owner' }),
    ] as never);

    renderPage();

    expect(await screen.findByRole('link', { name: 'View' })).toBeInTheDocument();
    expect(screen.getByText('Owned by another researcher')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('offers Edit on an unowned legacy task list, which the API still accepts', async () => {
    mockedList.mockResolvedValue([study({ owner_user_id: null })] as never);

    renderPage();

    expect(await screen.findByRole('link', { name: 'Edit' })).toBeInTheDocument();
  });

  it('offers Edit on anything to a superadmin', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-super', role: 'superadmin' },
      loading: false,
    });
    mockedList.mockResolvedValue([
      study({ owner_user_id: 'user-owner' }),
    ] as never);

    renderPage();

    expect(await screen.findByRole('link', { name: 'Edit' })).toBeInTheDocument();
  });
});

/**
 * Row 35: a bare page (no card) where every wizard screen sits inside one,
 * and a plain uppercase status label where the opportunity form uses a pill
 * (`StatusBadge`).
 */
describe('Studies page - shell parity (row 35)', () => {
  it('wraps the page content in a card, like every wizard screen', async () => {
    renderPage();

    const heading = await screen.findByRole('heading', { name: 'Task Lists' });
    expect(heading.closest('.card')).not.toBeNull();
  });

  it('shows a launched task list\'s status as a pill, not plain text', async () => {
    mockedList.mockResolvedValue([
      study({ status: 'launched', owner_user_id: 'user-viewer' }),
    ] as never);

    renderPage();

    await screen.findByText('Checkout walkthrough');
    expect(screen.getByText('Published').className).toMatch(/rounded-full/);
  });
});

/**
 * Which studies are NOT on approved consent wording, at a glance.
 *
 * The chip's own unit tests cover when it renders; this covers that the LIST
 * renders it at all. An independent mutation pass deleted it from both call
 * sites and neither deletion failed a single test - the component was proven
 * and its use was not.
 */
describe('Studies - consent state', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-1', role: 'researcher_admin' },
      loading: false
    });
  });

  it('flags the studies running on custom consent, and only those', async () => {
    mockedList.mockResolvedValue([
      study({ id: 'study_ok', title: 'On the template', consent_template_id: 'recorded-default' }),
      study({ id: 'study_custom', title: 'Rewritten', consent_template_id: 'custom' })
    ] as never);

    render(
      <MemoryRouter>
        <Studies />
      </MemoryRouter>
    );

    await screen.findByText('Rewritten');

    // One chip, not two and not none - a list that flagged everything says as
    // little as one that flagged nothing.
    const chips = screen.getAllByTestId('consent-state-chip');
    expect(chips).toHaveLength(1);

    // And it is on the RIGHT row. With two rows carrying different states, a
    // chip rendered against the wrong one is otherwise undetectable.
    const row = screen.getByText('Rewritten').closest('li');
    expect(row).not.toBeNull();
    expect(row!.querySelector('[data-testid="consent-state-chip"]')).not.toBeNull();
  });
});
