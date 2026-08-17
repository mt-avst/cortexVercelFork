import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskWindow } from "./task-window";

// The floating task pane cannot be placed: Chrome owns Document PiP placement
// (bottom-right of the screen) and requestWindow takes only a size. The task
// window is the movable half, so it opens as a large inset anchored to the
// bottom-right of the screen the participant is on - the pane then lands ON
// the task window and reads as attached to it, while the top-left corner
// stays clear so the participant can still find the Cortex window behind it.
// Filling the whole screen was shipped first and obscured everything.
//
// Placement only happens where the pane can appear. Without Document PiP the
// tasks live in the Cortex page, and a deliberately placed large window would
// bury the only copy of the task card.

type FakeWindow = {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  location: { href: string };
  opener: unknown;
};

function fakeWindow(): FakeWindow {
  return {
    closed: false,
    close: vi.fn(),
    focus: vi.fn(),
    location: { href: "" },
    opener: {}
  };
}

function stubScreen(dims: {
  availWidth: number;
  availHeight: number;
  availLeft?: number;
  availTop?: number;
}) {
  vi.spyOn(window, "screen", "get").mockReturnValue(dims as Screen);
}

function stubPipSupport(supported: boolean) {
  Object.defineProperty(window, "documentPictureInPicture", {
    value: supported ? { requestWindow: vi.fn() } : undefined,
    configurable: true,
    writable: true
  });
}

describe("useTaskWindow window placement", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(fakeWindow() as unknown as Window);
    stubPipSupport(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stubPipSupport(false);
  });

  it("anchors the task window to the bottom-right of the screen", () => {
    stubScreen({ availWidth: 1512, availHeight: 944 });

    const { result } = renderHook(() => useTaskWindow());

    let opened = false;

    act(() => {
      opened = result.current.openTaskWindow("https://shop.example.com/x");
    });

    expect(opened).toBe(true);
    expect(openSpy).toHaveBeenCalledTimes(1);

    // 65% x 80% of 1512x944, flush against the bottom-right corner - where
    // Chrome puts the floating pane. The whole string is pinned so a stray
    // extra flag cannot creep in unasserted.
    expect(openSpy.mock.calls[0][2]).toBe(
      "popup,left=529,top=189,width=983,height=755"
    );
  });

  it("stays on the participant's screen when it is not the primary one", () => {
    // availLeft/availTop locate a secondary monitor in the multi-screen
    // coordinate space; left=0,top=0 would be the PRIMARY screen's origin
    // and would throw the window onto the wrong display.
    stubScreen({
      availWidth: 1512,
      availHeight: 944,
      availLeft: 1512,
      availTop: 25
    });

    const { result } = renderHook(() => useTaskWindow());

    act(() => {
      result.current.openTaskWindow("https://shop.example.com/x");
    });

    expect(openSpy.mock.calls[0][2]).toBe(
      "popup,left=2041,top=214,width=983,height=755"
    );
  });

  it("uses the browser's own placement when Document PiP is unavailable", () => {
    // Firefox, or an embedder that strips requestWindow: no pane will land on
    // the task window, and the in-page task card is the only copy of the
    // tasks - a deliberately placed large window would bury it.
    stubPipSupport(false);
    stubScreen({ availWidth: 1512, availHeight: 944 });

    const { result } = renderHook(() => useTaskWindow());

    act(() => {
      result.current.openTaskWindow("https://shop.example.com/x");
    });

    expect(openSpy.mock.calls[0][2]).toBe("popup,width=1280,height=900");
  });

  it("falls back to a fixed size when the screen reports no dimensions", () => {
    // jsdom and some embedded webviews report 0x0; a zero-sized popup request
    // is at the browser's mercy, so ask for something usable instead.
    stubScreen({ availWidth: 0, availHeight: 0 });

    const { result } = renderHook(() => useTaskWindow());

    let opened = false;

    act(() => {
      opened = result.current.openTaskWindow("https://shop.example.com/x");
    });

    expect(opened).toBe(true);
    expect(openSpy.mock.calls[0][2]).toBe("popup,width=1280,height=900");
  });
});

describe("useTaskWindow reuse and refusal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    stubPipSupport(false);
  });

  it("focuses the existing window instead of reopening the same URL", () => {
    stubPipSupport(true);
    stubScreen({ availWidth: 1512, availHeight: 944 });

    const win = fakeWindow();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(win as unknown as Window);

    const { result } = renderHook(() => useTaskWindow());

    act(() => {
      result.current.openTaskWindow("https://shop.example.com/x");
    });
    act(() => {
      result.current.openTaskWindow("https://shop.example.com/x");
    });

    // One real open; the second call brings the window the participant
    // already has back to the front rather than spawning a rival copy.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(2);
  });

  it("reports blocked when the popup is refused", () => {
    stubPipSupport(true);
    stubScreen({ availWidth: 1512, availHeight: 944 });
    vi.spyOn(window, "open").mockReturnValue(null);

    const { result } = renderHook(() => useTaskWindow());

    let opened = true;

    act(() => {
      opened = result.current.openTaskWindow("https://shop.example.com/x");
    });

    expect(opened).toBe(false);
    expect(result.current.state.status).toBe("blocked");
  });

  it("refuses an unsafe target without opening anything", () => {
    stubPipSupport(true);
    stubScreen({ availWidth: 1512, availHeight: 944 });
    const openSpy = vi.spyOn(window, "open");

    const { result } = renderHook(() => useTaskWindow());

    let opened = true;

    act(() => {
      // javascript: on an about:blank handle would run in this app's origin.
      opened = result.current.openTaskWindow("javascript:alert(1)");
    });

    expect(opened).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("blocked");
  });
});

describe("useTaskWindow lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    stubPipSupport(false);
  });

  it("closes the task window when the session flow unmounts", () => {
    stubPipSupport(true);
    stubScreen({ availWidth: 1512, availHeight: 944 });

    const win = fakeWindow();

    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);

    const { result, unmount } = renderHook(() => useTaskWindow());

    act(() => {
      result.current.openTaskWindow("https://shop.example.com/x");
    });

    unmount();

    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("closes the task window when the page unloads", () => {
    stubPipSupport(true);
    stubScreen({ availWidth: 1512, availHeight: 944 });

    const win = fakeWindow();

    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);

    const { result } = renderHook(() => useTaskWindow());

    act(() => {
      result.current.openTaskWindow("https://shop.example.com/x");
    });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("never adopts a task window left over from an earlier page load", async () => {
    // window.open with the name of a window that already exists returns that
    // window and silently IGNORES the requested features - so a survivor
    // from an earlier page load would pin every later session to its stale
    // geometry. A per-page-load name makes adoption impossible.
    stubPipSupport(true);
    stubScreen({ availWidth: 1512, availHeight: 944 });

    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(fakeWindow() as unknown as Window);

    vi.resetModules();
    const first = await import("./task-window");
    const firstRender = renderHook(() => first.useTaskWindow());

    act(() => {
      firstRender.result.current.openTaskWindow("https://shop.example.com/x");
    });

    vi.resetModules();
    const second = await import("./task-window");
    const secondRender = renderHook(() => second.useTaskWindow());

    act(() => {
      secondRender.result.current.openTaskWindow("https://shop.example.com/x");
    });

    const [firstName, secondName] = openSpy.mock.calls.map((call) => call[1]);

    expect(firstName).toBeTruthy();
    expect(firstName).not.toBe(secondName);
  });
});
