import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import BookingArtifactsSection, {
  formatFileSize,
  PLAYBACK_FAILED_FALLBACK
} from '../BookingArtifactsSection';
import { BookingArtifactsController } from '../useBookingArtifacts';
import { bookingArtifactMediaUrl } from '../../../api/client';
import { BookingArtifact, OpportunityBookingRow } from '../../../api/types';
import { buildArtifactsController } from './artifactsControllerStub';

const booking = (overrides: Partial<OpportunityBookingRow> = {}): OpportunityBookingRow => ({
  id: 'b1',
  user_id: 'user-1',
  session_id: 's1',
  status: 'booked',
  completion_status: 'pending',
  session_start_time: '2026-09-01T10:00:00.000Z',
  session_end_time: '2026-09-01T11:00:00.000Z',
  participant_name: 'Jane Doe',
  participant_email: 'jane@example.com',
  business_unit: 'Ops',
  role_title: 'Analyst',
  researcher_notes: null,
  researcher_notes_updated_at: null,
  consent_accepted_at: '2026-08-28T10:00:00.000Z',
  created_at: '2026-08-27T09:00:00.000Z',
  updated_at: '2026-08-27T09:00:00.000Z',
  ...overrides
});

const artifact = (overrides: Partial<BookingArtifact> = {}): BookingArtifact => ({
  id: 'a1',
  booking_id: 'b1',
  kind: 'recording',
  file_name: 'call.webm',
  mime_type: 'video/webm',
  file_size_bytes: 1024 * 1024,
  uploaded_by: 'user-9',
  uploaded_by_name: 'Ada Researcher',
  uploaded_at: '2026-08-28T12:00:00.000Z',
  consent_attested_by: null,
  consent_attested_at: null,
  consent_attestation_reason: null,
  ...overrides
});

const loaded = (
  artifacts: BookingArtifact[],
  overrides: Partial<BookingArtifactsController> = {}
): BookingArtifactsController =>
  buildArtifactsController({ artifactsByBooking: { b1: artifacts }, ...overrides });

describe('formatFileSize', () => {
  it.each([
    [512, '512 B'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [3 * 1024 * 1024 * 1024, '3.0 GB']
  ])('%d bytes reads as %s', (bytes, label) => {
    expect(formatFileSize(bytes)).toBe(label);
  });
});

describe('BookingArtifactsSection', () => {
  it('lists artefacts with kind, size, date and uploader name', () => {
    render(<BookingArtifactsSection booking={booking()} controller={loaded([artifact()])} />);

    expect(screen.getByText('call.webm')).toBeInTheDocument();
    expect(screen.getByText('recording')).toBeInTheDocument();
    expect(screen.getByText(/1\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText(/Ada Researcher/)).toBeInTheDocument();
  });

  it('loads the list on first mount, and only then', () => {
    const controller = buildArtifactsController();
    render(<BookingArtifactsSection booking={booking()} controller={controller} />);

    expect(controller.loadArtifacts).toHaveBeenCalledWith('b1');
  });

  it('does not refetch a list the page already holds', () => {
    const controller = loaded([]);
    render(<BookingArtifactsSection booking={booking()} controller={controller} />);

    expect(controller.loadArtifacts).not.toHaveBeenCalled();
  });

  it('mounts the player on demand with the URL the api client mints - never one built here', async () => {
    const user = userEvent.setup();
    render(<BookingArtifactsSection booking={booking()} controller={loaded([artifact()])} />);

    // No media request until the researcher asks for one.
    expect(document.querySelector('video')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Play' }));

    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    // The single source of playback URLs is the api client's minting
    // function, built from its configured base - asserting equality here
    // pins the component to it, so a hand-built (window.location-derived)
    // URL cannot creep in unnoticed.
    expect(video!.getAttribute('src')).toBe(bookingArtifactMediaUrl('b1', 'a1'));
  });

  it('renders a transcript inline on demand through the same gated route, not a player', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nInline cue.'
    } as unknown as Response);

    render(
      <BookingArtifactsSection
        booking={booking()}
        controller={loaded([artifact({ kind: 'transcript', file_name: 't.vtt', mime_type: 'text/vtt' })])}
      />
    );

    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    // No transcript request until the researcher opens it.
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'View transcript' }));

    expect(await screen.findByText('Inline cue.')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(bookingArtifactMediaUrl('b1', 'a1'), {
      credentials: 'include'
    });
    fetchSpy.mockRestore();
  });

  it("surfaces the media route's own refusal sentence when playback fails", async () => {
    // The ETag tripwire's refusal is a display sentence, but a <video>
    // swallows response bodies - the component must go and read it.
    const serverSentence =
      'The stored object no longer matches what was finalized for this artefact, so it will not be served';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ error: serverSentence })
    } as unknown as Response);
    const user = userEvent.setup();

    render(<BookingArtifactsSection booking={booking()} controller={loaded([artifact()])} />);
    await user.click(screen.getByRole('button', { name: 'Play' }));
    const video = document.querySelector('video')!;
    video.dispatchEvent(new Event('error'));

    expect(await screen.findByRole('alert')).toHaveTextContent(serverSentence);
    expect(fetchSpy).toHaveBeenCalledWith(bookingArtifactMediaUrl('b1', 'a1'), {
      credentials: 'include'
    });
    fetchSpy.mockRestore();
  });

  it('falls back to the plain sentence when the route serves fine - and cancels the probe download', async () => {
    // ok-but-player-failed means a local problem (codec, blip): the probe
    // must not silently pull a 2 GiB body to find that out.
    const cancel = vi.fn(async () => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: { cancel },
      json: async () => ({})
    } as unknown as Response);
    const user = userEvent.setup();

    render(<BookingArtifactsSection booking={booking()} controller={loaded([artifact()])} />);
    await user.click(screen.getByRole('button', { name: 'Play' }));
    document.querySelector('video')!.dispatchEvent(new Event('error'));

    expect(await screen.findByRole('alert')).toHaveTextContent(PLAYBACK_FAILED_FALLBACK);
    expect(cancel).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('falls back to the plain sentence when the probe itself cannot reach the server', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();

    render(<BookingArtifactsSection booking={booking()} controller={loaded([artifact()])} />);
    await user.click(screen.getByRole('button', { name: 'Play' }));
    document.querySelector('video')!.dispatchEvent(new Event('error'));

    expect(await screen.findByRole('alert')).toHaveTextContent(PLAYBACK_FAILED_FALLBACK);
    fetchSpy.mockRestore();
  });

  it('treats a roster row that LACKS the consent column as needing attestation', () => {
    // A projection narrowing upstream would deliver rows without the key; the
    // review gate proved the strict-null version enabled consentless uploads
    // on exactly that shape. Absence must never read as consent.
    const rowWithoutColumn = booking();
    delete (rowWithoutColumn as Partial<OpportunityBookingRow>).consent_accepted_at;

    render(<BookingArtifactsSection booking={rowWithoutColumn} controller={loaded([])} />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload artefact' })).toBeDisabled();
  });

  it('shows the attestation textarea ONLY when the booking lacks recorded consent', () => {
    const { rerender } = render(
      <BookingArtifactsSection booking={booking({ consent_accepted_at: null })} controller={loaded([])} />
    );
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByText(/state how/i)).toBeInTheDocument();

    rerender(<BookingArtifactsSection booking={booking()} controller={loaded([])} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('disables upload until a reason is typed on a consent-less booking', () => {
    render(
      <BookingArtifactsSection booking={booking({ consent_accepted_at: null })} controller={loaded([])} />
    );

    expect(screen.getByRole('button', { name: 'Upload artefact' })).toBeDisabled();
  });

  it('enables upload once the page-held draft carries a reason', () => {
    render(
      <BookingArtifactsSection
        booking={booking({ consent_accepted_at: null })}
        controller={loaded([], { attestationDrafts: { b1: 'Consent taken verbally on the call' } })}
      />
    );

    expect(screen.getByRole('button', { name: 'Upload artefact' })).toBeEnabled();
  });

  it('offers no upload controls on a cancelled booking - the server would refuse anyway', () => {
    render(
      <BookingArtifactsSection booking={booking({ status: 'cancelled' })} controller={loaded([])} />
    );

    expect(screen.queryByRole('button', { name: /upload/i })).toBeNull();
  });

  it('renders the refusal sentence the controller holds', () => {
    render(
      <BookingArtifactsSection
        booking={booking()}
        controller={loaded([], { actionErrors: { b1: 'Recordings are accepted as video or audio types only' } })}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Recordings are accepted as video or audio types only'
    );
  });

  it('shows upload progress while a transfer is in flight', () => {
    render(
      <BookingArtifactsSection
        booking={booking()}
        controller={loaded([], {
          uploads: { b1: { fileName: 'call.webm', phase: 'uploading', progressPercent: 42 } }
        })}
      />
    );

    expect(screen.getByText('Uploading call.webm - 42%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Uploading...' })).toBeDisabled();
  });

  it('deletes only through the confirm dialog', async () => {
    const user = userEvent.setup();
    const controller = loaded([artifact()]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<BookingArtifactsSection booking={booking()} controller={controller} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(controller.removeArtifact).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(controller.removeArtifact).toHaveBeenCalledWith('b1', 'a1');

    confirmSpy.mockRestore();
  });

  it('hands a chosen file to the controller with the booking consent state', async () => {
    const user = userEvent.setup();
    const controller = loaded([]);
    render(<BookingArtifactsSection booking={booking()} controller={controller} />);

    const input = screen.getByLabelText('Upload artefact for Jane Doe') as HTMLInputElement;
    const file = new File(['bytes'], 'call.webm', { type: 'video/webm' });
    await user.upload(input, file);

    expect(controller.uploadArtifact).toHaveBeenCalledWith(
      { id: 'b1', consent_accepted_at: '2026-08-28T10:00:00.000Z' },
      file
    );
  });
});
