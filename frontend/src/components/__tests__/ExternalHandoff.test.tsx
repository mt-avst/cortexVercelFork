import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { ExternalHandoff, ExternalDestinationNote } from '../ExternalHandoff';

// DT-8: the detail-page external hand-off opened a poll/survey/study with a
// generic "Participate" and never named where it went, while the other two
// hand-offs (recording task page, bookings meeting link) already name their
// destination. This is the shared pattern: it names the host and says you are
// leaving Cortex, keeping the safe new-tab attributes.

describe('ExternalHandoff', () => {
  it('names the destination host and discloses leaving Cortex', () => {
    render(<ExternalHandoff url="https://forms.example.com/survey?token=secret" actionLabel="Open Survey" />);

    const link = screen.getByRole('link', { name: /Open Survey/i });
    expect(link).toHaveAttribute('href', 'https://forms.example.com/survey?token=secret');
    // The host, not the token-laden full URL.
    expect(screen.getByText(/forms\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/leaving Cortex/i)).toBeInTheDocument();
    // The token must never be printed as visible copy.
    expect(document.body.textContent).not.toContain('secret');
  });

  it('keeps the safe new-tab attributes', () => {
    render(<ExternalHandoff url="https://poll.example.org/p" actionLabel="Open Poll" />);
    const link = screen.getByRole('link', { name: /Open Poll/i });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('refuses a non-external (relative) URL, which is not a publishable web address', () => {
    // A relative path is not an external hand-off; the safety guard rejects it
    // to the inert control, so it never renders as a link.
    render(<ExternalHandoff url="/local/thing" actionLabel="Open" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect((screen.getByRole('button', { name: /Open/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('ExternalDestinationNote stays neutral when a target has no showable host', () => {
    // Defensive: a relative/unparseable target resolves to Cortex's own origin,
    // so naming a host would mislead. The note is used standalone beneath the
    // window.open button, so its own fallback is pinned here.
    render(<ExternalDestinationNote url="/local/thing" />);
    expect(screen.getByText(/the external site/i)).toBeInTheDocument();
  });

  it('uses a provided aria-label verbatim when given', () => {
    render(<ExternalHandoff url="https://x.example.com" actionLabel="Participate" ariaLabel="Participate in new tab" />);
    expect(screen.getByRole('link', { name: 'Participate in new tab' })).toBeInTheDocument();
  });

  it('degrades to an inert control for an unsafe scheme, rendering no link (defence in depth)', () => {
    // The safety property travels with the component: a caller that forgot to
    // gate an executable-scheme URL gets a disabled button, never an anchor
    // that could run it.
    render(<ExternalHandoff url="javascript:alert(document.domain)" actionLabel="Open" />);
    expect(screen.queryByRole('link')).toBeNull();
    const button = screen.getByRole('button', { name: /Open/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // The scheme must not reach any href.
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
