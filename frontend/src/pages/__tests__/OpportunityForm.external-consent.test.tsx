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

/** The External Link box, on the same step as the affirmation. */
const linkInput = async () => {
  goToStep('Your link');
  return (await screen.findByLabelText('External Link *')) as HTMLInputElement;
};

/** Type a whole URL into the link box, as one edit. */
const typeLink = async (url: string) => {
  fireEvent.change(await linkInput(), { target: { value: url } });
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

/**
 * REVIEW READS THE STORED STATUS, NOT THE ONE BEING CHOSEN RIGHT NOW.
 *
 * The neutral "Published before Cortex recorded this confirmation" line is an
 * amnesty for the past: studies that were ALREADY live when the column arrived
 * could not have had a box ticked that did not exist, so Review declines to
 * flag them. It is keyed on `publishedWhenLoaded`.
 *
 * Feed it the LIVE status instead and the amnesty covers the present. An
 * author opens a never-recorded draft, sets Status to Published without
 * ticking, and Review drops the nag and explains that the study was published
 * before Cortex recorded the confirmation - about a study being published for
 * the first time, in this session, seconds from now.
 *
 * The pure review-summary tests cannot see this: they take
 * `publishedWhenLoaded` as an argument and are green whichever value the page
 * passes. The wiring is in the page, so the test has to be too.
 */
describe('the Review consent line while the author is publishing', () => {
  const statusControl = () => screen.getByRole('combobox', { name: 'Status' });

  it('a never-recorded draft set to Published still reads not yet confirmed', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(EXTERNAL_ROW() as never);
    renderEdit();
    await awaitLoaded();

    expect(reviewConsent().text).toContain('Not yet confirmed');

    goToStep('Review');
    fireEvent.change(statusControl(), { target: { value: 'published' } });
    expect(statusControl()).toHaveValue('published');

    const review = reviewConsent();
    expect(review.text).toContain('Not yet confirmed');
    expect(review.text).not.toContain('Handled by the external tool');
    expect(review.missing).toBe(true);
  });

  it('a never-recorded draft set to Published and then ticked names the author', async () => {
    // The control. Without it the assertion above passes just as well against
    // a Review line that has stopped reacting to this field at all.
    vi.mocked(getOpportunity).mockResolvedValue(EXTERNAL_ROW() as never);
    renderEdit();
    await awaitLoaded();

    goToStep('Review');
    fireEvent.change(statusControl(), { target: { value: 'published' } });
    fireEvent.click(await consentCheckbox());

    const review = reviewConsent();
    expect(review.text).toContain('confirmed by the author');
    expect(review.missing).toBe(false);
  });
});

/**
 * THE SAVE CHANGES BUTTON ON THE FIRST STEPS.
 *
 * `hasUnsavedWork()` is `hasChanges() || hasUnsavedChanges(...)`, and the
 * second half is spread-based, so the exit warning sees this field with or
 * without the `hasChanges` clause - the beforeunload control in the block
 * below is satisfied by the signature alone and cannot kill a mutation on it.
 *
 * The clause's real job is the one asserted here: `hasChanges()` ALONE gates
 * `onSave` on the step footers, so an author who ticks the box and changes
 * nothing else gets a Save Changes button on the first two steps rather than
 * being told they have unsaved work with no way to save it. That is the same
 * disagreement the roles/skills chips had (9bb3164e on main), pinned the same
 * way: both halves in one test, because either half alone passes against it.
 */
describe('the Save Changes button when only the affirmation changed', () => {
  const goToBasicInfo = () =>
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Form steps' })).getAllByRole(
        'button'
      )[1]
    );

  it('appears on the first steps when only the box was ticked, and the exit warning agrees', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(EXTERNAL_ROW() as never);
    renderEdit();
    await awaitLoaded();

    fireEvent.click(await consentCheckbox());

    // Back to Basic Information, which is where the author is standing when
    // the button goes missing - Your link is not one of the first two steps.
    goToBasicInfo();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    // The other half of the disagreement, asserted alongside it.
    expect(leavingWouldAsk()).toBe(true);
  });

  it('stays away on the first steps when a stored affirmation is opened and nothing is touched', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ external_consent_confirmed: true }) as never
    );
    renderEdit();
    await awaitLoaded();

    goToBasicInfo();
    expect(
      screen.queryByRole('button', { name: 'Save Changes' })
    ).not.toBeInTheDocument();

    // Unticking the stored true does offer one, so the control above is not
    // simply a button that never renders on this step.
    fireEvent.click(await consentCheckbox());
    goToBasicInfo();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
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

/**
 * REPOINTING THE STUDY CLEARS THE TICK, IN FRONT OF THE AUTHOR.
 *
 * The affirmation is about ONE destination. The backend resets the column on a
 * relink, and that reset was unreachable from this form: `buildSavePayload`
 * gates the link and the affirmation on the SAME `externalLink` step and sends
 * the affirmation whenever the hydrated value is a boolean, so a relink saved
 * from here carried the new link AND the stale `true`, which the deliberate-
 * re-affirmation exception then honoured. Verbatim, against real Postgres:
 * `stored=true link=https://tool-b...`.
 *
 * No test changed the link and looked at what happened to the tick, so the arm
 * that would have caught it was never planned. These are that arm: the
 * checkbox the author is looking at, and the body that leaves the form.
 *
 * The clear only ever clears. Typing the stored link back within one session
 * leaves the tick off and the author re-ticks - pinned below, because
 * restoring it would mean re-ticking a box on the author's behalf, which is
 * the thing this fix exists to stop.
 */
describe('repointing the study at a different external tool', () => {
  const TOOL_B = 'https://tool-b.example.com/survey';

  it('clears the tick as soon as the author edits the link', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ external_consent_confirmed: true }) as never
    );
    renderEdit();
    await awaitLoaded();

    expect((await consentCheckbox()).checked).toBe(true);

    await typeLink(TOOL_B);

    expect((await consentCheckbox()).checked).toBe(false);
    expect((await linkInput()).value).toBe(TOOL_B);
  });

  it('sends the new link and no affirmation when the author does not re-tick', async () => {
    // The payload half of the same bug. Before the clear, this body carried
    // `external_consent_confirmed: true` beside the new link and the server's
    // reset stood down for it.
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ external_consent_confirmed: true }) as never
    );
    renderEdit();
    await awaitLoaded();

    await typeLink(TOOL_B);
    goToStep('Review');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());
    const body = lastUpdateBody();
    expect(body.external_link_optional).toBe(TOOL_B);
    expect(Object.keys(body)).not.toContain('external_consent_confirmed');
  });

  it('sends true beside the new link when the author re-ticks for it', async () => {
    // The control, and the one correct way to relink. Without it the arm above
    // passes just as well against a form that has stopped sending the field.
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({ external_consent_confirmed: true }) as never
    );
    renderEdit();
    await awaitLoaded();

    await typeLink(TOOL_B);
    fireEvent.click(await consentCheckbox());
    expect((await consentCheckbox()).checked).toBe(true);

    goToStep('Review');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());
    const body = lastUpdateBody();
    expect(body.external_link_optional).toBe(TOOL_B);
    expect(body.external_consent_confirmed).toBe(true);
  });

  it('treats a stored link holding stray whitespace as the same tool when it is retyped bare', async () => {
    // The form normalises the way the server does - the PATCH column loop
    // stores every string trimmed - so a stray space is not a different tool.
    //
    // MEASURED, because the obvious arm cannot fail: typing a PADDED value
    // into the box does not exercise the trim at all. `external_link_optional`
    // is an `<input type="url">`, whose value sanitisation strips surrounding
    // whitespace before React's onChange ever runs - probed in jsdom, which
    // handed the handler `"https://a.example.com/x"` for an input of
    // `"  https://a.example.com/x  "`. A test that pads the box therefore
    // passes with the trim removed. The reachable side is the STORED one: a
    // row written before the column loop trimmed hydrates padded, and retyping
    // the same URL bare must not read as a relink.
    const bare = 'https://forms.example.com/one-question';
    vi.mocked(getOpportunity).mockResolvedValue(
      EXTERNAL_ROW({
        external_consent_confirmed: true,
        external_link_optional: `  ${bare}  `
      }) as never
    );
    renderEdit();
    await awaitLoaded();

    await typeLink(bare);

    expect((await consentCheckbox()).checked).toBe(true);
  });

  it('leaves the tick off when the author types the stored link back in the same session', async () => {
    // KNOWN AND DELIBERATE. The clear never un-clears, so an edit away and
    // back costs the author one re-tick. What the save does in that state is
    // the part that matters and is asserted here: the link is unchanged, the
    // affirmation key is omitted, so the stored `true` - which was made about
    // this very link - survives on the row.
    const stored = EXTERNAL_ROW({ external_consent_confirmed: true });
    vi.mocked(getOpportunity).mockResolvedValue(stored as never);
    renderEdit();
    await awaitLoaded();

    await typeLink(TOOL_B);
    await typeLink(stored.external_link_optional);

    expect((await consentCheckbox()).checked).toBe(false);

    goToStep('Review');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled());
    const body = lastUpdateBody();
    expect(body.external_link_optional).toBe(stored.external_link_optional);
    expect(Object.keys(body)).not.toContain('external_consent_confirmed');
  });

  it('does not clear a tick the author never had, and offers a save either way', async () => {
    // The dirty check after a relink, and the null case: clearing null is a
    // no-op, and the link change alone must still offer Save Changes on the
    // first steps rather than leaving the author with unsaved work and no
    // button.
    vi.mocked(getOpportunity).mockResolvedValue(EXTERNAL_ROW() as never);
    renderEdit();
    await awaitLoaded();

    await typeLink(TOOL_B);

    expect((await consentCheckbox()).checked).toBe(false);
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Form steps' })).getAllByRole(
        'button'
      )[1]
    );
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    expect(leavingWouldAsk()).toBe(true);
  });
});
