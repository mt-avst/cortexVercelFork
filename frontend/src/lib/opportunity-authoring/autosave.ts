import type { SavePayload } from './save-payload';

/**
 * When an autosave may fire, and what the author is told while it does not.
 *
 * Pure, and deliberately so. Every rule here is about TIME, which is the one
 * thing jsdom is least trustworthy about: a fake clock advanced by a test
 * proves the test's arithmetic, not the browser's. So the arithmetic lives in
 * a function that takes `now` as an argument and can be asserted directly,
 * and what is left in the component is only the wiring - which is then checked
 * in a real browser, where a debounce actually means something.
 *
 * The states are as visible to the author as they are here. The plan's wording
 * is "explicit state, always visible", and the reason is that the alternative
 * to saying "not saved" is a form that looks saved and is not.
 */

/**
 * Two seconds after the last edit.
 *
 * Long enough that ordinary typing produces one save rather than one per word,
 * short enough that stepping away from the keyboard for a moment leaves work
 * on the server rather than in a tab.
 */
export const AUTOSAVE_DEBOUNCE_MS = 2_000;

/**
 * The floor between two requests, and it is not the same number as the
 * debounce.
 *
 * `opportunityWriteLimiter` is 30 a minute per user and it covers POST, PATCH,
 * DELETE and duplicate together - so the budget is 30 SHARED writes, not 30
 * autosaves. A pure two-second debounce under sustained editing is 30 a minute
 * exactly, which spends the entire allowance and leaves nothing for the manual
 * saves, the session writes and the discard this same form performs.
 *
 * Five seconds caps a busy form at twelve a minute. The remaining eighteen are
 * what stops an author who is editing continuously from being refused when
 * they press Save.
 *
 * Worth knowing rather than relying on: that limiter's store is per PROCESS,
 * so with more than one backend pod the real ceiling is higher and a caller
 * can be balanced onto a fresh bucket. Budgeting against the single-pod number
 * is the conservative reading and the right one.
 */
export const AUTOSAVE_MIN_INTERVAL_MS = 5_000;

/**
 * How many consecutive failures before the form stops trying and says so.
 *
 * A timer that retries forever against a backend that is not coming back is
 * indistinguishable, from the author's side, from one that is saving - and it
 * spends the write budget doing it. Stopping is the honest end state, and it
 * has to be a sentence rather than a spinner.
 */
export const AUTOSAVE_MAX_ATTEMPTS = 5;

/** 2s, 4s, 8s, 16s, capped. */
export const retryDelayMs = (consecutiveFailures: number): number =>
  Math.min(2_000 * 2 ** Math.max(0, consecutiveFailures - 1), 30_000);

/**
 * Why a save cannot be sent right now, in the author's words.
 *
 * A reason is not an error: nothing has gone wrong, the payload simply is not
 * one the server would accept yet. The distinction matters because the form
 * must not show a failure for a question the author is halfway through typing.
 */
export type AutosaveBlock =
  | { code: 'below-threshold' }
  /**
   * The payload is byte-for-byte the one the last successful save sent, so
   * there is nothing new to send. Carries no sentence: nothing has gone wrong
   * and there is nothing for the author to do about it.
   */
  | { code: 'nothing-new' }
  | { code: 'incomplete'; detail: string }
  | { code: 'needs-confirmation'; detail: string }
  | { code: 'read-only'; detail: string };

export interface AutosaveState {
  /** Set while a request is in flight. */
  inFlight: boolean;
  /** When the last request was SENT, for the interval floor. */
  lastRequestAt: number | null;
  /** When the last save succeeded, for "Saved 15:42". */
  lastSavedAt: number | null;
  consecutiveFailures: number;
}

export interface AutosaveDecisionInput extends AutosaveState {
  now: number;
  /** Whether anything on the form differs from what was last stored. */
  dirty: boolean;
  /**
   * When the form last changed.
   *
   * NOT part of `AutosaveState`, and the separation is deliberate. Held as
   * state it would be written by an effect, which runs a render AFTER the one
   * that first sees the change - so the decision on that render would read the
   * previous change time and, on the first edit following a save, find a
   * debounce that expired minutes ago and fire immediately. The caller derives
   * this during render instead.
   */
  lastChangeAt: number | null;
  /** Why a save cannot go out, or null when one can. */
  block: AutosaveBlock | null;
}

export type AutosaveDecision =
  | { action: 'send' }
  /** Nothing to do until something changes. */
  | { action: 'idle' }
  /** Come back in `afterMs`; the caller sets one timer, never a queue. */
  | { action: 'wait'; afterMs: number };

/**
 * Whether to send now, wait, or do nothing.
 *
 * The order of these tests is the specification, so it is worth reading as
 * one:
 *
 *  1. A request already in flight COALESCES rather than queues. Whatever
 *     changed while it was out is picked up by the next decision, from the
 *     form's live state - so the newest content is sent once, rather than
 *     every intermediate version being sent in turn. This is the difference
 *     between an autosave and a write amplifier.
 *  2. Having given up, stay given up. Only a fresh change resets the count.
 *  3. A block is not a failure and not a retry: hold, and let the author read
 *     why.
 *  4. Then the two clocks - the debounce since the last CHANGE, and the floor
 *     since the last REQUEST - and the later of the two wins. They are
 *     separate because they answer different questions: has the author stopped
 *     typing, and can the budget afford another write.
 */
export const decideAutosave = (input: AutosaveDecisionInput): AutosaveDecision => {
  const {
    now,
    dirty,
    block,
    inFlight,
    lastChangeAt,
    lastRequestAt,
    consecutiveFailures
  } = input;

  if (inFlight) return { action: 'idle' };
  if (!dirty) return { action: 'idle' };
  if (consecutiveFailures >= AUTOSAVE_MAX_ATTEMPTS) return { action: 'idle' };
  if (block) return { action: 'idle' };

  const waits: number[] = [];

  /**
   * A change whose moment is not known waits the FULL debounce.
   *
   * This IS now a defensive branch, and the history is worth keeping because
   * it explains why the rule is "wait" rather than "send". The caller used to
   * record the change time in an effect, which runs a render AFTER the one
   * that first sees the change - so on that render the time was null, and an
   * empty wait list read as "nothing to wait for", which made the first edit
   * of every session save INSTANTLY. On the first keystroke: precisely what
   * the debounce exists to prevent.
   *
   * The caller now derives the time during render, so it is never null in
   * production and this branch is unreachable from the component. It stays
   * because the module is a pure function with a nullable input, the safe
   * answer to "I do not know when this changed" is to wait rather than to
   * fire, and a caller that reintroduces the effect gets the safe direction
   * instead of the bug.
   */
  waits.push(
    lastChangeAt === null
      ? AUTOSAVE_DEBOUNCE_MS
      : AUTOSAVE_DEBOUNCE_MS - (now - lastChangeAt)
  );

  if (lastRequestAt !== null) {
    // After a failure the floor is the BACKOFF rather than the ordinary
    // interval, so a backend that is refusing everything is not asked twelve
    // times a minute whether it has recovered.
    const floor =
      consecutiveFailures > 0
        ? retryDelayMs(consecutiveFailures)
        : AUTOSAVE_MIN_INTERVAL_MS;
    waits.push(floor - (now - lastRequestAt));
  }

  const longest = waits.length > 0 ? Math.max(...waits) : 0;

  return longest > 0 ? { action: 'wait', afterMs: longest } : { action: 'send' };
};

/**
 * The create threshold.
 *
 * `CreateOpportunitySchema` requires a type, a title of at least four
 * characters and a purpose of at least ten on create, so a POST before those
 * exist is a 400 - which the author would experience as the form telling them
 * saving had failed, at the moment they had typed three letters of a title.
 *
 * Trimmed, and to the SAME lengths the schema uses, because the schema trims
 * before it measures. A threshold that measured the untrimmed value would let
 * four spaces through and produce exactly the 400 this exists to avoid.
 */
export const meetsCreateThreshold = (form: {
  type: string;
  title: string;
  purpose_one_liner: string;
}): boolean =>
  form.type.trim().length > 0 &&
  form.title.trim().length >= 4 &&
  form.purpose_one_liner.trim().length >= 10;

/**
 * The payload an autosave may send, derived from the one a manual save sends.
 *
 * `status` is the whole reason this function exists, and the two cases are
 * different:
 *
 *  - On an EDIT the key is removed. PATCH is partial, so omitting it leaves
 *    the stored status exactly as it is. That is the only behaviour that can
 *    neither publish something the author has not published nor unpublish
 *    something they have - and an autosave must do neither. Sending
 *    `status: 'draft'` here would take a live opportunity down on a timer.
 *  - On a CREATE the key is forced to `draft`, explicitly rather than by
 *    relying on the server's default. A draft is what an unfinished
 *    opportunity is, and drafts are already excluded from participant
 *    listings, which is what makes autosaving one safe at all.
 *
 * Publishing stays an explicit act on the Review step, performed by
 * `handleSubmit`, which does not go through here.
 */
export const forAutosave = (payload: SavePayload, isEdit: boolean): SavePayload => {
  const next: SavePayload = { ...payload };

  if (isEdit) {
    delete next.status;
  } else {
    next.status = 'draft';
  }

  return next;
};

export type SaveStateView =
  | { kind: 'idle' }
  | { kind: 'unsaved' }
  | { kind: 'blocked'; block: AutosaveBlock }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'retrying' }
  | { kind: 'failed' };

/**
 * What the author is shown, derived from the same state the decision reads.
 *
 * Derived rather than stored, so the sentence on screen cannot disagree with
 * what the timer is actually doing. A separately-maintained status string is
 * how a form ends up saying "Saved" while nothing has been saved for ten
 * minutes.
 */
export const saveStateView = (input: {
  dirty: boolean;
  block: AutosaveBlock | null;
  inFlight: boolean;
  lastSavedAt: number | null;
  consecutiveFailures: number;
}): SaveStateView => {
  const { dirty, block, inFlight, lastSavedAt, consecutiveFailures } = input;

  if (inFlight) return { kind: 'saving' };

  // A failure outranks a block, and outranks "saved" - work that did not reach
  // the server is the most important thing on the screen, and a block that
  // appeared afterwards does not make the failure less true.
  if (consecutiveFailures >= AUTOSAVE_MAX_ATTEMPTS) return { kind: 'failed' };
  if (consecutiveFailures > 0) return { kind: 'retrying' };

  /**
   * `nothing-new` is a DECISION input, not something to tell the author.
   *
   * It means the timer has nothing left to send, which is the ordinary state
   * of a saved form - so it must fall through to "Saved 15:42" rather than
   * replacing it with a blank blocked state and taking the line off the
   * screen.
   */
  if (block && block.code !== 'nothing-new') return { kind: 'blocked', block };

  if (dirty) return { kind: 'unsaved' };
  if (lastSavedAt !== null) return { kind: 'saved', at: lastSavedAt };

  return { kind: 'idle' };
};

/**
 * The sentence for each state.
 *
 * Held here beside the states rather than in the component, so a state added
 * without wording fails the exhaustiveness check rather than rendering blank.
 */
export const saveStateMessage = (
  view: SaveStateView,
  formatTime: (at: number) => string
): string => {
  switch (view.kind) {
    case 'idle':
      return '';
    case 'unsaved':
      return 'Not saved yet';
    case 'blocked':
      switch (view.block.code) {
        case 'nothing-new':
          return '';
        case 'below-threshold':
          return 'Your work will be saved once you have given this a title and a purpose';
        case 'incomplete':
          return `Not saved - ${view.block.detail}`;
        case 'needs-confirmation':
          return `Not saved - ${view.block.detail}`;
        case 'read-only':
          return `Not saved - ${view.block.detail}`;
      }
    // eslint-disable-next-line no-fallthrough
    case 'saving':
      return 'Saving…';
    case 'saved':
      return `Saved ${formatTime(view.at)}`;
    case 'retrying':
      return 'Unable to save - retrying';
    case 'failed':
      return 'Unable to save. Your work is still on this page - copy anything you cannot lose before closing it.';
  }
};
