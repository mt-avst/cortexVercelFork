import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isTaskPipSupported, useTaskPip } from "./task-pip";

type FakePipWindow = Window & {
  dispatchEvent: (event: Event) => boolean;
  close: ReturnType<typeof vi.fn>;
};

function createFakePipWindow(): FakePipWindow {
  const doc = document.implementation.createHTMLDocument("pip");
  const target = new EventTarget();
  const win = {
    document: doc,
    closed: false,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    close: vi.fn()
  };

  win.close.mockImplementation(() => {
    win.closed = true;
    win.dispatchEvent(new Event("pagehide"));
  });

  return win as unknown as FakePipWindow;
}

function stubPipApi(win: FakePipWindow) {
  const requestWindow = vi.fn().mockResolvedValue(win);

  vi.stubGlobal("documentPictureInPicture", { requestWindow, window: null });

  return requestWindow;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTaskPip", () => {
  it("reports unsupported and refuses to open when the API is absent", async () => {
    expect(isTaskPipSupported()).toBe(false);

    const { result } = renderHook(() => useTaskPip());

    expect(result.current.isSupported).toBe(false);

    let opened = true;

    await act(async () => {
      opened = await result.current.openTaskPip();
    });

    expect(opened).toBe(false);
    expect(result.current.pipWindow).toBeNull();
  });

  it("reports unsupported when the object exists but requestWindow is absent", async () => {
    // Seen in embedded browsers: a permissions policy leaves the object in
    // place with no method. An object-only check would offer a dead button.
    vi.stubGlobal("documentPictureInPicture", { window: null });

    expect(isTaskPipSupported()).toBe(false);

    const { result } = renderHook(() => useTaskPip());

    let opened = true;

    await act(async () => {
      opened = await result.current.openTaskPip();
    });

    expect(opened).toBe(false);
    expect(result.current.pipWindow).toBeNull();
  });

  it("opens the floating window, styles it and exposes it for the portal", async () => {
    const fakeWin = createFakePipWindow();
    const requestWindow = stubPipApi(fakeWin);

    // A stylesheet in the opener that must be copied into the PiP document.
    const style = document.createElement("style");

    style.textContent = ".pip-style-probe { color: rgb(255, 0, 0); }";
    document.head.appendChild(style);

    try {
      const { result } = renderHook(() => useTaskPip());

      expect(result.current.isSupported).toBe(true);

      let opened = false;

      await act(async () => {
        opened = await result.current.openTaskPip();
      });

      expect(opened).toBe(true);
      expect(requestWindow).toHaveBeenCalledWith({ width: 380, height: 440 });
      expect(result.current.pipWindow).toBe(fakeWin);
      // Scoped styles only reach the portal content through this class.
      expect(fakeWin.document.body.className).toBe("fh-recording pip-body");

      const copied = Array.from(fakeWin.document.head.querySelectorAll("style"))
        .map((node) => node.textContent)
        .join("\n");

      expect(copied).toContain(".pip-style-probe");
    } finally {
      style.remove();
    }
  });

  it("does not open a second window while one is already floating", async () => {
    const fakeWin = createFakePipWindow();
    const requestWindow = stubPipApi(fakeWin);
    const { result } = renderHook(() => useTaskPip());

    await act(async () => {
      await result.current.openTaskPip();
    });
    await act(async () => {
      await result.current.openTaskPip();
    });

    expect(requestWindow).toHaveBeenCalledTimes(1);
  });

  it("returns false without state when the platform refuses to open", async () => {
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn().mockRejectedValue(new DOMException("NotAllowedError")),
      window: null
    });

    const { result } = renderHook(() => useTaskPip());

    let opened = true;

    await act(async () => {
      opened = await result.current.openTaskPip();
    });

    expect(opened).toBe(false);
    expect(result.current.pipWindow).toBeNull();
  });

  it("resets state when the participant closes the floating window", async () => {
    const fakeWin = createFakePipWindow();

    stubPipApi(fakeWin);

    const { result } = renderHook(() => useTaskPip());

    await act(async () => {
      await result.current.openTaskPip();
    });

    expect(result.current.pipWindow).toBe(fakeWin);

    act(() => {
      fakeWin.dispatchEvent(new Event("pagehide"));
    });

    await waitFor(() => {
      expect(result.current.pipWindow).toBeNull();
    });
  });

  it("closes the floating window explicitly via closeTaskPip", async () => {
    const fakeWin = createFakePipWindow();

    stubPipApi(fakeWin);

    const { result } = renderHook(() => useTaskPip());

    await act(async () => {
      await result.current.openTaskPip();
    });

    act(() => {
      result.current.closeTaskPip();
    });

    expect(fakeWin.close).toHaveBeenCalledTimes(1);
    expect(result.current.pipWindow).toBeNull();
  });

  it("closes the floating window when the owning component unmounts", async () => {
    const fakeWin = createFakePipWindow();

    stubPipApi(fakeWin);

    const { result, unmount } = renderHook(() => useTaskPip());

    await act(async () => {
      await result.current.openTaskPip();
    });

    unmount();

    expect(fakeWin.close).toHaveBeenCalledTimes(1);
  });
});
