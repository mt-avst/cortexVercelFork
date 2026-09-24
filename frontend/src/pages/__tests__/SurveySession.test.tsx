import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import SurveySession from '../SurveySession';

/**
 * The participant surface for a native poll or survey.
 *
 * Every branch here is one a participant can land on, and most of them are
 * reached by something going wrong - an expired link, someone else's link, a
 * survey that has been unpublished. Each has to say something the participant
 * can act on, which is why the error split is asserted message by message
 * rather than as "an error was shown".
 */

const authState = {
  user: { id: 'u1', role: 'employee', name: 'E' } as { id: string } | null,
  loading: false,
  initialAuthCheck: true
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => authState
}));

vi.mock('../../components/survey/SurveyRunner', () => ({
  SurveyRunner: ({ onComplete }: { onComplete?: () => void }) => (
    <button onClick={() => onComplete?.()} type="button">
      Finish the survey
    </button>
  )
}));

const payload = {
  contract_version: '1.0',
  study: { id: 's', title: 'Pulse', intro_text: 'i', consent_text: 'c' },
  participant: { participant_id: 'u1' },
  session: {
    session_id: 'sess',
    session_token: 'fh_tok',
    study_id: 's',
    participant_id: 'u1',
    return_url: 'http://localhost:3000/opportunities/opp-1?completed=1'
  },
  steps: [{ step_id: 's_1', order: 1, type: 'nps', prompt: 'Recommend?' }]
};

const renderSession = () =>
  render(
    <MemoryRouter initialEntries={['/survey/fh_tok']}>
      <Routes>
        <Route path="/survey/:token" element={<SurveySession />} />
      </Routes>
    </MemoryRouter>
  );

const respondWith = (status: number, body?: unknown) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    }))
  );
};

beforeEach(() => {
  authState.user = { id: 'u1' };
  authState.loading = false;
  authState.initialAuthCheck = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SurveySession', () => {
  it('runs the survey once the payload loads', async () => {
    respondWith(200, payload);
    renderSession();

    expect(
      await screen.findByRole('button', { name: /finish the survey/i })
    ).toBeInTheDocument();
  });

  /**
   * Sessions expire 24 hours after minting, so a participant who reopens the
   * tab the next day lands here - and the backend answers 410, not 404. Telling
   * them to "try again" describes something that can never work.
   */
  it('tells a participant their link has expired, not to try again', async () => {
    respondWith(410);
    renderSession();

    expect(await screen.findByText(/link has expired/i)).toBeInTheDocument();
    // #169: the way out names the participant page by its name.
    expect(screen.getByRole('link', { name: /^Back to Participate$/ })).toHaveAttribute('href', '/');
  });

  it('distinguishes someone else\'s link from one that does not exist', async () => {
    respondWith(403);
    renderSession();

    expect(await screen.findByText(/belongs to someone else/i)).toBeInTheDocument();
  });

  it('says a link does not exist when it does not', async () => {
    respondWith(404);
    renderSession();

    expect(await screen.findByText(/does not exist/i)).toBeInTheDocument();
  });

  it('falls back to a generic message for anything else', async () => {
    respondWith(500);
    renderSession();

    expect(await screen.findByText(/Could not open this survey/i)).toBeInTheDocument();
  });

  it('reports a network failure rather than hanging on the loading state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    renderSession();

    expect(await screen.findByText(/Could not open this survey/i)).toBeInTheDocument();
  });

  it('sends an anonymous visitor away rather than asking the API', async () => {
    authState.user = null;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderSession();

    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The backend mints a return_url and it reaches the payload. Without reading
   * it the participant finished on a dead end, and the study page never showed
   * its completion banner because that is keyed on `?completed=1`.
   */
  it('offers a way back to the study after finishing', async () => {
    respondWith(200, payload);
    renderSession();

    (await screen.findByRole('button', { name: /finish the survey/i })).click();

    const back = await screen.findByRole('link', { name: /back to the study/i });
    expect(back).toHaveAttribute('href', expect.stringContaining('completed=1'));
  });

  // Fix-first row 22 (second-pass review): moved out of the standard chrome
  // (header nav, footer) onto the same chrome-less layout the recording
  // surface uses - but a recording is trapped there deliberately (a stray
  // click costs the session), and a survey is not. Without its own exit, a
  // participant mid-survey had no way out at all once the header disappeared.
  it('offers a way to leave while the survey is still in progress', async () => {
    respondWith(200, payload);
    renderSession();

    await screen.findByRole('button', { name: /finish the survey/i });

    expect(screen.getByRole('link', { name: /^Back to Participate$/ })).toHaveAttribute('href', '/');
  });

  it('renders inside a main landmark, since there is no chrome to supply one', async () => {
    respondWith(200, payload);
    renderSession();

    await screen.findByRole('button', { name: /finish the survey/i });

    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('offers no way back when the return url cannot be trusted', async () => {
    respondWith(200, {
      ...payload,
      session: { ...payload.session, return_url: 'javascript:alert(1)' }
    });
    renderSession();

    (await screen.findByRole('button', { name: /finish the survey/i })).click();

    await screen.findByText(/answers have been sent/i);
    expect(screen.queryByRole('link', { name: /back to the study/i })).toBeNull();
    // It falls back to the participant page instead (#169 names it).
    expect(screen.getByRole('link', { name: /^Back to Participate$/ })).toHaveAttribute('href', '/');
  });
});
