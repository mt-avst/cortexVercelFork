import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import Settings from '../Settings';
import { getNotificationPreferences, updateNotificationPreferences } from '../../api/client';

// #146: handleToggle armed a bare setTimeout(() => setSuccess(false), 3000)
// with no clearTimeout anywhere. Under React 18 a setState after unmount is a
// silent no-op, but the timer itself keeps running - if it outlives the
// vitest file, that file can exit non-zero on `window is not defined`, the
// same failure mode !496 fixed on Admin.tsx.

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
vi.mock('../../components/AdminManagement', () => ({ default: () => null }));

const mockGetPrefs = vi.mocked(getNotificationPreferences);
const mockUpdatePrefs = vi.mocked(updateNotificationPreferences);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPrefs.mockResolvedValue({
    id: 'p1',
    user_id: 'r1',
    on_book_email: true,
    on_cancel_email: false,
  });
  mockUpdatePrefs.mockResolvedValue({
    id: 'p1',
    user_id: 'r1',
    on_book_email: false,
    on_cancel_email: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// Loads Settings under real timers (findBy's polling needs them), switches to
// Notifications and flips a toggle - this is what actually arms the
// success-banner timer. Fake timers only take over once the toggle is armed,
// so advanceTimersByTimeAsync can flush the update promise and the timer both.
const armTheBanner = async () => {
  const rendered = render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole('tab', { name: /Notification Preferences/i }));
  const toggle = await screen.findByRole('checkbox', { name: /Email on Booking/i });

  vi.useFakeTimers();
  fireEvent.click(toggle);
  await vi.advanceTimersByTimeAsync(0);

  return rendered;
};

describe('the notification-toggle success banner timer', () => {
  it('hides the success banner after 3000ms', async () => {
    await armTheBanner();

    expect(screen.getByText('Settings saved successfully!')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2999);
    expect(screen.getByText('Settings saved successfully!')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(1);
    expect(screen.queryByText('Settings saved successfully!')).not.toBeInTheDocument();
  });

  it('leaves no timer pending once Settings unmounts', async () => {
    const { unmount } = await armTheBanner();

    // Control: the banner really is on screen, so the timer is armed and not
    // merely never-scheduled - a bare getTimerCount() alone would not say that.
    expect(screen.getByText('Settings saved successfully!')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the way back (#169)', () => {
  it('names the researcher workspace Create & Manage', async () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );
    expect(await screen.findByRole('button', { name: /^Back to Create & Manage$/ })).toBeInTheDocument();
  });
});
