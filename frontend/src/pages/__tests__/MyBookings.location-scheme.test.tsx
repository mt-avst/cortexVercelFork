import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import MyBookings from '../MyBookings';
import { getMyBookings } from '../../api/client';

/**
 * A session location must never become an executable link.
 *
 * `session_location` had NO validation on the way in, and this page decided
 * whether to render it as an `href` with a SUBSTRING test:
 *
 *   str.includes('meet.google.com') || str.includes('zoom.us') || ...
 *
 * so `javascript:alert(document.cookie)//meet.google.com` satisfied it - the
 * `//` turns the allowlisted host into a JavaScript comment - and rendered as a
 * link labelled "Join via Google Meet". A researcher sets it once on a session;
 * every participant who booked it sees the button. Found by the security gate on
 * the external-link fix: the same defect class, one field over.
 *
 * These fixtures describe a booking as the API HANDS IT BACK, which is the
 * state this page must cope with - not a request the validator would now refuse.
 * Hardening the write path says nothing about rows already stored, which is why
 * the render has to decline as well.
 */

const booking = (session_location: string) => ({
  id: 'bk-1',
  status: 'booked',
  opportunity_id: 'opp-1',
  opportunity_title: 'A session with a location',
  opportunity_purpose: 'Checking what the location renders as',
  opportunity_type: 'test',
  session_start_time: '2030-08-18T20:00:00.000Z',
  session_end_time: '2030-08-18T20:45:00.000Z',
  session_location,
  owner_name: 'Test Admin',
  completion_status: 'pending'
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'employee', name: 'E' }, loading: false })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/SlowNeuralBackground', () => ({ default: () => null }));
vi.mock('../../api/client', () => ({
  getMyBookings: vi.fn(),
  cancelBooking: vi.fn(),
  rescheduleBooking: vi.fn(),
  getMySessionEvents: vi.fn(async () => [])
}));

const renderWith = (location: string) => {
  vi.mocked(getMyBookings).mockResolvedValue({
    upcoming: [booking(location)],
    past: []
  } as never);
  return render(<MemoryRouter><MyBookings /></MemoryRouter>);
};

const dangerousHrefs = () =>
  Array.from(document.querySelectorAll('[href]'))
    .map((element) => element.getAttribute('href') ?? '')
    .filter((href) => /^(javascript|data|vbscript):/i.test(href));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a session location that is not a web address', () => {
  it.each([
    ['javascript hiding behind an allowlisted host', 'javascript:alert(document.cookie)//meet.google.com'],
    ['javascript hiding behind a comment', 'javascript:alert(1)/*teams.microsoft.com*/'],
    ['data with a trusted host in the fragment', 'data:text/html,<script>alert(1)</script>#meet.google.com'],
    ['plain javascript', 'javascript:alert(1)']
  ])('is never rendered as a link - %s', async (_why, location) => {
    renderWith(location);
    await screen.findByText(/A session with a location/);

    expect(dangerousHrefs()).toEqual([]);
    /*
     * And it is not labelled as a joining link either. The label came from the
     * same substring test, so a value that dodged the href check could still
     * have been announced as "Join via Google Meet" - which is the part that
     * makes a participant press it.
     */
    expect(screen.queryByText(/Join via/i)).not.toBeInTheDocument();
  });

  it('shows it as plain text instead, so the information is not lost', async () => {
    // Not silently dropped: the author put something there, and a participant
    // seeing an odd string is better served than one shown nothing.
    renderWith('javascript:alert(1)');
    await screen.findByText(/A session with a location/);

    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
  });

  it.each([
    ['a real Google Meet link', 'https://meet.google.com/abc-defg-hij', 'Join via Google Meet'],
    ['a real Zoom link', 'https://zoom.us/j/123456', 'Join via Zoom'],
    ['a real Teams link', 'https://teams.microsoft.com/l/meetup/x', 'Join via Teams'],
    ['some other https link', 'https://example.com/room', 'Join Meeting']
  ])('still links %s, labelled correctly', async (_why, location, label) => {
    /*
     * The satisfied twin. Without it, everything above would pass against a
     * page that had stopped rendering joining links at all - which is the whole
     * feature.
     */
    renderWith(location);
    await screen.findByText(/A session with a location/);

    const link = screen.getByRole('link', { name: new RegExp(label, 'i') });
    expect(link).toHaveAttribute('href', location);
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('does not label a stranger as a trusted platform', async () => {
    /*
     * The label was `url.includes('meet.google.com')`, which matched anywhere in
     * the string - so this URL was announced as "Join via Google Meet". A
     * phishing label the app printed itself. The host is the only part of a URL
     * that says where it goes.
     */
    renderWith('https://evil.example.com/?next=meet.google.com');
    await screen.findByText(/A session with a location/);

    expect(screen.queryByText(/Join via Google Meet/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Join Meeting/i })
    ).toHaveAttribute('href', 'https://evil.example.com/?next=meet.google.com');
  });

  it('renders a plain room as text, with no link at all', async () => {
    renderWith('Room 3B');
    await screen.findByText(/A session with a location/);

    expect(screen.getByText('Room 3B')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /join/i })).not.toBeInTheDocument();
  });
});
