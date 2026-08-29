import { useCallback, useState } from 'react';
import {
  getBookingArtifacts,
  presignBookingArtifact,
  finalizeBookingArtifact,
  deleteBookingArtifact
} from '../../api/client';
import { BookingArtifact, BookingArtifactKind } from '../../api/types';
import { sendBlobWithProgress } from '../../lib/recording/runtime-client';

/**
 * Booking artefact state and actions (#79 step 3), owned by the PAGE.
 *
 * OpportunityAnalytics early-returns a spinner whenever it refetches the
 * opportunity, which unmounts everything below it - the trap that already ate
 * a half-written researcher note. Everything here must survive that unmount:
 * a PUT in flight, its progress, an attestation reason half-typed. So the
 * page calls this hook and hands the controller down; the tab and the
 * artefact section render it and own nothing.
 */

export const ATTESTATION_REASON_NEEDED =
  'This booking has no recorded consent. Say how consent was obtained before uploading.';
export const ARTIFACT_FILE_TYPE_REFUSED =
  'Upload a video or audio recording, or a .vtt or .txt transcript';
export const ARTIFACT_UPLOAD_FAILED =
  'The upload did not complete. Nothing was attached - try again.';

/**
 * What an upload of this file would be, decided CLIENT-SIDE from the mime
 * type so the researcher hears "wrong kind of file" before any bytes move.
 * The server re-checks all of it - this is a courtesy, not the gate.
 *
 * Browsers commonly report an EMPTY type for .vtt files (the type registry
 * varies by OS), so the extension breaks the tie only when the type is empty.
 */
export function planArtifactUpload(
  file: Pick<File, 'name' | 'type'>
): { kind: BookingArtifactKind; mimeType: string } | { refusal: string } {
  const reportedType = file.type.toLowerCase();
  const extension = file.name.includes('.')
    ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
    : '';

  const mimeType =
    reportedType ||
    (extension === 'vtt' ? 'text/vtt' : extension === 'txt' ? 'text/plain' : '');

  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
    return { kind: 'recording', mimeType };
  }
  if (mimeType === 'text/vtt' || mimeType === 'text/plain') {
    return { kind: 'transcript', mimeType };
  }
  return { refusal: ARTIFACT_FILE_TYPE_REFUSED };
}

export interface ArtifactUploadState {
  fileName: string;
  phase: 'presigning' | 'uploading' | 'finalizing';
  progressPercent: number;
}

export interface BookingArtifactsController {
  /** undefined = never loaded for this booking; [] = loaded and empty. */
  artifactsByBooking: Record<string, BookingArtifact[] | undefined>;
  loadErrors: Record<string, string>;
  loadingIds: Set<string>;
  uploads: Record<string, ArtifactUploadState | undefined>;
  /** Upload and delete failures, per booking, server sentences verbatim. */
  actionErrors: Record<string, string>;
  attestationDrafts: Record<string, string>;
  setAttestationDraft: (bookingId: string, text: string) => void;
  loadArtifacts: (bookingId: string) => Promise<void>;
  uploadArtifact: (
    booking: { id: string; consent_accepted_at: string | null },
    file: File
  ) => Promise<void>;
  removeArtifact: (bookingId: string, artifactId: string) => Promise<void>;
}

/**
 * The server's refusal sentences are written for display - surface them
 * verbatim rather than translating (the step 1b lesson: a hardcoded message
 * shown for a different refusal sends the researcher to the wrong fix).
 */
const serverSentence = (err: unknown): string | null => {
  const data = (err as { response?: { data?: { error?: unknown } } }).response?.data;
  return typeof data?.error === 'string' && data.error ? data.error : null;
};

export function useBookingArtifacts(): BookingArtifactsController {
  const [artifactsByBooking, setArtifactsByBooking] = useState<
    Record<string, BookingArtifact[] | undefined>
  >({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [uploads, setUploads] = useState<Record<string, ArtifactUploadState | undefined>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [attestationDrafts, setAttestationDrafts] = useState<Record<string, string>>({});

  const setAttestationDraft = useCallback((bookingId: string, text: string) => {
    setAttestationDrafts((previous) => ({ ...previous, [bookingId]: text }));
    // A refusal about the old draft describes an attempt that no longer
    // matches what is on screen.
    setActionErrors((previous) =>
      previous[bookingId] ? { ...previous, [bookingId]: '' } : previous
    );
  }, []);

  const loadArtifacts = useCallback(async (bookingId: string) => {
    setLoadingIds((previous) => new Set(previous).add(bookingId));
    setLoadErrors((previous) => ({ ...previous, [bookingId]: '' }));
    try {
      const artifacts = await getBookingArtifacts(bookingId);
      setArtifactsByBooking((previous) => ({ ...previous, [bookingId]: artifacts }));
    } catch (err) {
      setLoadErrors((previous) => ({
        ...previous,
        [bookingId]: serverSentence(err) ?? 'Could not load the artefacts'
      }));
    } finally {
      setLoadingIds((previous) => {
        const next = new Set(previous);
        next.delete(bookingId);
        return next;
      });
    }
  }, []);

  const uploadArtifact = useCallback(
    async (
      booking: { id: string; consent_accepted_at: string | null },
      file: File
    ) => {
      const plan = planArtifactUpload(file);
      if ('refusal' in plan) {
        setActionErrors((previous) => ({ ...previous, [booking.id]: plan.refusal }));
        return;
      }

      // D3's escape hatch is a TYPED reason, never a bare flag. The reason is
      // read at click time and sent only when the booking lacks recorded
      // acceptance - beside a real acceptance the server would record the
      // weaker claim over the stronger one. FALSY, not === null: a roster row
      // that lost the column (a projection narrowing this type cannot see)
      // must read as attestation-needed, never as consented - the review gate
      // proved the strict-null version enabled consentless uploads on it.
      const needsAttestation = !booking.consent_accepted_at;
      const reason = (attestationDrafts[booking.id] ?? '').trim();
      if (needsAttestation && !reason) {
        setActionErrors((previous) => ({
          ...previous,
          [booking.id]: ATTESTATION_REASON_NEEDED
        }));
        return;
      }

      setActionErrors((previous) => ({ ...previous, [booking.id]: '' }));
      setUploads((previous) => ({
        ...previous,
        [booking.id]: { fileName: file.name, phase: 'presigning', progressPercent: 0 }
      }));

      try {
        const presigned = await presignBookingArtifact(booking.id, {
          kind: plan.kind,
          file_name: file.name,
          mime_type: plan.mimeType,
          file_size_bytes: file.size,
          ...(needsAttestation ? { consent_attestation_reason: reason } : {})
        });

        setUploads((previous) => ({
          ...previous,
          [booking.id]: { fileName: file.name, phase: 'uploading', progressPercent: 0 }
        }));

        // Direct to S3, BYPASSING the axios client on purpose: the CSRF
        // interceptor's header is not in the presigned signature and would
        // fail the PUT. Cross-origin to the store: no cookies, only the
        // content type the URL was signed for.
        const putResponse = await sendBlobWithProgress({
          url: presigned.uploadUrl,
          method: 'PUT',
          headers: { 'Content-Type': plan.mimeType },
          blob: file,
          onProgress: (event) => {
            setUploads((previous) =>
              previous[booking.id]?.phase === 'uploading'
                ? {
                    ...previous,
                    [booking.id]: {
                      fileName: file.name,
                      phase: 'uploading',
                      progressPercent: event.percentage
                    }
                  }
                : previous
            );
          }
        });
        if (!putResponse.ok) {
          throw new Error(ARTIFACT_UPLOAD_FAILED);
        }

        setUploads((previous) => ({
          ...previous,
          [booking.id]: { fileName: file.name, phase: 'finalizing', progressPercent: 100 }
        }));
        await finalizeBookingArtifact(booking.id, presigned.objectKey);

        // Re-list rather than patching the finalize echo in: the list wire
        // carries uploaded_by_name from its users join, the 201 cannot.
        await loadArtifacts(booking.id);
        setAttestationDrafts((previous) => {
          if (previous[booking.id] === undefined) return previous;
          const next = { ...previous };
          delete next[booking.id];
          return next;
        });
      } catch (err) {
        setActionErrors((previous) => ({
          ...previous,
          [booking.id]:
            serverSentence(err) ??
            (err instanceof Error && err.message === ARTIFACT_UPLOAD_FAILED
              ? ARTIFACT_UPLOAD_FAILED
              : 'Could not attach the file. Nothing was stored - try again.')
        }));
      } finally {
        setUploads((previous) => ({ ...previous, [booking.id]: undefined }));
      }
    },
    [attestationDrafts, loadArtifacts]
  );

  const removeArtifact = useCallback(async (bookingId: string, artifactId: string) => {
    setActionErrors((previous) => ({ ...previous, [bookingId]: '' }));
    try {
      await deleteBookingArtifact(bookingId, artifactId);
      setArtifactsByBooking((previous) => ({
        ...previous,
        [bookingId]: (previous[bookingId] ?? []).filter(
          (artifact) => artifact.id !== artifactId
        )
      }));
    } catch (err) {
      setActionErrors((previous) => ({
        ...previous,
        [bookingId]: serverSentence(err) ?? 'Could not delete the artefact'
      }));
    }
  }, []);

  return {
    artifactsByBooking,
    loadErrors,
    loadingIds,
    uploads,
    actionErrors,
    attestationDrafts,
    setAttestationDraft,
    loadArtifacts,
    uploadArtifact,
    removeArtifact
  };
}
