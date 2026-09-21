import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { getOpportunity, updateOpportunity } from '../../api/client';

/**
 * The external-tool consent affirmation, loaded from and saved to the server
 * (cto/AdaptaLabs#136).
 *
 * It used to be client-only: never sent, and defaulted on load to
 * `status === 'published'`, so an author's tick vanished on reload and every
 * reopened published study claimed an affirmation nobody had made. The column
 * is tri-state and the form has to keep it honest:
 *
 *  - true: ticked, and Review may say the author confirmed it
 *  - false: unticked, and Review reads it as not yet confirmed
 *  - null (never recorded): unticked; a draft reads as not yet confirmed, and
 *    a study that was ALREADY published when it was loaded keeps the neutral
 *    "Handled by the external tool" rather than claiming an author action
 *
 * Asserted on the checkbox, on Review's words and on the REQUEST BODY - the
 * payload builder is pure, but only a test that hydrates the real form from a
 * fetched row can see the two hydrate sites and the dirty baseline.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn().mockResolvedValue({ id: 'opp-new' }),
  updateOpportunity: vi.fn().mockResolvedValue({ id: 'opp-1' }),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/firsthand-studies', () => ({
  getFirstHandStudy: vi.fn()
}));

/** An external hand-off: the one shape with the Your link step. */
const EXTERNAL_ROW = (over: Record<string, unknown> = {}) => ({
  id: 'opp-1',
  type: 'question',
  title: 'One question about the build pipeline',
  purpose_one_liner: 'A purpose long enough to pass validation',
  description_optional: '',
  product_optional: '',
  meeting_location_optional: '',
  status: 'draft',
  default_duration_minutes: 30,
  delivery_mode: 'external',
  external_link_optional: 'https://forms.example.com/one-question',
  participant_type_required: 'any',
  firsthand_study_id: null,
  start_date: '2026-09-01',
  end_date: '2026-09-30',
  owner_user_id: 'admin-1',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  sessions: [],
  external_consent_confirmed: null,
  ...over
});

const renderEdit = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
      <Routes>
        <Route path="/admin/opportunities/:id/edit" element={<OpportunityForm />} />
      </Routes>
    </MemoryRouter>
  );

/** Loaded once the hydrated title is on the Basic Info step. */
const awaitLoaded = async () => {
  fireEvent.click(
    within(await screen.findByRole('navigation', { name: 'Form steps' })).getAllByRole(
      'button'
    )[1]
  );
  await screen.findByDisplayValue('One question about the build pipeline');
};

const goToStep = (title: string) => {
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Form steps' }))
      .getAllByRole('button')
      .find((button) => (button.textContent ?? '').includes(title)) as HTMLElement
  );
};

const consentCheckbox = async () => {
  goToStep('Your link');
  return (await screen.findByLabelText(
    'I confirm the external tool has its own consent text in place before participants are sent there.'
  )) as HTMLInputElement;
};

/** Review's Consent line: its value and whether it is flagged as missing. */
const reviewConsent = () => {
  goToStep('Review');
  const review = screen.getByTestId('review-step');
  const term = within(review).getByText('Consent', { selector: 'dt' });
  const value = term.nextElementSibling as HTMLElement;
  return {
    text: value.textContent ?? '',
    missing: value.classList.contains('validation-error')
  };
};

const lastUpdateBody = () => {
  const calls = vi.mocked(updateOpportunity).mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
};

/** The browser's own exit route - `preventDefault` means "ask first". */
const leavingWouldAsk = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(updateOpportunity).mockResolvedValue({ id: 'opp-1' } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saving the external consent affirmation', () => {
  it('a ticked box on a never-recorded draft saves true', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(EXTERNAL_ROW() as never);
    renderEdit();
    await awaitLoaded();

    fireEvent.click(await consentCheckbox());
    goToStep('Review');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());
    expect(lastUpdateBody().external_consent_confirmed).toBe(true);
  });

  it('unticking a stored true saves an explicit false', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ external_consent_confirmed: true }) as never
    );
    renderEdit();
    await awaitLoaded();

    fireEvent.click(await consentCheckbox());
    goToStep('Review');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());
    expect(lastUpdateBody().external_consent_confirmed).toBe(false);
  });

  it('an unrelated save on a never-recorded published study leaves it unrecorded', async () => {
    // Sending false here would turn "never recorded" into "the author said no"
    // for every legacy study that is merely re-saved.
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ status: 'published' }) as never
    );
    renderEdit();
    await awaitLoaded();

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'One question with a new title' }
    });
    goToStep('Review');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());
    for (const call of vi.mocked(updateOpportunity).mock.calls) {
      const body = call[1] as Record<string, unknown>;
      expect(Object.keys(body)).not.toContain('external_consent_confirmed');
      expect(body.title).toBe('One question with a new title');
    }
  });
});

describe('loading the external consent affirmation', () => {
  it('a stored true on a draft loads ticked and Review says the author confirmed it', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ external_consent_confirmed: true }) as never
    );
    renderEdit();
    await awaitLoaded();

    expect((await consentCheckbox()).checked).toBe(true);
    const review = reviewConsent();
    expect(review.text).toContain('confirmed by the author');
    expect(review.missing).toBe(false);
  });

  it('a stored false on a published study loads unticked and Review says not yet confirmed', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ status: 'published', external_consent_confirmed: false }) as never
    );
    renderEdit();
    await awaitLoaded();

    expect((await consentCheckbox()).checked).toBe(false);
    const review = reviewConsent();
    expect(review.text).toContain('Not yet confirmed');
    expect(review.missing).toBe(true);
  });

  it('a stored null on a draft loads unticked and Review says not yet confirmed', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(EXTERNAL_ROW() as never);
    renderEdit();
    await awaitLoaded();

    expect((await consentCheckbox()).checked).toBe(false);
    const review = reviewConsent();
    expect(review.text).toContain('Not yet confirmed');
    expect(review.missing).toBe(true);
  });

  it('a stored null on a published study loads unticked and Review stays neutral', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ status: 'published' }) as never
    );
    renderEdit();
    await awaitLoaded();

    expect((await consentCheckbox()).checked).toBe(false);
    const review = reviewConsent();
    expect(review.text).toContain('Handled by the external tool');
    expect(review.text).not.toContain('confirmed by the author');
    expect(review.missing).toBe(false);
  });
});

describe('the dirty check right after loading the affirmation', () => {
  it('a stored true does not read as unsaved work on load', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ status: 'published', external_consent_confirmed: true }) as never
    );
    renderEdit();
    await awaitLoaded();

    expect(leavingWouldAsk()).toBe(false);
  });

  it('a stored false does not read as unsaved work on load', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ status: 'published', external_consent_confirmed: false }) as never
    );
    renderEdit();
    await awaitLoaded();

    expect(leavingWouldAsk()).toBe(false);
  });

  it('a stored null does not read as unsaved work on load', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ status: 'published' }) as never
    );
    renderEdit();
    await awaitLoaded();

    expect(leavingWouldAsk()).toBe(false);
  });

  it('the control: ticking the box after load does read as unsaved work', async () => {
    // Proves the instrument can see this field at all - without it the three
    // clean-on-load assertions above pass just as well against a dirty check
    // that ignores the affirmation entirely.
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ status: 'published' }) as never
    );
    renderEdit();
    await awaitLoaded();

    fireEvent.click(await consentCheckbox());
    expect(leavingWouldAsk()).toBe(true);
  });
});
