import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import OpportunityForm from '../OpportunityForm';
import { opportunityFormRoutes } from '../OpportunityForm.routes';
import {
  createOpportunity,
  deleteOpportunity,
  getOpportunity,
  updateOpportunity
} from '../../api/client';
import { getFirstHandStudy } from '../../api/firsthand-studies';
import { AUTOSAVE_MIN_INTERVAL_MS } from '../../lib/opportunity-authoring/autosave';

/**
 * The autosave as an author meets it.
 *
 * The timing RULES are asserted as arithmetic in
 * `lib/opportunity-authoring/__tests__/autosave.test.ts`, where a clock is an
 * argument rather than a thing to be faked. What can only be tested here is
 * the wiring: that the first save is a create and the second is not, that the
 * URL is rewritten so a refresh recovers, that nothing is sent before the
 * server would accept it, and that the sentence on screen matches what has
 * actually been stored.
 *
 * Real timers, deliberately. The debounce is two seconds and these tests wait
 * it out, which makes them slow and makes them about the product. Faking the
 * clock here would test the fake.
 */

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin' },
    loading: false
  })
}));
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false })
}));
vi.mock('../../components/AdminSessionManager', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  createOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  deleteOpportunity: vi.fn(),
  getOpportunity: vi.fn(),
  getSessions: vi.fn().mockResolvedValue([]),
  getFirstHandStudies: vi.fn().mockResolvedValue([])
}));

vi.mock('../../api/firsthand-studies', async (importActual) => ({
  ...(await importActual<typeof import('../../api/firsthand-studies')>()),
  getFirstHandStudy: vi.fn()
}));

/**
 * Long enough for a two-second debounce plus a render, and named so the number
 * is not scattered across a dozen assertions where nobody could retune it.
 */
const PAST_THE_DEBOUNCE = 3_500;

/**
 * The router's OWN idea of where the form is.
 *
 * Asserted through this rather than through `window.location`, because a
 * `history.replaceState` the router never saw would satisfy the second while
 * leaving every later `navigate` computing a base path from an address that no
 * longer matches any route.
 */
const LocationProbe: React.FC = () => (
  <span data-testid="location">{useLocation().pathname}</span>
);

const renderCreateForm = () =>
  render(
    <MemoryRouter initialEntries={['/admin/opportunities/new']}>
      <LocationProbe />
      <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
    </MemoryRouter>
  );

/** The visible sentence, scoped so the live-region twin is not also matched. */
const saveStateText = () => screen.getByTestId('autosave-state').textContent ?? '';

const draftOpportunity = {
  id: 'opp-1',
  type: 'survey',
  title: 'Developer experience pulse',
  purpose_one_liner: 'Ten short questions about the tools you use every day',
  description_optional: '',
  product_optional: '',
  meeting_location_optional: '',
  default_duration_minutes: 30,
  status: 'draft',
  delivery_mode: 'external',
  participant_type_required: 'any',
  owner_user_id: 'admin-1',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  sessions: []
};

const publishedOpportunity = { ...draftOpportunity, status: 'published' };

/** A native survey draft whose questions live in a linked study. */
const surveyDraft = {
  ...draftOpportunity,
  id: 'opp-2',
  delivery_mode: 'native',
  firsthand_study_id: 'study_questions'
};

const storedStudy = (updatedAt: string) => ({
  study: {
    id: 'study_questions',
    title: 'Developer experience pulse',
    intro_text: 'Intro',
    consent_text: 'Answers are stored for research analysis',
    kind: 'survey',
    status: 'launched',
    owner_user_id: 'admin-1',
    updated_at: updatedAt
  },
  steps: [
    {
      step_id: 'study_questions_q-one',
      order: 1,
      type: 'open_text',
      prompt: 'Which tool slows you down?'
    },
    { step_id: 'study_questions_step_end', order: 2, type: 'end', prompt: 'Thanks' }
  ],
  can_edit: true,
  answer_counts: {}
});

const renderSurveyDraft = () => {
  vi.mocked(getOpportunity).mockResolvedValue(surveyDraft as never);
  vi.mocked(getFirstHandStudy).mockResolvedValue(
    storedStudy('2026-08-19T09:30:00.000Z') as never
  );
  return render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-2/edit']}>
      <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
    </MemoryRouter>
  );
};

const renderEditForm = (opportunity: Record<string, unknown> = draftOpportunity) => {
  vi.mocked(getOpportunity).mockResolvedValue(opportunity as never);
  return render(
    <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
      <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
    </MemoryRouter>
  );
};

/** Fill step one to the point the create schema would accept it. */
const fillCreateThreshold = () => {
  fireEvent.change(screen.getByLabelText(/Research Study Type/i), {
    target: { value: 'survey' }
  });
  fireEvent.change(screen.getByLabelText(/^Title/i), {
    target: { value: 'Developer experience pulse' }
  });
  fireEvent.change(screen.getByLabelText(/^Purpose/i), {
    target: { value: 'Ten short questions about the tools you use' }
  });
};

/**
 * Walk forward to Review, whatever step the form is currently showing.
 *
 * Status (#111) only renders there now, so any test that needs to change it
 * has to arrive first - a no-op if Review is already on screen, since the
 * loop only clicks a `Continue: ` control when one exists.
 */
const goToReview = () => {
  for (let guard = 0; guard <= 6; guard += 1) {
    const forward = screen.queryByRole('button', { name: /^Continue: /i });
    if (!forward) return;
    fireEvent.click(forward);
  }
  throw new Error('goToReview never reached a step with no forward control');
};

/**
 * Choose Status from Review.
 *
 * Review has no `<label htmlFor="status">` any more - only an
 * `<h3>Status</h3>` heading (see `git show 1b744f5 -- BasicInfoTab.tsx` for
 * the label it used to carry) - so it is the one `<select>` Review renders,
 * found by role rather than by name.
 */
const setStatus = (status: 'draft' | 'published') => {
  goToReview();
  fireEvent.change(within(screen.getByTestId('review-step')).getByRole('combobox'), {
    target: { value: status }
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(createOpportunity).mockResolvedValue({ id: 'opp-new' } as never);
  vi.mocked(updateOpportunity).mockResolvedValue({ id: 'opp-1' } as never);
  vi.mocked(deleteOpportunity).mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the create threshold gates the first write', () => {
  /**
   * The rule the plan states first, and the reason it exists: the create
   * schema requires a type, a four-character title and a ten-character
   * purpose, so anything sent before those exist comes back 400 - reported to
   * the author as a failure to save, at the moment they had typed three
   * letters.
   */
  it('sends nothing at all while the form is below the threshold', async () => {
    renderCreateForm();

    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Dev' } });

    await new Promise((resolve) => setTimeout(resolve, PAST_THE_DEBOUNCE));
    expect(createOpportunity).not.toHaveBeenCalled();
  }, 15_000);

  it('says why, rather than showing a save state that is not true', async () => {
    renderCreateForm();

    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Dev' } });

    await waitFor(() =>
      expect(saveStateText()).toMatch(
        /Your work will be saved once you have given this a title and a purpose/i
      )
    );
  });

  it('creates a draft once the threshold is met', async () => {
    renderCreateForm();
    fillCreateThreshold();

    await waitFor(() => expect(createOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });
  });

  /**
   * The rule the plan puts in capitals. Asserted on the body that crosses the
   * wire, not on the form's state.
   */
  it('creates it as a draft, never as published', async () => {
    renderCreateForm();
    fillCreateThreshold();

    await waitFor(() => expect(createOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE
    });

    const body = vi.mocked(createOpportunity).mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(body.status).toBe('draft');
  });
});

describe('a sequence of autosaves', () => {
  /**
   * THE exit criterion, in the only place a component test can observe it: the
   * second save must be an update against the row the first one created.
   *
   * A form that read its id from the route alone would POST again on every
   * pass, minting an opportunity per save - and every one of those calls would
   * look like an ordinary success.
   */
  it('creates once and updates thereafter, however many times it saves', async () => {
    renderCreateForm();
    fillCreateThreshold();

    await waitFor(() => expect(createOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Developer experience pulse v2' }
    });
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE * 2
    });

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Developer experience pulse v3' }
    });
    await waitFor(
      () => expect(vi.mocked(updateOpportunity).mock.calls.length).toBeGreaterThan(1),
      { timeout: PAST_THE_DEBOUNCE * 2 }
    );

    // The whole point: still exactly one create.
    expect(createOpportunity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateOpportunity).mock.calls[0][0]).toBe('opp-new');
  }, 30_000);

  /**
   * The SECOND edit debounces too, which sounds too obvious to test and was
   * the one real defect a real browser found in this feature.
   *
   * The change time was recorded in an effect, and an effect runs a render
   * AFTER the one that first sees the change. On the first edit following a
   * save, the decision on that render therefore read the PREVIOUS change time
   * - minutes old - found the debounce long expired, and saved on the first
   * keystroke. Measured at 39ms after a single keystroke in Chrome.
   *
   * Nothing in this file caught it, because every other test here makes one
   * change and waits. The shape that exposes it is change, save, change again.
   */
  it('debounces the edit after a save, not just the first one', async () => {
    renderEditForm(draftOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'First edit' }
    });
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });

    /**
     * Wait out the INTERVAL FLOOR before touching anything.
     *
     * Without this pause the test passes with the defect reinstated, and the
     * reason is worth recording: the floor since the last request is a second,
     * independent clock, and immediately after a save it has four seconds left
     * to run - so it holds the save back whatever the debounce thinks, and the
     * bug hides behind it. The browser saw the defect precisely because its
     * previous request was minutes old and the debounce was the only thing
     * left standing.
     *
     * A test that cannot fail is worse than no test, and this one could not
     * until it waited.
     */
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_MIN_INTERVAL_MS + 500));

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Second edit' }
    });

    // Half a debounce later there must still be nothing new in flight. A save
    // that went out here went out on the keystroke.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(updateOpportunity).toHaveBeenCalledTimes(1);
  }, 25_000);

  /**
   * The URL rewrite, which is what makes a refresh recover the draft rather
   * than open an empty form.
   *
   * Asserted through the router's own location rather than through
   * `window.location`, because a `history.replaceState` that the router never
   * saw would pass the second and leave the next `navigate` computing a base
   * path from an address that no longer exists.
   */
  it('rewrites the URL to the draft, so a refresh recovers it', async () => {
    renderCreateForm();
    fillCreateThreshold();

    await waitFor(() => expect(createOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE
    });

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/admin/opportunities/opp-new/edit'
      )
    );
  });

  /**
   * ...and rewriting it must not move the author.
   *
   * `isEdit` is `Boolean(id)`, so the rewrite above flips it from false to
   * true. A `useEffect` keyed on `[isEdit, opportunityId, formData.type]` then
   * fired and sent the author back to the first step - two seconds after they
   * started, mid-sentence, with no message and nothing to undo. An author who
   * walked on to Content & Details while the debounce ran simply lost their
   * place, and every save after that was fine, so it read as a glitch.
   *
   * Asserted on the step the author is STANDING on, not on the URL: the test
   * above already pins the address, and a form that rewrote the address
   * correctly and threw the author to step 1 would pass it.
   *
   * The same effect had a second symptom - an author who clicked a step in the
   * window between the content arriving and the effect running had that click
   * silently undone, which is what made the answer-counts spec flaky at
   * roughly 3%. Both are fixed by choosing the landing step in
   * `loadOpportunity`, in the same batch as the content, so no later render
   * can move anyone.
   */
  it('does not move the author off the step they are on when it rewrites', async () => {
    renderCreateForm();
    fillCreateThreshold();

    // Walk on, as an author who keeps working while the 2s debounce runs.
    fireEvent.click(await screen.findByRole('button', { name: /^Continue: / }));
    // The TITLE of the step, not the button's whole textContent: that ends in
    // the status word, and `needsAttention` outranks `current`, so the same
    // button can read "...Current step" before and "...Needs attention" after
    // without the author having moved. A spurious failure in a test whose whole
    // purpose is killing a flake would be a poor joke. `getByRole` with
    // `current: 'step'` already guarantees there is exactly one.
    const standingOn = () => {
      const strip = screen.getByRole('navigation', { name: 'Form steps' });
      return (
        within(strip).getByRole('button', { current: 'step' }).textContent ?? ''
      ).replace(/(Current step|Completed|Needs attention|Not started)$/, '');
    };
    const before = standingOn();
    expect(before).toMatch(/Content & Details/);

    await waitFor(() => expect(createOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/admin/opportunities/opp-new/edit'
      )
    );

    expect(standingOn()).toBe(before);
  }, 15_000);

  /**
   * ...and neither must the re-read that a deliberate save performs.
   *
   * The first version of this fix moved the defect rather than removing it. The
   * landing is applied once per opportunity, keyed on a ref - but nothing on the
   * autosave create path set that ref, because the load EFFECT skips an id this
   * session minted (`selfCreatedIdRef`, which exists to avoid discarding
   * keystrokes). So the ref was still null when the author's first manual save
   * called `loadOpportunity()` directly, and the landing fired then instead:
   * press Save on Review, land on Basic Information.
   *
   * That was WORSE than the bug it replaced, because pressing Save is
   * deliberate. It is also a regression against the base - this test passes on
   * the commit before the fix, where the effect's deps simply never changed on
   * a save.
   *
   * `getOpportunity` is mocked here on purpose: create-flow tests leave it an
   * unresolved `vi.fn()`, so the re-read silently does nothing and a probe
   * without this mock reports success while exercising none of the path.
   */
  it('does not move the author when a deliberate save re-reads the draft', async () => {
    renderCreateForm();
    fillCreateThreshold();

    await waitFor(() => expect(createOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });

    // Walk to the end, as an author finishing the job before they save.
    for (let guard = 0; guard < 6; guard += 1) {
      const forward = screen.queryByRole('button', { name: /^Continue: /i });
      if (!forward) break;
      fireEvent.click(forward);
    }
    const standingOn = () => {
      const strip = screen.getByRole('navigation', { name: 'Form steps' });
      return (
        within(strip).getByRole('button', { current: 'step' }).textContent ?? ''
      ).replace(/(Current step|Completed|Needs attention|Not started)$/, '');
    };
    const before = standingOn();
    expect(before).toMatch(/Review/);

    vi.mocked(getOpportunity).mockResolvedValue({
      ...draftOpportunity,
      id: 'opp-new'
    } as never);

    fireEvent.click(screen.getByRole('button', { name: /^Save changes$/i }));
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled(), {
      timeout: 8_000
    });
    // The re-read itself, not just the write - the landing rides on the re-read.
    await waitFor(() => expect(getOpportunity).toHaveBeenCalled(), {
      timeout: 8_000
    });

    expect(standingOn()).toBe(before);
  }, 25_000);

  /**
   * The keystrokes typed while the create request was in flight.
   *
   * Rewriting the URL makes the route id appear, and the load effect would
   * otherwise rebuild the whole form from the server - discarding them. The
   * server has nothing to teach us about a row we wrote a moment ago.
   */
  it('does not reload the form over the top of what the author is typing', async () => {
    renderCreateForm();
    fillCreateThreshold();

    await waitFor(() => expect(createOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE
    });

    expect(getOpportunity).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Title/i)).toHaveValue('Developer experience pulse');
  });
});

describe('what the author is told', () => {
  it('reports the save once it has happened', async () => {
    renderCreateForm();
    fillCreateThreshold();

    await waitFor(() => expect(saveStateText()).toMatch(/^Saved /), {
      timeout: PAST_THE_DEBOUNCE
    });
  });

  /**
   * A backend that is not answering. The author is told, and told again when
   * it stops trying - never left with a form that looks saved.
   */
  /**
   * A 4xx is a REFUSAL, not a failure. It will not fix itself, so retrying it
   * four more times spends the shared write budget for nothing and ends by
   * saying "Unable to save" with no reason - while the server sent one.
   *
   * Reachable without doing anything strange: change the type of a draft that
   * already has a linked study and every save is a 400 naming a vocabulary
   * mismatch the author could act on if they were shown it.
   */
  it('repeats the server\'s reason for a refusal, and does not retry it', async () => {
    vi.mocked(createOpportunity).mockRejectedValue({
      response: {
        status: 400,
        data: { error: 'Only polls, surveys and one-question opportunities can carry questions' }
      }
    });

    renderCreateForm();
    fillCreateThreshold();

    await waitFor(() => expect(createOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });
    await waitFor(() =>
      expect(saveStateText()).toMatch(/Only polls, surveys and one-question opportunities can carry questions/i)
    );

    // Long enough for four more backoff attempts, had there been any.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect(createOpportunity).toHaveBeenCalledTimes(1);
  }, 25_000);

  it('says it is retrying when a save fails', async () => {
    vi.mocked(createOpportunity).mockRejectedValue({
      response: { status: 500, data: { error: 'nope' } }
    });

    renderCreateForm();
    fillCreateThreshold();

    await waitFor(() => expect(saveStateText()).toMatch(/Unable to save - retrying/i), {
      timeout: PAST_THE_DEBOUNCE
    });
  }, 15_000);
});

describe('what an autosave refuses to do', () => {
  /**
   * A live opportunity is not edited on a timer.
   *
   * A researcher rewording a question on a published study would otherwise
   * have that wording reach participants two seconds later, mid-session, with
   * nobody having pressed anything - and some of them would already have
   * answered the previous wording, which nothing records.
   */
  it('leaves a published opportunity alone', async () => {
    renderEditForm(publishedOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Developer experience pulse v2' }
    });

    await new Promise((resolve) => setTimeout(resolve, PAST_THE_DEBOUNCE));
    expect(updateOpportunity).not.toHaveBeenCalled();
  }, 15_000);

  /**
   * "Drafts only" means the STORED status, and on a draft this session created
   * there is no loaded row to read it from.
   *
   * An independent mutation pass replaced the stored-status read with the
   * form's own and every frontend test passed. The consequence is on the path
   * this feature creates: fill step one, let the timer create the draft, then
   * choose Published before saving. Reading the form's status switches
   * autosave off there and then - the save-state line, the Discard control and
   * the timer all vanish at once, and everything typed after that is unsaved
   * with nothing on screen saying so.
   *
   * The stored status is still `draft`, because a create says draft whatever
   * the form is set to, so the timer must stay on and say that the status
   * change is the part it will not carry.
   */
  it('keeps autosaving a draft it created after the author picks Published', async () => {
    renderCreateForm();
    fillCreateThreshold();
    await waitFor(() => expect(createOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE
    });

    setStatus('published');

    // Still reporting, rather than having disappeared - and naming the one
    // thing it cannot carry.
    await waitFor(() =>
      expect(saveStateText()).toMatch(/changing the status is saved when you press Save/i)
    );
  }, 20_000);

  it('shows no save state on a published opportunity, rather than a misleading one', async () => {
    renderEditForm(publishedOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    // CHANGE something first. Written without this it passed for the wrong
    // reason: an untouched form has nothing to report either way, so the
    // assertion held even with the draft-only rule removed entirely. A
    // mutation proved it - the twin above caught that change and this one did
    // not.
    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Developer experience pulse v2' }
    });

    await new Promise((resolve) => setTimeout(resolve, PAST_THE_DEBOUNCE));
    expect(screen.queryByTestId('autosave-state')).toBeNull();
  }, 15_000);

  /**
   * A draft IS autosaved, which is the other half of the same claim - without
   * this the test above passes for a form that never autosaves anything.
   */
  it('does autosave a draft, so the rule above is about status and not about editing', async () => {
    renderEditForm(draftOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Developer experience pulse v2' }
    });

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE
    });
  });

  /**
   * An edit says nothing about status, so it can neither publish nor
   * unpublish. Omission is the only value that leaves the author's own
   * decision alone.
   */
  it('never carries a status on an update', async () => {
    renderEditForm(draftOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Developer experience pulse v2' }
    });

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE
    });

    const body = vi.mocked(updateOpportunity).mock.calls[0][1] as unknown as Record<
      string,
      unknown
    >;
    expect('status' in body).toBe(false);
  });
});

describe('the concurrency precondition across a sequence of saves', () => {
  /**
   * The CLIENT half of the whole reason the backend change exists, and nothing
   * else in this repository asserts it.
   *
   * A successful save moves the study's `updated_at`, so the revision the form
   * loaded with is spent the moment its own first save commits. The response
   * carries the new one; if the form does not adopt it, the SECOND autosave
   * arrives with a revision the first has already spent, is refused 409, and
   * shows a conflict banner blaming a colleague who does not exist - on every
   * save from then on.
   *
   * Written after noticing that `adoptStudyRevision` could be deleted outright
   * with every other test in this repository still green.
   */
  it('sends the revision the previous save returned, not the one it loaded with', async () => {
    vi.mocked(updateOpportunity).mockResolvedValue({
      id: 'opp-2',
      linked_study_updated_at: '2026-08-21T18:30:00.000Z'
    } as never);

    renderSurveyDraft();
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'First edit' } });
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });

    const first = vi.mocked(updateOpportunity).mock.calls[0][1] as unknown as Record<
      string,
      unknown
    >;
    // The first save carries what the form was served at load.
    expect(first.expected_study_updated_at).toBe('2026-08-19T09:30:00.000Z');

    // Past the interval floor, so the second save is held by nothing but its
    // own debounce.
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_MIN_INTERVAL_MS + 500));

    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Second edit' } });
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(2), {
      timeout: PAST_THE_DEBOUNCE
    });

    const second = vi.mocked(updateOpportunity).mock.calls[1][1] as unknown as Record<
      string,
      unknown
    >;
    expect(second.expected_study_updated_at).toBe('2026-08-21T18:30:00.000Z');
    expect(second.expected_study_updated_at).not.toBe('2026-08-19T09:30:00.000Z');
  }, 30_000);

  /**
   * A save that wrote no study says nothing about one, and the form must KEEP
   * the precondition it holds rather than reading silence as "there is no
   * study" and dropping it. A dropped precondition writes under F1's
   * fail-open, silently.
   */
  it('keeps its precondition when a response says nothing about a study', async () => {
    vi.mocked(updateOpportunity).mockResolvedValue({ id: 'opp-2' } as never);

    renderSurveyDraft();
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'First edit' } });
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });

    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_MIN_INTERVAL_MS + 500));

    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'Second edit' } });
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(2), {
      timeout: PAST_THE_DEBOUNCE
    });

    const second = vi.mocked(updateOpportunity).mock.calls[1][1] as unknown as Record<
      string,
      unknown
    >;
    expect(second.expected_study_updated_at).toBe('2026-08-19T09:30:00.000Z');
  }, 30_000);
});

describe('a deliberate save that overlaps an autosave', () => {
  /**
   * The duplicate row. Raised by the code-review gate and reproduced here
   * before being fixed.
   *
   * `handleSubmit` awaits the in-flight autosave, but everything it reads
   * afterwards was captured when the click handler was bound - awaiting does
   * not re-read a render-scope const. So a Save pressed while the very first
   * autosave is still creating the draft resumes believing nothing has been
   * created, and creates a SECOND opportunity. If the form was authoring
   * content, that is a second study too, orphaned and invisible.
   */
  it('does not create a second opportunity when Save lands during the first autosave', async () => {
    let releaseCreate: (value: unknown) => void = () => {};
    vi.mocked(createOpportunity).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate = () => resolve({ id: 'opp-new' } as never);
        }) as never
    );

    renderCreateForm();
    fillCreateThreshold();

    // The autosave is now in flight and cannot settle until we let it.
    await waitFor(() => expect(createOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });

    // The author presses Save and exit while it is still out.
    fireEvent.click(screen.getByRole('button', { name: /Save and exit/i }));
    releaseCreate(null);

    // Give the resumed handler every chance to send its own create.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(createOpportunity).toHaveBeenCalledTimes(1);
  }, 20_000);

  /**
   * The same root cause, one step later and far more reachable: the precondition
   * the resumed handler sends is the one it captured, not the one the autosave
   * just learned. The author is shown a conflict naming a colleague who is
   * themselves.
   */
  it('sends the revision the overlapping autosave learned, not the captured one', async () => {
    let releaseUpdate: (value: unknown) => void = () => {};
    vi.mocked(updateOpportunity).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseUpdate = () =>
            resolve({
              id: 'opp-2',
              linked_study_updated_at: '2026-08-21T18:30:00.000Z'
            } as never);
        }) as never
    );
    vi.mocked(updateOpportunity).mockResolvedValue({ id: 'opp-2' } as never);

    renderSurveyDraft();
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'First edit' } });
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });

    fireEvent.click(screen.getByRole('button', { name: /Save and exit/i }));
    releaseUpdate(null);

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(2), {
      timeout: PAST_THE_DEBOUNCE * 2
    });

    const deliberate = vi.mocked(updateOpportunity).mock.calls[1][1] as unknown as Record<
      string,
      unknown
    >;
    expect(deliberate.expected_study_updated_at).toBe('2026-08-21T18:30:00.000Z');
  }, 20_000);
});

describe('the baseline a save measures "did this change" against', () => {
  /**
   * `delivery_mode` is sent only when it DIFFERS from the baseline, because
   * sending it on every save trips the backend's publish and linkage guards
   * and locks a row out of being repaired. The baseline was the one the LOAD
   * produced - which an autosave never refreshes, while writing to the very
   * row it describes.
   *
   * So: a draft poll stored as `external`, switched to Native (autosave stores
   * native), then switched BACK to External. The second change matches the
   * stale baseline, the key is omitted, and the row stays native - serving a
   * survey to participants when the author asked for a handoff.
   *
   * Raised by the code-review gate; reproduced here before being fixed.
   */
  it('sends delivery_mode back to external after an autosave stored native', async () => {
    vi.mocked(getOpportunity).mockResolvedValue({
      ...draftOpportunity,
      type: 'poll',
      delivery_mode: 'external'
    } as never);
    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-1/edit']}>
        <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
      </MemoryRouter>
    );
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.click(screen.getByLabelText(/In Cortex/i));
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(1), {
      timeout: PAST_THE_DEBOUNCE
    });
    const first = vi.mocked(updateOpportunity).mock.calls[0][1] as unknown as Record<
      string,
      unknown
    >;
    expect(first.delivery_mode).toBe('native');

    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_MIN_INTERVAL_MS + 500));

    fireEvent.click(screen.getByLabelText(/In an external tool/i));
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalledTimes(2), {
      timeout: PAST_THE_DEBOUNCE
    });

    const second = vi.mocked(updateOpportunity).mock.calls[1][1] as unknown as Record<
      string,
      unknown
    >;
    // Omitted here leaves the stored row native for ever.
    expect(second.delivery_mode).toBe('external');
  }, 30_000);
});

describe('what an autosave will not do to somebody\'s answers', () => {
  /**
   * THE most valuable test in this file, and it was missing.
   *
   * !200 puts a save that detaches answers behind a confirmation naming both
   * numbers. Nothing on the server stops the removal - F2's refusal only
   * covers key-less payloads, and the re-meaning check only covers type and
   * config - so `ON DELETE SET NULL` would detach the answers with no dialog,
   * no summary, and nobody having pressed anything, two seconds after the card
   * left the screen.
   *
   * A draft whose study has answers is the ordinary state of a study that was
   * published and then unpublished, so this is not a corner.
   *
   * Raised by the code-review gate, which pointed out that deleting the guard
   * left the whole suite green.
   */
  it('holds rather than removing a question people have answered', async () => {
    vi.mocked(getOpportunity).mockResolvedValue(surveyDraft as never);
    vi.mocked(getFirstHandStudy).mockResolvedValue({
      ...storedStudy('2026-08-19T09:30:00.000Z'),
      answer_counts: { 'q-one': 4 }
    } as never);

    render(
      <MemoryRouter initialEntries={['/admin/opportunities/opp-2/edit']}>
        <Routes>{opportunityFormRoutes(<OpportunityForm />)}</Routes>
      </MemoryRouter>
    );
    await screen.findByDisplayValue('Developer experience pulse');

    // Reach the questions and remove the one that has answers.
    fireEvent.click(await screen.findByRole('button', { name: /Questions/i }));
    const cards = () =>
      screen.queryAllByRole('button', { name: /^Remove question \d+$/ }).length;
    const before = cards();
    fireEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));

    // The per-card confirmation stands in the way and is taken deliberately:
    // the subject here is what the TIMER does with the removal afterwards, not
    // that dialog. Waiting on the COUNT rather than on a name disappearing,
    // because the controls are numbered by position.
    const confirmRemove = screen.queryByRole('button', { name: /^Remove question$/ });
    if (confirmRemove) fireEvent.click(confirmRemove);
    await waitFor(() => expect(cards()).toBe(before - 1));

    await new Promise((resolve) => setTimeout(resolve, PAST_THE_DEBOUNCE));

    expect(updateOpportunity).not.toHaveBeenCalled();
    expect(saveStateText()).toMatch(/removing a question that has answers needs confirming/i);
  }, 20_000);

  /**
   * The other guard in the same function: a question with no prompt yet is the
   * ordinary state of authoring, and sending it would take a 400 the author
   * would read as a failure to save.
   */
  it('holds while a question is still half-typed, and says so rather than failing', async () => {
    renderSurveyDraft();
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.click(await screen.findByRole('button', { name: /Questions/i }));
    await screen.findByRole('button', { name: 'Remove question 1' });
    fireEvent.click(screen.getByRole('button', { name: /^Add question$/i }));

    await new Promise((resolve) => setTimeout(resolve, PAST_THE_DEBOUNCE));

    expect(updateOpportunity).not.toHaveBeenCalled();
    expect(saveStateText()).toMatch(/Not saved - /i);
  }, 20_000);
});

describe('a conflict', () => {
  /**
   * Somebody else wrote the study first. The refusal must not cost the author
   * what is on screen, and the timer must stop rather than retrying into a
   * wall or - worse - advancing past the colleague once it recovered.
   */
  /**
   * BOTH halves of the test, never the status alone.
   *
   * `errorHandler` maps a unique-constraint violation and a lock timeout to
   * 409 as well. Treating one of those as a colleague's write tells the author
   * somebody saved when nobody did - and then arms the overwrite token, so the
   * next save deliberately writes over a colleague who had done nothing until
   * that moment.
   *
   * An independent mutation pass dropped the `stale_study` half of the
   * condition and every frontend test passed.
   */
  it('does not treat a lock-timeout 409 as somebody else saving', async () => {
    vi.mocked(updateOpportunity).mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'Resource is currently locked, please try again', code: 'CONFLICT' }
      }
    });

    renderSurveyDraft();
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), { target: { value: 'First edit' } });
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE
    });

    // A lock timeout is an ordinary failure: the timer treats it as one and
    // says so, rather than reporting a colleague and arming an overwrite.
    await waitFor(() => expect(saveStateText()).toMatch(/Unable to save/i));
    expect(saveStateText()).not.toMatch(/somebody else/i);
  }, 20_000);

  it('is surfaced without discarding local edits, and stops the timer', async () => {
    vi.mocked(getFirstHandStudy).mockResolvedValue({
      study: {
        id: 'study_1',
        title: 'Developer experience pulse',
        kind: 'survey',
        updated_at: '2026-08-21T09:00:00.000Z',
        consent_text: 'Consent',
        owner_user_id: 'admin-1'
      },
      steps: [],
      can_edit: true
    } as never);
    vi.mocked(updateOpportunity).mockRejectedValue({
      response: {
        status: 409,
        data: {
          error: 'stale_study',
          current_updated_at: '2026-08-21T10:00:00.000Z'
        }
      }
    });

    renderEditForm(draftOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Developer experience pulse v2' }
    });

    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE
    });

    // Nothing was thrown away.
    expect(screen.getByLabelText(/^Title/i)).toHaveValue(
      'Developer experience pulse v2'
    );

    // And the timer is not hammering the conflict: no run of retries.
    const afterConflict = vi.mocked(updateOpportunity).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, PAST_THE_DEBOUNCE));
    expect(vi.mocked(updateOpportunity).mock.calls.length).toBe(afterConflict);
  }, 20_000);
});

describe('leaving the form', () => {
  /**
   * Once the timer has saved, leaving loses nothing - so nothing may say it
   * does.
   *
   * The exit confirmation and the unload guard both ask `hasUnsavedWork`,
   * which compares the form against the baseline the LOAD produced. An
   * autosave does not refresh that baseline - deliberately, because declaring
   * that what we sent is now what is stored is the mistake A1 exists to undo -
   * so without a separate answer for the autosaved case the form warns about
   * losing work that is already on the server. An author who is told that
   * every time learns to click through it, which is how the warning stops
   * working on the day it is telling the truth.
   */
  /**
   * The security gate's HIGH: a field the autosave CANNOT send must never be
   * recorded as saved.
   *
   * `forAutosave` deletes `status` on an edit, so the request carries a strict
   * subset of the form - but the signature stamped afterwards was of the whole
   * form. Set Status to Published on a stored draft and the timer fired,
   * carried no status, and then recorded `status: 'published'` as stored: the
   * exit dialog and the unload warning both went away and the line on screen
   * read "Saved 15:42", while the author's publish decision existed nowhere
   * but the tab they were about to close.
   *
   * Worse than the time-slot gap, because `status` is INSIDE the signature -
   * widening the signature cannot reach it.
   */
  it('still warns about a status the timer is not allowed to send', async () => {
    renderEditForm(draftOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    setStatus('published');

    await new Promise((resolve) => setTimeout(resolve, PAST_THE_DEBOUNCE));

    // Whatever the timer did or did not do, the publish decision is not on the
    // server, so leaving must still ask.
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }, 15_000);

  /**
   * And it must not spend the write budget forever trying, either: the delta
   * is a field it will never carry, so every pass would send an identical body
   * and stay dirty.
   */
  it('does not loop trying to save a status it will never carry', async () => {
    renderEditForm(draftOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    setStatus('published');

    await new Promise((resolve) => setTimeout(resolve, 12_000));

    expect(vi.mocked(updateOpportunity).mock.calls.length).toBeLessThanOrEqual(1);
  }, 25_000);

  it('does not claim unsaved work once the timer has saved it', async () => {
    renderEditForm(draftOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.change(screen.getByLabelText(/^Title/i), {
      target: { value: 'Saved by the timer' }
    });
    await waitFor(() => expect(updateOpportunity).toHaveBeenCalled(), {
      timeout: PAST_THE_DEBOUNCE
    });

    // The browser's own exit route. `preventDefault` having been called is how
    // a beforeunload handler says "ask the user first".
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  }, 15_000);


  it('offers Save and exit on a step that is not the last one', async () => {
    renderEditForm(draftOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    expect(screen.getByRole('button', { name: /Save and exit/i })).toBeInTheDocument();
  });

  /**
   * Discarding is the price of decision D-3: autosave leaves a real row behind
   * for an abandoned attempt, so abandoning has to be something an author can
   * actually do.
   */
  it('discards a draft only after confirming it', async () => {
    renderEditForm(draftOpportunity);
    await screen.findByDisplayValue('Developer experience pulse');

    fireEvent.click(screen.getByRole('button', { name: /Discard draft/i }));
    expect(deleteOpportunity).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: /Discard it/i }));
    await waitFor(() => expect(deleteOpportunity).toHaveBeenCalledWith('opp-1'));
  });
});
