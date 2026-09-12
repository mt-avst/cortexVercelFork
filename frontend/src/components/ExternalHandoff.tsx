import React from 'react';
import { ExternalLink } from 'lucide-react';
import { isPublishableExternalLink } from '@shared/firsthand/url-safety';
import { describeTarget } from '../lib/recording/task-target';

/**
 * The one pattern for an external hand-off (DT-8).
 *
 * Cortex hands a participant off to a third-party page in a few places, and
 * they disclosed the destination three different ways - one of them not at all
 * (the detail-page hand-offs never named their host). This is the shared
 * element: a primary call to action that NAMES the destination host and says
 * plainly that the participant is leaving Cortex, keeping the safe new-tab
 * attributes (`target="_blank"` + `rel="noopener noreferrer"`).
 *
 * It shows the HOST, never the raw URL - external links are long and often
 * carry query tokens, and the host is the part that says where a click goes
 * (the same reasoning `describeTarget` and the bookings meeting-link label
 * already follow).
 *
 * The URL's safety is re-checked HERE, not only at the call site. This is a
 * reusable component named to invite reuse, so the safety property travels
 * with it: `isPublishableExternalLink` rejects anything but an http(s) address,
 * and an unsafe or missing URL degrades to an inert control rather than
 * rendering an executable-scheme link into this app's origin (React does not
 * block `javascript:`/`data:` in an href, it only warns).
 */
interface ExternalHandoffProps {
  /** The external URL. Re-validated here as well as at the call site. */
  url: string;
  /** Visible call-to-action text, e.g. "Open Poll", "Participate". */
  actionLabel: string;
  /** Overrides the composed accessible name when a specific one is needed. */
  ariaLabel?: string;
  /** Fired on click, e.g. for engagement tracking. */
  onOpen?: () => void;
  /** Overrides the default primary-button styling. */
  className?: string;
}

/**
 * The destination disclosure line, on its own so a hand-off that is a `<button>`
 * with its own launch logic (window.open plus click tracking) can carry the
 * same "you are leaving Cortex" line as the anchor without being rebuilt as one.
 * Shows the host, or a neutral label for a relative/unparseable target (which
 * resolves to Cortex's own origin, so naming a host would mislead).
 */
export function ExternalDestinationNote({ url }: { url: string }) {
  const { host } = describeTarget(url);
  const destination = host ?? 'the external site';
  return (
    <p style={{ marginTop: '8px', marginBottom: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
      Opens {destination} in a new tab. You're leaving Cortex.
    </p>
  );
}

export function ExternalHandoff({ url, actionLabel, ariaLabel, onOpen, className }: ExternalHandoffProps) {
  if (!isPublishableExternalLink(url)) {
    // Defence in depth: a caller that forgot to gate the URL gets an inert
    // control, never an executable-scheme link.
    return (
      <button
        type="button"
        className={className ?? 'btn btn-secondary w-100 mission-cta-btn'}
        disabled
        aria-label={`${actionLabel} (link unavailable)`}
      >
        {actionLabel}
      </button>
    );
  }

  const { host } = describeTarget(url);
  const destination = host ?? 'the external site';

  return (
    <div className="external-handoff">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={className ?? 'btn btn-primary w-100 mission-cta-btn'}
        aria-label={ariaLabel ?? `${actionLabel} on ${destination}, opens in a new tab`}
        onClick={onOpen}
      >
        {actionLabel}
        <ExternalLink size={16} aria-hidden="true" style={{ marginLeft: '8px' }} />
      </a>
      <ExternalDestinationNote url={url} />
    </div>
  );
}

export default ExternalHandoff;
