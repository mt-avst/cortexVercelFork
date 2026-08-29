import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import TranscriptView, { formatCueTime } from '../TranscriptView';

const MEDIA_URL = 'http://api.test/api/bookings/b1/artifacts/a1/media';

const okText = (body: string) =>
  ({ ok: true, text: async () => body }) as unknown as Response;

const refusal = (error: string) =>
  ({ ok: false, json: async () => ({ error }) }) as unknown as Response;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('formatCueTime', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [65, '1:05'],
    [125, '2:05'],
    [3725, '1:02:05']
  ])('%d seconds reads as %s', (seconds, label) => {
    expect(formatCueTime(seconds)).toBe(label);
  });
});

describe('TranscriptView', () => {
  it('fetches the gated media URL with credentials and renders parsed cues with timestamps', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okText('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there.\n\n00:01:05.000 --> 00:01:07.000\nSecond cue.')
    );

    render(<TranscriptView mediaUrl={MEDIA_URL} />);

    expect(await screen.findByText('Hello there.')).toBeInTheDocument();
    expect(screen.getByText('Second cue.')).toBeInTheDocument();
    // Cue START times, formatted - the wire speaks seconds, the panel does not.
    expect(screen.getByText('0:01')).toBeInTheDocument();
    expect(screen.getByText('1:05')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(MEDIA_URL, { credentials: 'include' });
  });

  it('falls back to raw preformatted text when the transcript is not parseable as cues', async () => {
    // A plain .txt transcript: no timing lines, so parseVtt returns [] and the
    // panel shows the text rather than blanking it.
    const plain = 'Researcher: how did you find it?\nParticipant: fine, mostly.';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okText(plain));

    render(<TranscriptView mediaUrl={MEDIA_URL} />);

    // The raw text renders (in a <pre>), newlines preserved.
    const pre = await screen.findByText(/how did you find it/);
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toContain('fine, mostly.');
  });

  it("surfaces the route's refusal sentence when the fetch is refused", async () => {
    const sentence =
      'The stored object no longer matches what was finalized for this artefact, so it will not be served';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(refusal(sentence));

    render(<TranscriptView mediaUrl={MEDIA_URL} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
  });

  it('shows a plain error when the fetch itself throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    render(<TranscriptView mediaUrl={MEDIA_URL} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this transcript.');
  });

  it('does not commit a resolved fetch after unmount', async () => {
    let resolve: (r: Response) => void = () => undefined;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise<Response>((r) => {
        resolve = r;
      }) as ReturnType<typeof fetch>
    );

    const { unmount } = render(<TranscriptView mediaUrl={MEDIA_URL} />);
    unmount();
    // Resolving after unmount must not throw (no setState on an unmounted tree).
    resolve(okText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nLate.'));
    await waitFor(() => expect(screen.queryByText('Late.')).not.toBeInTheDocument());
  });
});
