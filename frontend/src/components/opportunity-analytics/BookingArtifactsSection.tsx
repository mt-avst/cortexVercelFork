import React, { useEffect, useRef, useState } from 'react';
import { BookingArtifact, OpportunityBookingRow } from '../../api/types';
import { bookingArtifactMediaUrl } from '../../api/client';
import { BookingArtifactsController } from './useBookingArtifacts';

/**
 * The artefacts of one booked session (#79 step 3): the researcher uploads
 * the call platform's own export (a recording, a transcript) after the call,
 * plays recordings back inline and deletes what should not be here. All state
 * lives in the controller the PAGE owns - this component can unmount at any
 * moment (the opportunity refetch spinner) without losing an upload.
 */

export interface BookingArtifactsSectionProps {
  booking: OpportunityBookingRow;
  controller: BookingArtifactsController;
}

/** 1536 → "1.5 KB"; the wire speaks bytes, a caption should not. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

export const PLAYBACK_FAILED_FALLBACK = 'Playback failed. Try again.';

const ArtifactRow: React.FC<{
  booking: OpportunityBookingRow;
  artifact: BookingArtifact;
  onDelete: () => void;
}> = ({ booking, artifact, onDelete }) => {
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState('');

  /**
   * The media route's refusals are display sentences - the ETag tripwire's
   * whole point is a NAMED failure - but a <video> swallows response bodies.
   * On error, probe the same URL and surface what the server actually said,
   * so a refused serve does not read as a mutely broken player.
   */
  const surfacePlaybackRefusal = async () => {
    const url = bookingArtifactMediaUrl(booking.id, artifact.id);
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (response.ok) {
        // The route serves fine - the element failed for a local reason
        // (codec, network blip). Stop the probe download and say so plainly.
        response.body?.cancel();
        setPlaybackError(PLAYBACK_FAILED_FALLBACK);
        return;
      }
      const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
      setPlaybackError(
        typeof data?.error === 'string' && data.error ? data.error : PLAYBACK_FAILED_FALLBACK
      );
    } catch {
      setPlaybackError(PLAYBACK_FAILED_FALLBACK);
    }
  };

  return (
    <li style={{ padding: '8px 0', borderBottom: '1px solid var(--cortex-border, rgba(255,255,255,0.04))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span className="cortex-badge" style={{ textTransform: 'capitalize' }}>{artifact.kind}</span>
        <span style={{ fontWeight: 500 }}>{artifact.file_name}</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {formatFileSize(artifact.file_size_bytes)}
          {artifact.uploaded_at ? ` · ${formatDateTime(artifact.uploaded_at)}` : ''}
          {artifact.uploaded_by_name ? ` · ${artifact.uploaded_by_name}` : ''}
        </span>
        {artifact.consent_attested_at && (
          <span
            style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
            title={artifact.consent_attestation_reason ?? undefined}
          >
            Consent attested by uploader
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
          {artifact.kind === 'recording' ? (
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={() => {
                setPlaybackError('');
                setPlaying((previous) => !previous);
              }}
            >
              {playing ? 'Hide player' : 'Play'}
            </button>
          ) : (
            // Transcripts are servable through the same gated route (step 4
            // renders them inline beside playback; until then, the raw text
            // is a click away rather than stored and unreachable). The route
            // answers text/plain with nosniff, so inline in a tab is safe.
            <a
              className="btn btn-sm btn-outline-secondary"
              href={bookingArtifactMediaUrl(booking.id, artifact.id)}
              target="_blank"
              rel="noopener noreferrer"
            >
              View
            </a>
          )}
          <button
            type="button"
            className="btn btn-sm btn-outline-danger"
            onClick={() => {
              // The artefact may be the only copy of a research recording -
              // a click that destroys it must be a decision, not a slip.
              if (window.confirm(`Delete ${artifact.file_name}? This removes the stored file permanently.`)) {
                onDelete();
              }
            }}
          >
            Delete
          </button>
        </span>
      </div>
      {playing && artifact.kind === 'recording' && (
        // The media URL comes from the api client's own configured base -
        // never window.location - and the element is mounted only on demand
        // so a long roster does not issue a media request per row.
        <video
          controls
          preload="metadata"
          src={bookingArtifactMediaUrl(booking.id, artifact.id)}
          onError={() => void surfacePlaybackRefusal()}
          style={{ marginTop: '8px', width: '100%', maxWidth: '640px', borderRadius: '4px' }}
        >
          <track kind="captions" />
        </video>
      )}
      {playing && playbackError && (
        <p role="alert" style={{ marginTop: '6px', fontSize: '0.75rem', color: 'var(--bs-danger, #dc3545)' }}>
          {playbackError}
        </p>
      )}
    </li>
  );
};

const BookingArtifactsSection: React.FC<BookingArtifactsSectionProps> = ({
  booking,
  controller
}) => {
  const artifacts = controller.artifactsByBooking[booking.id];
  const loading = controller.loadingIds.has(booking.id);
  const loadError = controller.loadErrors[booking.id];
  const upload = controller.uploads[booking.id];
  const actionError = controller.actionErrors[booking.id];
  const attestationDraft = controller.attestationDrafts[booking.id] ?? '';
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { loadArtifacts } = controller;
  useEffect(() => {
    // Load once per booking on first render; a re-mount after the page's
    // refetch spinner reuses the page-held list rather than refetching.
    if (artifacts === undefined && !loading) {
      void loadArtifacts(booking.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifacts, booking.id, loadArtifacts]);

  // Falsy, not === null: a roster row missing the column entirely must read
  // as needing attestation, never as consented (see useBookingArtifacts).
  const needsAttestation = !booking.consent_accepted_at;
  const canUpload = booking.status === 'booked' && !upload;
  const uploadBlockedOnReason = needsAttestation && !attestationDraft.trim();

  const handleFileChosen = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so choosing the same file again re-fires the change event.
    event.target.value = '';
    if (!file) return;
    void controller.uploadArtifact(
      { id: booking.id, consent_accepted_at: booking.consent_accepted_at },
      file
    );
  };

  return (
    <div style={{ padding: '4px 0 8px' }}>
      <h6 style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
        Session artefacts
      </h6>

      {loading && artifacts === undefined ? (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading artefacts...</p>
      ) : loadError ? (
        <p role="alert" style={{ fontSize: '0.8rem', color: 'var(--bs-danger, #dc3545)' }}>
          {loadError}{' '}
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => void loadArtifacts(booking.id)}
          >
            Retry
          </button>
        </p>
      ) : artifacts && artifacts.length > 0 ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {artifacts.map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              booking={booking}
              artifact={artifact}
              onDelete={() => void controller.removeArtifact(booking.id, artifact.id)}
            />
          ))}
        </ul>
      ) : (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          No artefacts yet. Upload the call platform&apos;s export - a recording, or a .vtt or .txt transcript.
        </p>
      )}

      {booking.status === 'booked' && (
        <div style={{ marginTop: '12px' }}>
          {needsAttestation && (
            <div style={{ marginBottom: '8px' }}>
              <label
                htmlFor={`attestation-${booking.id}`}
                style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}
              >
                This booking has no recorded consent in Cortex. To attach artefacts, state how
                the participant&apos;s consent was obtained - this is stored with your name
                against the upload.
              </label>
              <textarea
                id={`attestation-${booking.id}`}
                className="form-control"
                rows={2}
                maxLength={2000}
                placeholder="e.g. Consent taken verbally at the start of the call, on the recording"
                value={attestationDraft}
                onChange={(event) => controller.setAttestationDraft(booking.id, event.target.value)}
                style={{ fontSize: '0.8rem' }}
              />
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,audio/*,.vtt,.txt,text/vtt,text/plain"
              onChange={handleFileChosen}
              disabled={!canUpload || uploadBlockedOnReason}
              style={{ display: 'none' }}
              aria-label={`Upload artefact for ${booking.participant_name ?? 'this booking'}`}
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!canUpload || uploadBlockedOnReason}
              onClick={() => fileInputRef.current?.click()}
              title={uploadBlockedOnReason ? 'Type how consent was obtained first' : undefined}
            >
              {upload ? 'Uploading...' : 'Upload artefact'}
            </button>
            {upload && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {upload.phase === 'uploading'
                  ? `Uploading ${upload.fileName} - ${Math.round(upload.progressPercent)}%`
                  : upload.phase === 'finalizing'
                    ? `Finishing ${upload.fileName}...`
                    : `Preparing ${upload.fileName}...`}
              </span>
            )}
            {actionError && (
              <span role="alert" style={{ fontSize: '0.75rem', color: 'var(--bs-danger, #dc3545)' }}>
                {actionError}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default BookingArtifactsSection;
