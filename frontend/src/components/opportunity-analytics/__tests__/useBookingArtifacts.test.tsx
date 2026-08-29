import { act, renderHook, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import {
  useBookingArtifacts,
  planArtifactUpload,
  ATTESTATION_REASON_NEEDED,
  ARTIFACT_FILE_TYPE_REFUSED,
  ARTIFACT_UPLOAD_FAILED
} from '../useBookingArtifacts';
import {
  getBookingArtifacts,
  presignBookingArtifact,
  finalizeBookingArtifact,
  deleteBookingArtifact
} from '../../../api/client';
import { sendBlobWithProgress } from '../../../lib/recording/runtime-client';

vi.mock('../../../api/client', () => ({
  getBookingArtifacts: vi.fn(async () => []),
  presignBookingArtifact: vi.fn(async () => ({
    mode: 's3',
    objectKey: 'booking-artifacts/b1/key.webm',
    uploadUrl: 'https://s3.example/put-url',
    validUntil: '2026-08-29T12:00:00.000Z'
  })),
  finalizeBookingArtifact: vi.fn(async () => ({ id: 'a1' })),
  deleteBookingArtifact: vi.fn(async () => undefined)
}));

vi.mock('../../../lib/recording/runtime-client', () => ({
  sendBlobWithProgress: vi.fn(async () => ({ status: 200, ok: true, responseText: '' }))
}));

const mockList = getBookingArtifacts as ReturnType<typeof vi.fn>;
const mockPresign = presignBookingArtifact as ReturnType<typeof vi.fn>;
const mockFinalize = finalizeBookingArtifact as ReturnType<typeof vi.fn>;
const mockDelete = deleteBookingArtifact as ReturnType<typeof vi.fn>;
const mockPut = sendBlobWithProgress as ReturnType<typeof vi.fn>;

const file = (name: string, type: string): File =>
  new File(['bytes'], name, { type });

const BOOKED_WITH_CONSENT = { id: 'b1', consent_accepted_at: '2026-08-28T10:00:00.000Z' };
const BOOKED_WITHOUT_CONSENT = { id: 'b1', consent_accepted_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([]);
  mockPresign.mockResolvedValue({
    mode: 's3',
    objectKey: 'booking-artifacts/b1/key.webm',
    uploadUrl: 'https://s3.example/put-url',
    validUntil: '2026-08-29T12:00:00.000Z'
  });
  mockFinalize.mockResolvedValue({ id: 'a1' });
  mockPut.mockResolvedValue({ status: 200, ok: true, responseText: '' });
});

describe('planArtifactUpload: kind decided by mime, extension breaking empty-type ties', () => {
  it.each([
    ['call.webm', 'video/webm', 'recording', 'video/webm'],
    ['call.m4a', 'audio/mp4', 'recording', 'audio/mp4'],
    ['t.vtt', 'text/vtt', 'transcript', 'text/vtt'],
    ['t.txt', 'text/plain', 'transcript', 'text/plain'],
    // The realistic .vtt case: the OS type registry reports NOTHING.
    ['captions.vtt', '', 'transcript', 'text/vtt'],
    ['notes.txt', '', 'transcript', 'text/plain']
  ])('%s (%s) becomes a %s upload as %s', (name, type, kind, mimeType) => {
    expect(planArtifactUpload({ name, type })).toEqual({ kind, mimeType });
  });

  it.each([
    ['report.pdf', 'application/pdf'],
    ['page.html', 'text/html'],
    ['mystery.bin', '']
  ])('refuses %s (%s) with the display sentence', (name, type) => {
    expect(planArtifactUpload({ name, type })).toEqual({
      refusal: ARTIFACT_FILE_TYPE_REFUSED
    });
  });
});

describe('the upload flow: presign, direct PUT past the axios client, finalize, re-list', () => {
  it('runs the three legs in order and refreshes the list from the server', async () => {
    const { result } = renderHook(() => useBookingArtifacts());

    await act(async () => {
      await result.current.uploadArtifact(BOOKED_WITH_CONSENT, file('call.webm', 'video/webm'));
    });

    expect(mockPresign).toHaveBeenCalledWith('b1', {
      kind: 'recording',
      file_name: 'call.webm',
      mime_type: 'video/webm',
      file_size_bytes: 5
    });
    // The PUT goes straight at the presigned URL with ONLY the signed
    // content type - the axios client (whose CSRF header would break the
    // signature) is bypassed by construction, since this module never
    // imports it for the transfer.
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://s3.example/put-url',
        method: 'PUT',
        headers: { 'Content-Type': 'video/webm' }
      })
    );
    expect(mockFinalize).toHaveBeenCalledWith('b1', 'booking-artifacts/b1/key.webm');
    // Re-listed, not patched in: the list wire carries uploaded_by_name.
    expect(mockList).toHaveBeenCalledWith('b1');
  });

  it('sends the typed attestation reason when the booking lacks recorded consent', async () => {
    const { result } = renderHook(() => useBookingArtifacts());

    act(() => {
      result.current.setAttestationDraft('b1', '  Consent taken verbally on the call  ');
    });
    await act(async () => {
      await result.current.uploadArtifact(BOOKED_WITHOUT_CONSENT, file('call.webm', 'video/webm'));
    });

    expect(mockPresign).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({
        consent_attestation_reason: 'Consent taken verbally on the call'
      })
    );
    // The consumed draft is cleared - stale attestations must not ride into
    // the next upload unread.
    expect(result.current.attestationDrafts['b1']).toBeUndefined();
  });

  it('refuses to start without a typed reason on a consent-less booking - nothing leaves the browser', async () => {
    const { result } = renderHook(() => useBookingArtifacts());

    await act(async () => {
      await result.current.uploadArtifact(BOOKED_WITHOUT_CONSENT, file('call.webm', 'video/webm'));
    });

    expect(result.current.actionErrors['b1']).toBe(ATTESTATION_REASON_NEEDED);
    expect(mockPresign).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('treats an ABSENT consent field as attestation-needed, never as consent', async () => {
    // The shape a narrowed roster projection would deliver - undefined, not
    // null. Falsy-check, proven necessary by a review gate.
    const { result } = renderHook(() => useBookingArtifacts());

    await act(async () => {
      await result.current.uploadArtifact(
        { id: 'b1', consent_accepted_at: undefined as unknown as null },
        file('call.webm', 'video/webm')
      );
    });

    expect(result.current.actionErrors['b1']).toBe(ATTESTATION_REASON_NEEDED);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('sends NO attestation beside a recorded acceptance, even with a draft typed', async () => {
    const { result } = renderHook(() => useBookingArtifacts());

    act(() => {
      result.current.setAttestationDraft('b1', 'A weaker claim than the acceptance');
    });
    await act(async () => {
      await result.current.uploadArtifact(BOOKED_WITH_CONSENT, file('call.webm', 'video/webm'));
    });

    const body = mockPresign.mock.calls[0][1] as Record<string, unknown>;
    expect(body.consent_attestation_reason).toBeUndefined();
  });

  it('refuses an unrecognised file type client-side, before any request', async () => {
    const { result } = renderHook(() => useBookingArtifacts());

    await act(async () => {
      await result.current.uploadArtifact(BOOKED_WITH_CONSENT, file('report.pdf', 'application/pdf'));
    });

    expect(result.current.actionErrors['b1']).toBe(ARTIFACT_FILE_TYPE_REFUSED);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it("surfaces the server's own refusal sentence verbatim, not a translation", async () => {
    const serverSentence =
      'Attach a recording only to a booking with recorded consent, or attest how consent was obtained outside Cortex';
    mockPresign.mockRejectedValue({ response: { data: { error: serverSentence } } });
    const { result } = renderHook(() => useBookingArtifacts());

    await act(async () => {
      await result.current.uploadArtifact(BOOKED_WITH_CONSENT, file('call.webm', 'video/webm'));
    });

    expect(result.current.actionErrors['b1']).toBe(serverSentence);
    expect(result.current.uploads['b1']).toBeUndefined();
  });

  it('a failed PUT reports the transfer failure and never finalizes', async () => {
    mockPut.mockResolvedValue({ status: 403, ok: false, responseText: '' });
    const { result } = renderHook(() => useBookingArtifacts());

    await act(async () => {
      await result.current.uploadArtifact(BOOKED_WITH_CONSENT, file('call.webm', 'video/webm'));
    });

    expect(result.current.actionErrors['b1']).toBe(ARTIFACT_UPLOAD_FAILED);
    expect(mockFinalize).not.toHaveBeenCalled();
  });
});

describe('loading and deleting', () => {
  it('loads a booking list and exposes it keyed by booking', async () => {
    mockList.mockResolvedValue([{ id: 'a1', kind: 'recording' }]);
    const { result } = renderHook(() => useBookingArtifacts());

    await act(async () => {
      await result.current.loadArtifacts('b1');
    });

    await waitFor(() =>
      expect(result.current.artifactsByBooking['b1']).toEqual([{ id: 'a1', kind: 'recording' }])
    );
  });

  it('a failed load keeps the slot unloaded and says so', async () => {
    mockList.mockRejectedValue({ response: { data: { error: 'Only the owner or a superadmin can manage artefacts for this booking' } } });
    const { result } = renderHook(() => useBookingArtifacts());

    await act(async () => {
      await result.current.loadArtifacts('b1');
    });

    expect(result.current.artifactsByBooking['b1']).toBeUndefined();
    expect(result.current.loadErrors['b1']).toBe(
      'Only the owner or a superadmin can manage artefacts for this booking'
    );
  });

  it('delete removes the artefact from the held list', async () => {
    mockList.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
    const { result } = renderHook(() => useBookingArtifacts());
    await act(async () => {
      await result.current.loadArtifacts('b1');
    });

    await act(async () => {
      await result.current.removeArtifact('b1', 'a1');
    });

    expect(mockDelete).toHaveBeenCalledWith('b1', 'a1');
    expect(result.current.artifactsByBooking['b1']).toEqual([{ id: 'a2' }]);
  });

  it('a failed delete keeps the row and surfaces the sentence', async () => {
    mockList.mockResolvedValue([{ id: 'a1' }]);
    mockDelete.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useBookingArtifacts());
    await act(async () => {
      await result.current.loadArtifacts('b1');
    });

    await act(async () => {
      await result.current.removeArtifact('b1', 'a1');
    });

    expect(result.current.artifactsByBooking['b1']).toEqual([{ id: 'a1' }]);
    expect(result.current.actionErrors['b1']).toBe('Could not delete the artefact');
  });
});
