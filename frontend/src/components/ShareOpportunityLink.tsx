import React, { useEffect, useId, useRef, useState } from 'react';

import { Button } from './ui';
import type { Opportunity, User } from '@shared/types';

type CopyState = 'idle' | 'copied' | 'failed';

/** How long a copy confirmation stays on screen before clearing itself. */
const FEEDBACK_MS = 4000;

/**
 * `writeText` can stay pending indefinitely when the document is not focused or
 * a permission prompt is open, which would leave the admin with a button that
 * did nothing and no message at all. Bounded so it always resolves one way.
 */
const CLIPBOARD_TIMEOUT_MS = 2000;

type ShareOpportunityLinkProps = {
  opportunityId: string;
  /** Typed, not `string`: a loose prop let a role that does not exist into the tests. */
  status: Opportunity['status'];
  /** The viewer's role. Only the two admin roles ever see this block. */
  role?: User['role'];
  /**
   * Whether a participant could actually start. Mirrors the CTA's own disabled
   * rule on the host page: `!firsthand_study_id && !external_link_optional`.
   */
  startable?: boolean;
};

/**
 * The participant-facing URL for an opportunity, surfaced to admins.
 *
 * How a researcher gets participants into a study was previously implicit: an
 * admin could send `/opportunities/:id` by hand, but nothing in the UI said so
 * or offered it. This makes it explicit.
 *
 * There is deliberately NO task-list-level link. The OPPORTUNITY is the
 * shareable unit - participants browse published opportunities, open one, and
 * start from there - so this is the only URL worth handing out.
 */
export function ShareOpportunityLink({
  opportunityId,
  status,
  role,
  startable = true,
}: ShareOpportunityLinkProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const urlRef = useRef<HTMLAnchorElement>(null);
  const headingId = useId();

  // Clear a confirmation after a few seconds so a stale "Link copied" does not
  // sit on screen for the rest of the session. Failures persist: they carry an
  // instruction the admin still has to act on.
  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = setTimeout(() => setCopyState('idle'), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copyState]);

  const isAdmin = role === 'researcher_admin' || role === 'superadmin';

  // An ALLOWLIST, deliberately. A denylist of draft/closed would start sharing
  // any status added later without anyone deciding that it should.
  if (!isAdmin || status !== 'published') {
    return null;
  }

  // Built from the browser's own origin rather than the backend's FRONTEND_URL,
  // so the copied link always points at the host the admin is actually using -
  // an admin on localhost wanting a localhost link is correct behaviour. Note
  // FRONTEND_URL is the canonical public origin and is the deliberate
  // alternative here, not an oversight: do not "fix" this to use it.
  const shareUrl = `${window.location.origin}/opportunities/${encodeURIComponent(
    opportunityId
  )}`;

  const handleCopy = async () => {
    // Reset first, so a second copy re-announces. Without this the live region
    // does not mutate and a screen reader user hears nothing the second time.
    setCopyState('idle');

    try {
      // `navigator.clipboard` is secure-context only, exactly like
      // `crypto.randomUUID`, so it is absent over plain http. Failing here is
      // not a dead end: the URL is rendered in full above, so the fallback is
      // to select it for the admin to copy by hand.
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable');
      }

      await Promise.race([
        navigator.clipboard.writeText(shareUrl),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Clipboard timed out')),
            CLIPBOARD_TIMEOUT_MS
          )
        ),
      ]);

      setCopyState('copied');
    } catch {
      setCopyState('failed');
      const node = urlRef.current;
      if (node && typeof window.getSelection === 'function') {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  };

  return (
    <section className="card mb-4" aria-labelledby={headingId}>
      <div className="card-body">
        <h2 className="h6 mb-2" id={headingId}>
          Share this study
        </h2>
        <p className="text-muted mb-3" style={{ fontSize: '0.875rem' }}>
          Participants open this link, sign in, and start from here. They need a
          Cortex account, so it will not work for anyone outside the
          organisation.
        </p>

        <div className="d-flex align-items-center gap-2 flex-wrap">
          {/*
            An anchor, not a bare <code>: it is keyboard-focusable, so an admin
            who cannot use a mouse can still act on the fallback instruction
            below, and it can be opened to check the link resolves.

            The layout is set inline because this app has NO Bootstrap - the
            `flex-grow-1` and `text-break` utilities do not exist in any
            stylesheet here, so relying on them left the URL neither growing nor
            wrapping. `minWidth: 0` is what actually lets a flex item shrink
            below its content, and `overflowWrap: anywhere` is what breaks a URL
            with no hyphens in it. A UUID happens to break at its own hyphens,
            which is exactly why eyeballing one is not evidence that wrapping
            works.
          */}
          <a
            href={shareUrl}
            ref={urlRef}
            rel="noopener noreferrer"
            style={{
              flexGrow: 1,
              minWidth: 0,
              overflowWrap: 'anywhere',
              fontFamily: 'var(--font-family-mono)',
              fontSize: '0.875rem',
            }}
            target="_blank"
          >
            {shareUrl}
          </a>
          <Button onClick={handleCopy} size="sm" type="button" variant="secondary">
            Copy link
          </Button>
        </div>

        {!startable ? (
          <p className="text-danger mb-0 mt-2" style={{ fontSize: '0.875rem' }}>
            Participants cannot start this yet, so the button on this page is
            disabled. Add a session, a task list or a link before sharing,
            depending on the study type.
          </p>
        ) : null}

        {/* Announced rather than only shown, since the button's own label does
            not change and a silent copy gives no feedback at all. */}
        <p aria-live="polite" className="mb-0 mt-2" style={{ fontSize: '0.875rem' }}>
          {copyState === 'copied' ? (
            <span className="text-success">Link copied</span>
          ) : copyState === 'failed' ? (
            <span className="text-danger">
              Could not copy automatically. The link is selected above, so copy
              it by hand.
            </span>
          ) : null}
        </p>
      </div>
    </section>
  );
}

export default ShareOpportunityLink;
