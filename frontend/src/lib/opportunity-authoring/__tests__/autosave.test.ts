import { describe, expect, it } from 'vitest';

import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_ATTEMPTS,
  AUTOSAVE_MIN_INTERVAL_MS,
  decideAutosave,
  forAutosave,
  meetsCreateThreshold,
  retryDelayMs,
  saveStateMessage,
  saveStateView,
  type AutosaveBlock,
  type AutosaveDecisionInput
} from '../autosave';
import type { SavePayload } from '../save-payload';

/**
 * The timing rules, asserted as arithmetic rather than through a fake clock.
 *
 * Every number here is compared against the CONSTANT rather than restated as
 * a literal, with one deliberate exception noted below. A test that hard-codes
 * 2000 passes unchanged when the debounce is retuned to 5000 and stops
 * describing the product; a test that hard-codes the relationship between two
 * constants cannot see either of them move.
 */
const at = (overrides: Partial<AutosaveDecisionInput> = {}): AutosaveDecisionInput => ({
  now: 100_000,
  dirty: true,
  block: null,
  inFlight: false,
  lastChangeAt: 0,
  lastRequestAt: null,
  lastSavedAt: null,
  consecutiveFailures: 0,
  ...overrides
});

describe('deciding whether an autosave may fire', () => {
  it('sends once the author has stopped changing things for the debounce', () => {
    expect(
      decideAutosave(at({ now: 10_000, lastChangeAt: 10_000 - AUTOSAVE_DEBOUNCE_MS }))
    ).toEqual({ action: 'send' });
  });

  it('waits out the remainder of the debounce rather than sending mid-keystroke', () => {
    const decision = decideAutosave(
      at({ now: 10_000, lastChangeAt: 10_000 - AUTOSAVE_DEBOUNCE_MS + 500 })
    );

    expect(decision).toEqual({ action: 'wait', afterMs: 500 });
  });

  /**
   * Coalescing, which is the difference between an autosave and a write
   * amplifier - and it is asserted as `idle` rather than as `wait` on purpose.
   *
   * A decision to WAIT would have the caller set a timer per change, so ten
   * keystrokes during one in-flight request would arm ten follow-up saves. The
   * request's own completion is what re-decides, from the form's live state,
   * so the newest content goes out once.
   */
  it('does nothing at all while a request is in flight, however much has changed', () => {
    expect(
      decideAutosave(at({ inFlight: true, lastChangeAt: 0, now: 1_000_000 }))
    ).toEqual({ action: 'idle' });
  });

  /**
   * "I do not know when this changed" must mean WAIT, not send.
   *
   * The component no longer passes null - it derives the change time during
   * render - so this pins the module's contract rather than a live path. It
   * earns its place anyway: a caller that goes back to recording the time in
   * an effect passes null on the render that first sees a change, and when
   * that was true an empty wait list read as "nothing to wait for" and fired
   * on the first keystroke.
   */
  it('waits the whole debounce when it does not yet know when the change happened', () => {
    expect(decideAutosave(at({ lastChangeAt: null }))).toEqual({
      action: 'wait',
      afterMs: AUTOSAVE_DEBOUNCE_MS
    });
  });

  it('does nothing when nothing has changed', () => {
    expect(decideAutosave(at({ dirty: false }))).toEqual({ action: 'idle' });
  });

  /**
   * The rate-limit floor, and the reason it is a SEPARATE clock from the
   * debounce.
   *
   * Here the author has stopped typing long enough for the debounce to be
   * satisfied several times over - so a decision that only knew about the
   * debounce would send. What holds it back is the interval since the last
   * REQUEST, which is what the shared 30-a-minute budget is actually spent by.
   */
  it('holds a save that is due but too soon after the previous request', () => {
    const now = 100_000;
    const decision = decideAutosave(
      at({
        now,
        lastChangeAt: now - AUTOSAVE_DEBOUNCE_MS * 4,
        lastRequestAt: now - AUTOSAVE_MIN_INTERVAL_MS + 1_500
      })
    );

    expect(decision).toEqual({ action: 'wait', afterMs: 1_500 });
  });

  it('sends once both the debounce and the interval floor are satisfied', () => {
    const now = 100_000;
    expect(
      decideAutosave(
        at({
          now,
          lastChangeAt: now - AUTOSAVE_DEBOUNCE_MS,
          lastRequestAt: now - AUTOSAVE_MIN_INTERVAL_MS
        })
      )
    ).toEqual({ action: 'send' });
  });

  /**
   * The two clocks disagree and the LATER one wins.
   *
   * Stated as its own case because taking the wrong one is silent in both
   * directions: taking the debounce alone overspends the budget, and taking
   * the floor alone saves mid-keystroke.
   */
  it('waits for whichever of the two clocks is later', () => {
    const now = 100_000;
    const debounceRemaining = 1_800;
    const floorRemaining = 400;

    expect(
      decideAutosave(
        at({
          now,
          lastChangeAt: now - AUTOSAVE_DEBOUNCE_MS + debounceRemaining,
          lastRequestAt: now - AUTOSAVE_MIN_INTERVAL_MS + floorRemaining
        })
      )
    ).toEqual({ action: 'wait', afterMs: debounceRemaining });
  });

  it('backs off further after each failure instead of retrying on the ordinary floor', () => {
    const now = 100_000;
    const decision = decideAutosave(
      at({
        now,
        lastChangeAt: now - AUTOSAVE_DEBOUNCE_MS * 10,
        lastRequestAt: now - AUTOSAVE_MIN_INTERVAL_MS,
        consecutiveFailures: 3
      })
    );

    // The ordinary floor is satisfied; the backoff is not.
    expect(decision).toEqual({
      action: 'wait',
      afterMs: retryDelayMs(3) - AUTOSAVE_MIN_INTERVAL_MS
    });
  });

  /**
   * The floor is a NUMBER, and the number is the whole point of it.
   *
   * Every other test here compares against the constant, so an independent
   * mutation pass set it to zero and nothing failed - the arithmetic still
   * held, against a floor that bounded nothing. The value is a budget
   * decision: `opportunityWriteLimiter` is 30 a minute per user across POST,
   * PATCH, DELETE and duplicate together, so this caps a continuously-edited
   * form at twelve and leaves eighteen for the manual saves and session writes
   * the same form performs.
   *
   * Asserted as a rate rather than as a bare literal, so it says why.
   */
  it('caps a continuously-edited form well inside the shared write budget', () => {
    const SHARED_WRITES_PER_MINUTE = 30;
    const savesPerMinute = 60_000 / AUTOSAVE_MIN_INTERVAL_MS;

    expect(savesPerMinute).toBeLessThanOrEqual(SHARED_WRITES_PER_MINUTE / 2);
    // And it is a real floor rather than a nominal one.
    expect(AUTOSAVE_MIN_INTERVAL_MS).toBeGreaterThan(AUTOSAVE_DEBOUNCE_MS);
  });

  it('grows the backoff with each consecutive failure, up to a cap', () => {
    expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(2));
    expect(retryDelayMs(2)).toBeLessThan(retryDelayMs(3));
    expect(retryDelayMs(50)).toBe(retryDelayMs(51));
  });

  it('stops trying after the last attempt rather than looping forever', () => {
    expect(
      decideAutosave(
        at({
          now: 1_000_000,
          lastChangeAt: 0,
          lastRequestAt: 0,
          consecutiveFailures: AUTOSAVE_MAX_ATTEMPTS
        })
      )
    ).toEqual({ action: 'idle' });
  });

  /**
   * The backstop that closes a whole class rather than a bug.
   *
   * Every other guard decides whether to fire; if one of them stops working,
   * the timer is left with a payload that never changes and a dirty flag that
   * therefore never clears, and it fires for ever. An independent mutation
   * pass found that shape twice, and both times the test suite HUNG rather
   * than failed - in CI a job timeout with no named failing test.
   */
  it('sends nothing when the payload is the one already sent', () => {
    expect(
      decideAutosave(at({ now: 1_000_000, lastChangeAt: 0, block: { code: 'nothing-new' } }))
    ).toEqual({ action: 'idle' });
  });

  it.each<AutosaveBlock>([
    { code: 'below-threshold' },
    { code: 'incomplete', detail: 'a question needs a prompt' },
    { code: 'needs-confirmation', detail: 'removing a question needs confirming' },
    { code: 'read-only', detail: 'these questions belong to another researcher' }
  ])('sends nothing while blocked ($code)', (block) => {
    expect(
      decideAutosave(at({ now: 1_000_000, lastChangeAt: 0, block }))
    ).toEqual({ action: 'idle' });
  });
});

describe('the create threshold', () => {
  const complete = {
    type: 'survey',
    title: 'Pulse',
    purpose_one_liner: 'Ten short questions'
  };

  it('is met once a type, a long-enough title and a long-enough purpose all exist', () => {
    expect(meetsCreateThreshold(complete)).toBe(true);
  });

  it.each([
    ['no type', { ...complete, type: '' }],
    ['a title under four characters', { ...complete, title: 'Pul' }],
    ['a purpose under ten characters', { ...complete, purpose_one_liner: 'Too short' }]
  ])('is not met with %s', (_label, form) => {
    expect(meetsCreateThreshold(form)).toBe(false);
  });

  /**
   * The boundary itself, at exactly the lengths the schema uses.
   *
   * An independent mutation pass moved `>= 4` to `> 4` and every test here
   * still passed, because the positive case used a five-character title and
   * the negative a three-character one - so nothing exercised four. A form
   * that met the schema exactly would then never autosave at all, and the
   * author would be told their work would be saved "once you have given this a
   * title and a purpose" while looking at both.
   */
  it.each([
    ['a title of exactly four characters', { ...complete, title: 'a'.repeat(4) }],
    [
      'a purpose of exactly ten characters',
      { ...complete, purpose_one_liner: 'a'.repeat(10) }
    ]
  ])('is met with %s, which is what the schema accepts', (_label, form) => {
    expect(meetsCreateThreshold(form)).toBe(true);
  });

  it.each([
    ['a title one character short', { ...complete, title: 'a'.repeat(3) }],
    [
      'a purpose one character short',
      { ...complete, purpose_one_liner: 'a'.repeat(9) }
    ]
  ])('is not met with %s', (_label, form) => {
    expect(meetsCreateThreshold(form)).toBe(false);
  });

  /**
   * Whitespace, which is the case that turns a threshold into the 400 it
   * exists to avoid.
   *
   * The schema trims before it measures, so a threshold that measured the
   * untrimmed value would consider four spaces a valid title, fire the POST,
   * and have the server refuse it - reported to the author as a failure to
   * save, while they had typed nothing.
   */
  it.each([
    ['a title of nothing but spaces', { ...complete, title: '     ' }],
    ['a purpose of nothing but spaces', { ...complete, purpose_one_liner: '              ' }],
    ['a type of nothing but spaces', { ...complete, type: '   ' }]
  ])('measures %s trimmed, as the schema does', (_label, form) => {
    // One field at a time, over a form that is otherwise complete. A single
    // all-whitespace fixture would pass this on the strength of whichever
    // field is checked first, leaving the other two rules free to stop
    // trimming without anything noticing - which is precisely what a mutation
    // of the purpose rule proved when this was written the short way.
    expect(meetsCreateThreshold(form)).toBe(false);
  });
});

describe('what an autosave is allowed to send', () => {
  const published: SavePayload = { title: 'Pulse', status: 'published' };

  /**
   * The rule the plan states in capitals, asserted on both paths, because the
   * right answer is a different one on each.
   */
  it('never publishes on a create - it says draft explicitly', () => {
    expect(forAutosave(published, false).status).toBe('draft');
  });

  it('says nothing about status on an edit, so it can neither publish nor unpublish', () => {
    const sent = forAutosave(published, true);

    expect('status' in sent).toBe(false);
  });

  /**
   * The failure mode the edit rule is really about, and it is NOT publishing.
   *
   * Forcing `status: 'draft'` on an edit would look like the safe direction
   * and would take a live opportunity down - on a timer, with nobody having
   * pressed anything. Omission is the only value that leaves the author's own
   * decision alone.
   */
  it('leaves a live opportunity live', () => {
    const sent = forAutosave({ title: 'Pulse', status: 'published' }, true);

    expect(sent).toEqual({ title: 'Pulse' });
  });

  it('changes nothing else about the payload', () => {
    const payload: SavePayload = {
      title: 'Pulse',
      purpose_one_liner: 'Ten short questions',
      expected_study_updated_at: '2026-08-21T18:00:00.000Z',
      status: 'published'
    };

    expect(forAutosave(payload, true)).toEqual({
      title: 'Pulse',
      purpose_one_liner: 'Ten short questions',
      expected_study_updated_at: '2026-08-21T18:00:00.000Z'
    });
  });

  it('does not mutate the payload it was given', () => {
    const payload: SavePayload = { title: 'Pulse', status: 'published' };
    forAutosave(payload, true);

    expect(payload.status).toBe('published');
  });
});

describe('what the author is told', () => {
  const view = (overrides: Parameters<typeof saveStateView>[0]) => saveStateView(overrides);
  const base = {
    dirty: false,
    block: null,
    inFlight: false,
    lastSavedAt: null,
    consecutiveFailures: 0
  };

  it('says it is saving while a request is out', () => {
    expect(view({ ...base, inFlight: true, dirty: true })).toEqual({ kind: 'saving' });
  });

  it('names the time of the last save once there is nothing outstanding', () => {
    expect(view({ ...base, lastSavedAt: 1_000 })).toEqual({ kind: 'saved', at: 1_000 });
  });

  it('says work is unsaved while it is', () => {
    expect(view({ ...base, dirty: true })).toEqual({ kind: 'unsaved' });
  });

  /**
   * A failure outranks everything except a request currently in flight.
   *
   * Without this ordering a form that failed to save and then acquired a block
   * - the author starts a new question, say - would stop reporting the failure
   * and show a note about the prompt instead. The unsaved work is the more
   * important fact and it did not stop being true.
   */
  it('keeps reporting a failure even once something else is also blocking', () => {
    expect(
      view({
        ...base,
        dirty: true,
        consecutiveFailures: 2,
        block: { code: 'incomplete', detail: 'a question needs a prompt' }
      })
    ).toEqual({ kind: 'retrying' });
  });

  it('stops saying "retrying" once it has stopped retrying', () => {
    expect(
      view({ ...base, dirty: true, consecutiveFailures: AUTOSAVE_MAX_ATTEMPTS })
    ).toEqual({ kind: 'failed' });
  });

  /**
   * `nothing-new` is the one block the author is never shown: it means the
   * timer has nothing left to send, which is what a saved form looks like.
   * Reporting it would take "Saved 15:42" off the screen and replace it with
   * a blank.
   */
  it('never shows "nothing new to send" as a blocked state', () => {
    // Nothing has gone wrong and there is nothing for the author to do, so it
    // must fall through to the ordinary reading rather than replacing the line
    // with a blank blocked one.
    expect(
      view({ ...base, dirty: false, lastSavedAt: 1_000, block: { code: 'nothing-new' } })
    ).toEqual({ kind: 'saved', at: 1_000 });

    // And when something IS outstanding that the timer cannot carry, the
    // honest reading is that it is outstanding - the blocks above name it.
    expect(
      view({ ...base, dirty: true, lastSavedAt: 1_000, block: { code: 'nothing-new' } })
    ).toEqual({ kind: 'unsaved' });
  });

  it('explains a block rather than showing a save state that is not true', () => {
    expect(
      view({ ...base, dirty: true, block: { code: 'below-threshold' } })
    ).toEqual({ kind: 'blocked', block: { code: 'below-threshold' } });
  });

  /**
   * Every state has a sentence.
   *
   * `idle` is the one deliberate blank - there is nothing to report about a
   * form nobody has touched - and it is asserted as blank rather than skipped,
   * so a state that renders nothing by accident is not indistinguishable from
   * this one.
   */
  it('has wording for every state', () => {
    const formatTime = () => '15:42';

    expect(saveStateMessage({ kind: 'idle' }, formatTime)).toBe('');
    expect(saveStateMessage({ kind: 'unsaved' }, formatTime)).toBe('Not saved yet');
    expect(saveStateMessage({ kind: 'saving' }, formatTime)).toBe('Saving…');
    expect(saveStateMessage({ kind: 'saved', at: 0 }, formatTime)).toBe('Saved 15:42');
    expect(saveStateMessage({ kind: 'retrying' }, formatTime)).toBe(
      'Unable to save - retrying'
    );
    expect(saveStateMessage({ kind: 'failed' }, formatTime)).toContain('Unable to save');

    expect(
      saveStateMessage({ kind: 'blocked', block: { code: 'below-threshold' } }, formatTime)
    ).toBe('Your work will be saved once you have given this a title and a purpose');
    expect(
      saveStateMessage(
        { kind: 'blocked', block: { code: 'incomplete', detail: 'a question needs a prompt' } },
        formatTime
      )
    ).toBe('Not saved - a question needs a prompt');
  });

  /**
   * The failed message names what the author can still do.
   *
   * "Unable to save" alone tells someone their work is gone. It is not - it is
   * on the page in front of them - and the difference between those two
   * readings is whether they close the tab.
   */
  it('tells the author their work is still on the page when it gives up', () => {
    expect(saveStateMessage({ kind: 'failed' }, () => '')).toContain('still on this page');
  });
});
