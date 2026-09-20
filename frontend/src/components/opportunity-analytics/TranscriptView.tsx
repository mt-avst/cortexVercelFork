import React, { useEffect, useState } from 'react';
import { parseVtt, VttCue } from '@shared/firsthand/vtt-parser';

/**
 * Inline transcript rendering for an ingested transcript artefact (#79 step 4).
 *
 * Fetches the transcript's text through the SAME gated media route the player
 * uses (credentials included, URL minted by the api client), parses it as
 * WebVTT, and renders cues with their timestamps. On any parse miss - a plain
 * .txt transcript, or a VTT this minimal reader cannot cue - it falls back to
 * the raw text preformatted, because a transcript that will not parse is still
 * worth reading and the refusal, if any, already happened at mime validation.
 *
 * State is LOCAL, unlike the upload flow's: a fetch lost to the page's
 * refetch-unmount just re-runs on the next mount, with no data destroyed. The
 * component fetches only when mounted (the row expands it on demand), so a long
 * roster issues no transcript request until one is opened.
 *
 * Cue-click-to-seek is deliberately out of scope (plan F26): it needs a live
 * handle on the sibling <video>, and the panels render independently.
 */

interface TranscriptViewProps {
  /** The gated media URL for this transcript artefact, api-client-minted. */
  mediaUrl: string;
}

/** mm:ss (or h:mm:ss past an hour) for a cue label - seconds, not wall clock. */
export function formatCueTime(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'cues'; cues: VttCue[] }
  | { status: 'raw'; text: string };

const TranscriptView: React.FC<TranscriptViewProps> = ({ mediaUrl }) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    (async () => {
      try {
        const response = await fetch(mediaUrl, { credentials: 'include' });
        if (!response.ok) {
          // The route's refusals are display sentences (the ETag tripwire,
          // a gate) - surface what it said, not a translation.
          const data = (await response.json().catch(() => null)) as
            | { error?: unknown }
            | null;
          if (!cancelled) {
            setState({
              status: 'error',
              message:
                typeof data?.error === 'string' && data.error
                  ? data.error
                  : 'Could not load this transcript.'
            });
          }
          return;
        }

        const text = await response.text();
        if (cancelled) {
          return;
        }
        const cues = parseVtt(text);
        setState(
          cues.length > 0
            ? { status: 'cues', cues }
            : { status: 'raw', text }
        );
      } catch {
        if (!cancelled) {
          setState({ status: 'error', message: 'Could not load this transcript.' });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mediaUrl]);

  if (state.status === 'loading') {
    return (
      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px' }}>
        Loading transcript...
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <p role="alert" style={{ fontSize: '0.8rem', color: 'var(--status-danger-text)', marginTop: '8px' }}>
        {state.message}
      </p>
    );
  }

  if (state.status === 'raw') {
    return (
      <pre
        style={{
          marginTop: '8px',
          maxHeight: '360px',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          fontSize: '0.8rem',
          fontFamily: 'inherit',
          padding: '12px',
          borderRadius: '4px',
          background: 'var(--surface-panel-current)'
        }}
      >
        {state.text}
      </pre>
    );
  }

  return (
    <ol
      style={{
        listStyle: 'none',
        margin: '8px 0 0',
        padding: '4px 0',
        maxHeight: '360px',
        overflowY: 'auto'
      }}
    >
      {state.cues.map((cue, index) => (
        <li
          key={`${cue.startSeconds}-${index}`}
          style={{
            display: 'flex',
            gap: '10px',
            padding: '6px 0',
            borderBottom: '1px solid var(--border-subtle-current)'
          }}
        >
          <span
            style={{
              flex: '0 0 auto',
              minWidth: '3.5rem',
              color: 'var(--text-muted)',
              fontSize: '0.7rem',
              fontVariantNumeric: 'tabular-nums',
              paddingTop: '2px'
            }}
          >
            {formatCueTime(cue.startSeconds)}
          </span>
          <span style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>{cue.text}</span>
        </li>
      ))}
    </ol>
  );
};

export default TranscriptView;
