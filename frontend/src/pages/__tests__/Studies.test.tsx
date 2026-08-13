import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Studies from '../Studies';
import { getFirstHandStudies } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';

// The page is admin-gated via AuthContext and lists via the shared API client.
// Stub both so no real HTTP is attempted and the guard resolves deterministically.
vi.mock('../../api/client', () => ({
  getFirstHandStudies: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const mockedList = vi.mocked(getFirstHandStudies);
const mockedAuth = vi.mocked(useAuth);

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue([]);
  mockedAuth.mockReturnValue({
    user: { id: 'u1', role: 'superadmin' },
    loading: false,
  } as ReturnType<typeof useAuth>);
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <Studies />
    </MemoryRouter>
  );

// ---------------------------------------------------------------------------
// This page carries the rename's most load-bearing copy and had no test at all,
// so every string below was previously pinned by nothing. "Task list" names the
// authored script object; the OPPORTUNITY keeps the word "study" elsewhere in
// the admin UI, which is the distinction these assertions exist to hold.
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
      {
        id: 'study_abc',
        title: 'Checkout walkthrough',
        intro_text: 'Thanks for helping',
        status: 'launched',
      },
    ] as Awaited<ReturnType<typeof getFirstHandStudies>>);

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
