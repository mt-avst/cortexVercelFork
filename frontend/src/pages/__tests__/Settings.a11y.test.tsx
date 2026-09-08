import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Settings from '../Settings';
import { getNotificationPreferences } from '../../api/client';

// Row 13: the notification switches were bare <input type="checkbox"> with an id
// and their visible label in a sibling <h6> - never associated - so a screen
// reader announced two unnamed checkboxes. This pins that each has an accessible
// name and that the loaded state is reflected.

vi.mock('../../api/client', () => ({
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'r1', role: 'researcher_admin', name: 'R', email: 'r@example.com' },
    loading: false,
    initialAuthCheck: true,
  }),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light' }),
}));

// The WebGL background is the jsdom blocker; AdminManagement fires its own fetch.
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
vi.mock('../../components/AdminManagement', () => ({ default: () => null }));

const mockGetPrefs = vi.mocked(getNotificationPreferences);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPrefs.mockResolvedValue({
    id: 'p1',
    user_id: 'r1',
    on_book_email: true,
    on_cancel_email: false,
  });
});

describe('Settings notification toggles accessibility (row 13)', () => {
  it('gives each notification toggle an accessible name and reflects its state', async () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );

    // The toggles live under the Notifications tab.
    fireEvent.click(await screen.findByRole('tab', { name: /Notification Preferences/i }));

    const bookToggle = await screen.findByRole('checkbox', { name: /Email on Booking/i });
    const cancelToggle = screen.getByRole('checkbox', { name: /Email on Cancellation/i });

    expect(bookToggle).toBeInTheDocument();
    expect(cancelToggle).toBeInTheDocument();
    expect(bookToggle).toBeChecked();
    expect(cancelToggle).not.toBeChecked();
  });
});
