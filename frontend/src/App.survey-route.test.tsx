import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import App from './App';

/**
 * Fix-first row 22 (second-pass review).
 *
 * `/survey/:token` used to render inside AppChromeLayout - the standard
 * header, nav and FeedbackFooter around every ordinary page. The recording
 * session (`/session/:token`) already gets a chrome-less, full-page layout
 * for the same reason a participant mid-task should not be handed a one-click
 * exit or an unrelated feedback form; the survey/poll runner never got the
 * same treatment.
 *
 * `/feedback` has its own form and does not need the footer's second one
 * stacked underneath it.
 */

vi.mock('./pages/Home', () => ({
  default: () => <div>Home page</div>,
}));

vi.mock('./pages/SurveySession', () => ({
  default: () => <div>Survey runner stub</div>,
}));

vi.mock('./pages/Feedback', () => ({
  default: () => (
    <form aria-label="Feedback page form">
      <button type="submit">Send</button>
    </form>
  ),
}));

vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ user: null, loading: false, initialAuthCheck: false, logout: vi.fn() }),
}));

vi.mock('./contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ isDarkMode: false, theme: 'light', toggleTheme: vi.fn() }),
  useAnimation: () => ({ prefersReducedMotion: false }),
}));

const go = (path: string) => {
  window.history.pushState({}, '', path);
  render(<App />);
};

describe('row 22: survey runner and feedback page layout', () => {
  it('renders /survey/:token with no header and no feedback footer form', async () => {
    go('/survey/fh_tok_abc');

    await screen.findByText('Survey runner stub');
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByLabelText(/how we can improve cortex/i)).toBeNull();
  });

  it('renders /feedback with exactly one form - its own, not the footer’s', async () => {
    go('/feedback');

    await screen.findByRole('form', { name: /feedback page form/i });
    expect(screen.getAllByRole('form')).toHaveLength(1);
    expect(screen.queryByLabelText(/how we can improve cortex/i)).toBeNull();
  });

  it('still shows the feedback footer on the home page', async () => {
    go('/');

    await screen.findByText('Home page');
    expect(screen.getByLabelText(/how we can improve cortex/i)).toBeInTheDocument();
  });
});
