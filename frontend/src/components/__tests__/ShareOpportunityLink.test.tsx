import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ShareOpportunityLink } from '../ShareOpportunityLink';

const PUBLISHED = {
  opportunityId: 'ace182c9-dd1e-47ea-8952-c5a254d83a0f',
  status: 'published',
  role: 'researcher_admin',
};

/** Install a clipboard stub, since jsdom provides none. */
const stubClipboard = (writeText: () => Promise<void>) => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
    writable: true,
  });
  return navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
};

const removeClipboard = () => {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
    writable: true,
  });
};

afterEach(() => {
  removeClipboard();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Who sees it
//
// The block is admin-only and published-only. Both halves matter: a participant
// must never see internal sharing controls, and an admin must never be handed a
// link to a draft (unreachable) or a closed opportunity (no longer accepting
// anyone), because sending either points a colleague at a dead end.
// ---------------------------------------------------------------------------
describe('ShareOpportunityLink - visibility', () => {
  it('shows for an admin on a published opportunity', () => {
    render(<ShareOpportunityLink {...PUBLISHED} />);
    // `level` is asserted because a bare heading query lets h2 -> h5 through,
    // and the page h1 renders directly above this block.
    expect(
      screen.getByRole('heading', { level: 2, name: 'Share this study' })
    ).toBeInTheDocument();
    // Proves aria-labelledby actually resolves; a typo'd id would leave the
    // section unnamed and this query would find nothing.
    expect(
      screen.getByRole('region', { name: 'Share this study' })
    ).toBeInTheDocument();
  });

  it('shows for a superadmin too', () => {
    render(<ShareOpportunityLink {...PUBLISHED} role="superadmin" />);
    expect(
      screen.getByRole('heading', { name: 'Share this study' })
    ).toBeInTheDocument();
  });

  it('renders nothing for an employee', () => {
    // `employee` is the real non-admin role (`User['role']`). An earlier
    // version used "participant", which the app never issues - so a mutant
    // reading `!!role && role !== 'participant'` passed every test while
    // showing this block to every employee in the organisation.
    const { container } = render(
      <ShareOpportunityLink {...PUBLISHED} role="employee" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the viewer has no role at all', () => {
    const { container } = render(
      <ShareOpportunityLink {...PUBLISHED} role={undefined} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a draft opportunity', () => {
    const { container } = render(
      <ShareOpportunityLink {...PUBLISHED} status="draft" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a closed opportunity', () => {
    const { container } = render(
      <ShareOpportunityLink {...PUBLISHED} status="closed" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a status it does not know', () => {
    // Pins the check as an ALLOWLIST. A denylist of draft/closed would start
    // sharing any status added later without anyone deciding that it should.
    const { container } = render(
      <ShareOpportunityLink
        {...PUBLISHED}
        status={'archived' as typeof PUBLISHED.status}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------
// The URL itself
// ---------------------------------------------------------------------------
describe('ShareOpportunityLink - the link', () => {
  it('renders the absolute participant URL for the opportunity', () => {
    render(<ShareOpportunityLink {...PUBLISHED} />);
    expect(
      screen.getByText(
        `${window.location.origin}/opportunities/${PUBLISHED.opportunityId}`
      )
    ).toBeInTheDocument();
  });

  it('encodes an id that would otherwise steer the path', () => {
    render(<ShareOpportunityLink {...PUBLISHED} opportunityId="a/../b" />);
    expect(
      screen.getByText(`${window.location.origin}/opportunities/a%2F..%2Fb`)
    ).toBeInTheDocument();
  });

  it('lets the URL shrink inside its flex row', () => {
    // Found by measuring the rendered page, not by reading the code: without
    // `min-width: 0` a flex item keeps `min-width: auto`, refuses to shrink
    // below its content, and the URL pushed its own background 95px outside
    // the card at 320px wide. jsdom does no layout, so this pins the declaration
    // rather than the geometry - enough to stop it being tidied away.
    render(<ShareOpportunityLink {...PUBLISHED} />);
    const code = screen.getByText(
      `${window.location.origin}/opportunities/${PUBLISHED.opportunityId}`
    );
    // Asserted on the inline value, not via toHaveStyle: React serialises a
    // zero-valued length unitless, so the rendered declaration is `min-width: 0`
    // and a `'0px'` matcher silently never matches.
    expect((code as HTMLElement).style.minWidth).toBe('0');
  });

  it('says the link needs a Cortex account, so it is not sent to outsiders', () => {
    render(<ShareOpportunityLink {...PUBLISHED} />);
    expect(screen.getByText(/need a\s+Cortex account/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------
describe('ShareOpportunityLink - copy', () => {
  it('writes the URL to the clipboard and confirms', async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    render(<ShareOpportunityLink {...PUBLISHED} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/opportunities/${PUBLISHED.opportunityId}`
      )
    );
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
  });

  it('says nothing before the button is pressed', () => {
    stubClipboard(() => Promise.resolve());
    render(<ShareOpportunityLink {...PUBLISHED} />);
    expect(screen.queryByText('Link copied')).toBeNull();
  });

  it('falls back to a readable instruction when the clipboard is unavailable', async () => {
    // `navigator.clipboard` is secure-context only, so it is absent over plain
    // http - the same trap as `crypto.randomUUID`. The URL is on screen either
    // way, so this must degrade to "copy it yourself", never to silence.
    removeClipboard();
    render(<ShareOpportunityLink {...PUBLISHED} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(
      await screen.findByText(/Could not copy automatically/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('Link copied')).toBeNull();
    // The message PROMISES the link is selected. Without this assertion the
    // whole selection block could be deleted and the suite stayed green.
    expect(window.getSelection()?.toString()).toBe(`${window.location.origin}/opportunities/${PUBLISHED.opportunityId}`);
  });

  it('falls back the same way when the clipboard write is rejected', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    render(<ShareOpportunityLink {...PUBLISHED} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(
      await screen.findByText(/Could not copy automatically/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('Link copied')).toBeNull();
    expect(window.getSelection()?.toString()).toBe(`${window.location.origin}/opportunities/${PUBLISHED.opportunityId}`);
  });

  it('announces the outcome politely rather than only showing it', async () => {
    stubClipboard(() => Promise.resolve());
    const { container } = render(<ShareOpportunityLink {...PUBLISHED} />);

    // The button label does not change, so without a live region a screen
    // reader user gets no feedback that anything happened.
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(live).toHaveTextContent('Link copied'));
  });

  it('re-announces on a second copy rather than going silent', async () => {
    stubClipboard(() => Promise.resolve());
    const { container } = render(<ShareOpportunityLink {...PUBLISHED} />);
    const live = container.querySelector('[aria-live="polite"]')!;
    const button = screen.getByRole('button', { name: 'Copy link' });

    fireEvent.click(button);
    await waitFor(() => expect(live).toHaveTextContent('Link copied'));

    // Without resetting to idle first, the live region's content is unchanged
    // by the second copy, so it never mutates and nothing is announced.
    const mutations: number[] = [];
    const observer = new MutationObserver((records) =>
      mutations.push(records.length)
    );
    observer.observe(live, { childList: true, subtree: true, characterData: true });

    fireEvent.click(button);
    await waitFor(() => expect(mutations.length).toBeGreaterThan(0));
    observer.disconnect();

    await waitFor(() => expect(live).toHaveTextContent('Link copied'));
  });

  it('does not leave the admin waiting on a clipboard write that never settles', async () => {
    // Chrome and Safari can leave writeText pending when the document is not
    // focused or a permission prompt is open. Unbounded, that is a button that
    // did nothing and a live region that never speaks.
    vi.useFakeTimers();
    try {
      stubClipboard(() => new Promise(() => {}));
      render(<ShareOpportunityLink {...PUBLISHED} />);

      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
      await vi.advanceTimersByTimeAsync(2500);

      expect(screen.getByText(/Could not copy automatically/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a stale confirmation instead of leaving it on screen', async () => {
    vi.useFakeTimers();
    try {
      stubClipboard(() => Promise.resolve());
      render(<ShareOpportunityLink {...PUBLISHED} />);

      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
      await vi.advanceTimersByTimeAsync(10);
      expect(screen.getByText('Link copied')).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(5000);
      expect(screen.queryByText('Link copied')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Published, but nobody can start it
// ---------------------------------------------------------------------------
describe('ShareOpportunityLink - unstartable', () => {
  it('warns when participants cannot start it', () => {
    // Mirrors the CTA's own disabled rule on the host page. Sharing a link to a
    // page whose start button is dead is the exact dead end the published-only
    // gate exists to prevent, just arrived at a different way.
    //
    // The copy no longer names a task list as THE cause: a bookable study
    // starts by booking a slot, so "link a task list" was wrong advice for a
    // usability test with four open sessions.
    render(<ShareOpportunityLink {...PUBLISHED} startable={false} />);
    expect(
      screen.getByText(/Participants cannot start this yet/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/link a task list before sharing/i)).toBeNull();
  });

  it('says nothing when it is startable', () => {
    render(<ShareOpportunityLink {...PUBLISHED} startable />);
    expect(
      screen.queryByText(/Nothing is linked for participants to start yet/i)
    ).toBeNull();
  });
});
