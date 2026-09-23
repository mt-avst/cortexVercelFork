import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { CLOSE_UNDO_MS, failureMessage, useCloseStudyUndo } from '../useCloseStudyUndo';
import { updateOpportunity } from '../../api/client';
import type { Opportunity } from '../../api/types';

/**
 * useCloseStudyUndo - Close study with Undo for the Admin Research Studies
 * table (MR B fix round), tested apart from the page. The page-level
 * behaviour (in-place rows, focus fallbacks) is in
 * pages/__tests__/Admin.close-in-place.test.tsx.
 *
 * The 8000ms window is pinned as a literal.
 */

vi.mock('../../api/client', () => ({ updateOpportunity: vi.fn() }));
vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const study = (id: string, title = `Study ${id}`): Opportunity =>
  ({
    id,
    type: 'test',
    title,
    purpose_one_liner: 'p',
    default_duration_minutes: 30,
    status: 'published',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  }) as Opportunity;

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Real elements behind the hook's refs, as the table renders them. */
const attachRefs = (hook: ReturnType<typeof useCloseStudyUndo>) => {
  const undoButton = document.createElement('button');
  const errorBox = document.createElement('div');
  errorBox.tabIndex = -1;
  document.body.append(undoButton, errorBox);
  (hook.undoButtonRef as { current: HTMLButtonElement | null }).current = undoButton;
  (hook.errorRef as { current: HTMLDivElement | null }).current = errorBox;
  return { undoButton, errorBox, cleanupEls: () => { undoButton.remove(); errorBox.remove(); } };
};

const setup = (captureNeighbours?: (id: string) => string[]) => {
  const onStatusChanged = vi.fn();
  const focusStudy = vi.fn();
  // The notice as of the LATEST render, recorded during render itself.
  // renderHook's own result.current is only updated in an effect that runs
  // after the hook's effects, so read from inside one it is a render stale.
  const rendered: { notice: string | null } = { notice: null };
  const hook = renderHook(() => {
    const value = useCloseStudyUndo({ onStatusChanged, focusStudy, captureNeighbours });
    rendered.notice = value.notice?.id ?? null;
    return value;
  });
  return { ...hook, onStatusChanged, focusStudy, rendered };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updateOpportunity).mockResolvedValue({} as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCloseStudyUndo', () => {
  it('holds the Undo for 8000ms - pinned as a literal', () => {
    expect(CLOSE_UNDO_MS).toBe(8000);
  });

  it('words every refusal the same way: the title in curly quotes, the reason or a retry', () => {
    expect(failureMessage('copy', 'Which editor?', { response: { data: { error: 'Nope.' } } })).toBe(
      'Could not copy “Which editor?”: Nope.'
    );
    expect(failureMessage('reopen', 'Which editor?', new Error('x'))).toBe(
      'Could not reopen “Which editor?”. Please try again.'
    );
  });

  it('closes: PATCHes closed, reports it, and shows the notice with the pre-close snapshot', async () => {
    const { result, onStatusChanged } = setup();
    const x = study('x', 'Study X');
    await act(async () => {
      await result.current.closeStudy(x);
    });

    expect(vi.mocked(updateOpportunity)).toHaveBeenCalledWith('x', { status: 'closed' });
    expect(onStatusChanged).toHaveBeenCalledWith('x', 'closed');
    expect(result.current.notice).toEqual({ id: 'x', title: 'Study X', snapshot: x });
    // The table SORTS on the snapshot while the notice is up (round 3: sort
    // position only - filters and counts read the live study).
    expect(result.current.frozenSnapshot).toBe(x);
  });

  it('sends one PATCH for two Closes of the same study in flight, and reports it in flight meanwhile', async () => {
    const patch = deferred<unknown>();
    vi.mocked(updateOpportunity).mockReturnValue(patch.promise as never);
    const { result } = setup();
    const x = study('x');

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.closeStudy(x);
      second = result.current.closeStudy(x);
    });
    expect(result.current.isCloseInFlight()).toBe(true);

    await act(async () => {
      patch.resolve({});
      await Promise.all([first, second]);
    });
    expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(1);
    expect(result.current.isCloseInFlight()).toBe(false);
  });

  it('guards per study: two different studies each get their PATCH', async () => {
    const { result } = setup();
    await act(async () => {
      await Promise.all([result.current.closeStudy(study('x')), result.current.closeStudy(study('y'))]);
    });
    expect(vi.mocked(updateOpportunity).mock.calls).toEqual([
      ['x', { status: 'closed' }],
      ['y', { status: 'closed' }],
    ]);
  });

  it.each([
    ['no reason', new Error('Network Error'), 'Could not close “Study X”. Please try again.'],
    ['a blank reason', { response: { data: { error: '   ' } } }, 'Could not close “Study X”. Please try again.'],
    ['`error`', { response: { data: { error: 'Nope.' } } }, 'Could not close “Study X”: Nope.'],
    ['`message`', { response: { data: { message: 'Also nope.' } } }, 'Could not close “Study X”: Also nope.'],
  ])('a refused Close with %s says so, freezes nothing, and changes nothing', async (_label, error, message) => {
    vi.mocked(updateOpportunity).mockRejectedValueOnce(error);
    const { result, onStatusChanged } = setup();
    const x = study('x', 'Study X');
    await act(async () => {
      await result.current.closeStudy(x);
    });

    // No anchor: a refused Close's error sits under the row itself.
    expect(result.current.actionError).toEqual({ id: 'x', title: 'Study X', message });
    expect(result.current.notice).toBeNull();
    expect(onStatusChanged).not.toHaveBeenCalled();
    expect(result.current.frozenSnapshot).toBeNull();
  });

  it('Undo PATCHes published, reports it, ends the notice and hands focus to the study', async () => {
    const { result, onStatusChanged, focusStudy } = setup();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    await act(async () => {
      await result.current.undo();
    });

    expect(vi.mocked(updateOpportunity)).toHaveBeenLastCalledWith('x', { status: 'published' });
    expect(onStatusChanged).toHaveBeenLastCalledWith('x', 'published');
    expect(result.current.notice).toBeNull();
    expect(focusStudy).toHaveBeenCalledWith('x', []);
  });

  it("a refused Undo shows the server's reason and leaves the study closed", async () => {
    vi.mocked(updateOpportunity)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce({ response: { data: { error: 'Add a slot first.' } } });
    const { result, onStatusChanged } = setup();
    await act(async () => {
      await result.current.closeStudy(study('x', 'Study X'));
    });
    await act(async () => {
      await result.current.undo();
    });

    expect(result.current.actionError?.message).toBe('Could not reopen “Study X”: Add a slot first.');
    // The error is drawn in the notice's old slot (sorted on this anchor),
    // but nothing is frozen any more: the row itself sorts and filters live.
    expect(result.current.actionError?.anchor?.id).toBe('x');
    expect(result.current.frozenSnapshot).toBeNull();
    expect(result.current.notice).toBeNull();
    expect(onStatusChanged).not.toHaveBeenCalledWith('x', 'published');
    expect(result.current.undoingId).toBeNull();
  });

  it('sends one PATCH for two Undo presses in flight', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    const reopen = deferred<unknown>();
    vi.mocked(updateOpportunity).mockReturnValue(reopen.promise as never);

    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = result.current.undo();
    });
    expect(result.current.undoingId).toBe('x');
    act(() => {
      b = result.current.undo();
    });
    await act(async () => {
      reopen.resolve({});
      await Promise.all([a, b]);
    });
    expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(2); // one close, one reopen
    expect(result.current.undoingId).toBeNull();
  });

  it("a late Undo answer for one study leaves the next study's notice, and its focus, alone", async () => {
    const { result, focusStudy } = setup();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    const reopenX = deferred<unknown>();
    vi.mocked(updateOpportunity).mockImplementation(((id: string, data: { status: string }) =>
      id === 'x' && data.status === 'published' ? reopenX.promise : Promise.resolve({})) as never);

    let undoing!: Promise<void>;
    act(() => {
      undoing = result.current.undo();
    });
    await act(async () => {
      await result.current.closeStudy(study('y'));
    });
    expect(result.current.notice?.id).toBe('y');

    await act(async () => {
      reopenX.resolve({});
      await undoing;
    });

    expect(result.current.notice?.id).toBe('y');
    // Any call for x, whatever its neighbours: a bare not.toHaveBeenCalledWith('x')
    // stopped seeing a (x, near) call once round 4 added the second argument.
    expect(focusStudy.mock.calls.filter(([id]) => id === 'x')).toEqual([]);
  });

  it('... and a late REFUSAL for one study does not steal focus from the next notice either', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    const reopenX = deferred<unknown>();
    vi.mocked(updateOpportunity).mockImplementation(((id: string, data: { status: string }) =>
      id === 'x' && data.status === 'published' ? reopenX.promise : Promise.resolve({})) as never);

    let undoing!: Promise<void>;
    act(() => {
      undoing = result.current.undo();
    });
    await act(async () => {
      await result.current.closeStudy(study('y'));
    });
    // Give the hook's refs real elements, as the table would, with focus on
    // y's Undo - where the user is.
    const { undoButton, errorBox, cleanupEls } = attachRefs(result.current);
    undoButton.focus();
    expect(document.activeElement).toBe(undoButton);

    await act(async () => {
      reopenX.reject({ response: { data: { error: 'No.' } } });
      await undoing;
    });

    // The refusal is recorded (under x), y's notice stays, and focus stays.
    expect(result.current.actionError?.id).toBe('x');
    expect(result.current.notice?.id).toBe('y');
    expect(document.activeElement).toBe(undoButton);
    expect(document.activeElement).not.toBe(errorBox);
    cleanupEls();
  });

  it('a refusal with no newer notice DOES move focus to the error (the control for the test above)', async () => {
    vi.mocked(updateOpportunity)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce({ response: { data: { error: 'No.' } } });
    const { result } = setup();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    const { errorBox, cleanupEls } = attachRefs(result.current);
    await act(async () => {
      await result.current.undo();
    });
    expect(document.activeElement).toBe(errorBox);
    cleanupEls();
  });

  it("hands focus to the next notice's Undo once a late Undo settles, if focus had fallen to <body>", async () => {
    // Round 3: every Undo is disabled while any Undo is in flight, so the
    // next notice's Undo cannot take focus when it appears. Once the first
    // Undo answers, focus that fell to <body> goes to the live notice.
    const { result } = setup();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    const reopenX = deferred<unknown>();
    vi.mocked(updateOpportunity).mockImplementation(((id: string, data: { status: string }) =>
      id === 'x' && data.status === 'published' ? reopenX.promise : Promise.resolve({})) as never);
    let undoing!: Promise<void>;
    act(() => {
      undoing = result.current.undo();
    });
    await act(async () => {
      await result.current.closeStudy(study('y'));
    });
    const { undoButton, cleanupEls } = attachRefs(result.current);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      reopenX.resolve({});
      await undoing;
    });

    expect(result.current.notice?.id).toBe('y');
    expect(document.activeElement).toBe(undoButton);
    cleanupEls();
  });

  it('on the lapse, focuses the study BEFORE its row is unfrozen, when Undo held focus', async () => {
    const { result, focusStudy, rendered } = setup();
    vi.useFakeTimers();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    const { undoButton, cleanupEls } = attachRefs(result.current);
    undoButton.focus();
    // What the table looked like at the moment focus moved.
    const noticeAtFocus: (string | null)[] = [];
    focusStudy.mockImplementation(() => {
      noticeAtFocus.push(rendered.notice);
    });

    act(() => {
      vi.advanceTimersByTime(8000);
    });

    expect(focusStudy).toHaveBeenCalledWith('x', []);
    // First call ran while the notice (and so the frozen sort position) was
    // still up - focus moves first, then the row re-sorts under it.
    expect(noticeAtFocus[0]).toBe('x');
    expect(result.current.notice).toBeNull();
    cleanupEls();
  });

  it('hands the neighbours at the notice slot, read BEFORE the re-sort, with focus on the lapse (round 4)', async () => {
    // The page reads the rows around the notice (next, then previous); the
    // hook must ask while the notice is still up and pass them on, so focus
    // can land at the old slot if the study's own link has moved away.
    const noticeAtCapture: (string | null)[] = [];
    let renderedRef: { notice: string | null } = { notice: null };
    const captureNeighbours = vi.fn((id: string) => {
      noticeAtCapture.push(renderedRef.notice);
      return id === 'x' ? ['next-row', 'previous-row'] : [];
    });
    const { result, focusStudy, rendered } = setup(captureNeighbours);
    renderedRef = rendered;
    vi.useFakeTimers();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    const { undoButton, cleanupEls } = attachRefs(result.current);
    undoButton.focus();

    act(() => {
      vi.advanceTimersByTime(8000);
    });

    expect(captureNeighbours).toHaveBeenCalledWith('x');
    expect(noticeAtCapture[0]).toBe('x');
    expect(focusStudy).toHaveBeenCalledWith('x', ['next-row', 'previous-row']);
    // Every focus call for x carried them, including the post-render re-assert.
    for (const [id, near] of focusStudy.mock.calls) {
      if (id === 'x') expect(near).toEqual(['next-row', 'previous-row']);
    }
    cleanupEls();
  });

  it('hands the neighbours of the error slot with focus on Dismiss (round 4)', async () => {
    vi.mocked(updateOpportunity).mockRejectedValueOnce(new Error('x'));
    const captureNeighbours = vi.fn(() => ['next-row']);
    const { result, focusStudy } = setup(captureNeighbours);
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    act(() => {
      result.current.dismissError();
    });
    expect(captureNeighbours).toHaveBeenCalledWith('x');
    expect(focusStudy).toHaveBeenCalledWith('x', ['next-row']);
  });

  it('holds the table\'s scroll anchoring off only while a notice is up (round 4)', async () => {
    const { result } = setup();
    expect(result.current.holdScroll).toBe(false);
    vi.useFakeTimers();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    expect(result.current.holdScroll).toBe(true);
    // Undo did not hold focus, so there is no hand-off: released with the notice.
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.holdScroll).toBe(false);
  });

  it('keeps holding through a hand-off re-sort, then lets go once it is laid out (round 4)', async () => {
    const { result } = setup();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
    });
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    const { undoButton, cleanupEls } = attachRefs(result.current);
    undoButton.focus();

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    // The notice is gone, but the focus hand-off's re-sort has not been laid
    // out yet: anchoring stays off through it.
    expect(result.current.notice).toBeNull();
    expect(result.current.holdScroll).toBe(true);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.holdScroll).toBe(false);
    cleanupEls();
  });

  it('does not move focus on the lapse when Undo did not hold it', async () => {
    const { result, focusStudy } = setup();
    vi.useFakeTimers();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(result.current.notice).toBeNull();
    expect(focusStudy).not.toHaveBeenCalled();
  });

  it('shows a refused row action (Copy) under its row, with no anchor, and focuses it', async () => {
    const { result } = setup();
    const { errorBox, cleanupEls } = attachRefs(result.current);
    act(() => {
      result.current.showRowError(study('x', 'Study X'), 'Could not copy “Study X”. Please try again.');
    });
    expect(result.current.actionError).toEqual({
      id: 'x',
      title: 'Study X',
      message: 'Could not copy “Study X”. Please try again.',
    });
    expect(document.activeElement).toBe(errorBox);
    cleanupEls();
  });

  it('a refusal behind a newer notice takes no scroll hold, so the hold ends with that notice (L-B)', async () => {
    const { result } = setup();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'],
    });
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    const reopenX = deferred<unknown>();
    vi.mocked(updateOpportunity).mockImplementation(((id: string, data: { status: string }) =>
      id === 'x' && data.status === 'published' ? reopenX.promise : Promise.resolve({})) as never);
    let undoing!: Promise<void>;
    act(() => {
      undoing = result.current.undo();
    });
    await act(async () => {
      await result.current.closeStudy(study('y'));
    });
    // The reader has moved on to something else on the page - not y's Undo,
    // not <body> - so no later focus request can release a stray hold.
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    // Let y's own focus hand-off settle first (its two-frame release), as it
    // would long before a server answers: a hold taken after this has nothing
    // left to release it.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    await act(async () => {
      reopenX.reject({ response: { data: { error: 'No.' } } });
      await undoing;
    });
    // Control: the refusal landed behind y's notice, and focus stayed put.
    expect(result.current.actionError?.id).toBe('x');
    expect(result.current.notice?.id).toBe('y');
    expect(document.activeElement).toBe(elsewhere);
    expect(result.current.holdScroll).toBe(true);

    // y lapses with nobody on its Undo: no hand-off, so nothing may still hold.
    act(() => {
      vi.advanceTimersByTime(7900);
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.holdScroll).toBe(false);
    elsewhere.remove();
  });

  it('lapses after exactly 8000ms', async () => {
    const { result } = setup();
    vi.useFakeTimers();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(result.current.notice?.id).toBe('x');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.notice).toBeNull();
  });

  it('dismissing an error clears it and hands focus to the study', async () => {
    vi.mocked(updateOpportunity).mockRejectedValueOnce(new Error('x'));
    const { result, focusStudy } = setup();
    await act(async () => {
      await result.current.closeStudy(study('x'));
    });
    expect(result.current.actionError).not.toBeNull();

    act(() => {
      result.current.dismissError();
    });
    expect(result.current.actionError).toBeNull();
    expect(focusStudy).toHaveBeenCalledWith('x', []);
  });

  it('arms no timer and reports nothing for a Close that answers after unmount', async () => {
    const patch = deferred<unknown>();
    vi.mocked(updateOpportunity).mockReturnValue(patch.promise as never);
    const { result, unmount, onStatusChanged } = setup();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    let closing!: Promise<void>;
    act(() => {
      closing = result.current.closeStudy(study('x'));
    });
    unmount();
    patch.resolve({});
    await closing;

    expect(onStatusChanged).not.toHaveBeenCalled();
    expect(setTimeoutSpy.mock.calls.some(([, ms]) => ms === 8000)).toBe(false);
    setTimeoutSpy.mockRestore();
  });
});
