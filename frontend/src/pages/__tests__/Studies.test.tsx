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
