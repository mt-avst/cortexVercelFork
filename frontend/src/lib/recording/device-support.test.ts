import { describe, expect, it } from "vitest";

import { assessDeviceSupport } from "./device-support";

const desktopChrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const iphoneSafari =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

describe("assessDeviceSupport", () => {
  it("lets a supported desktop through", () => {
    expect(
      assessDeviceSupport({
        userAgent: desktopChrome,
        viewportWidth: 1440,
        hasGetDisplayMedia: true
      })
    ).toEqual({ canRun: true, reason: null });
  });

  it("stops a phone before it can consent to being recorded", () => {
    const result = assessDeviceSupport({
      userAgent: iphoneSafari,
      viewportWidth: 390,
      hasGetDisplayMedia: false
    });

    expect(result.canRun).toBe(false);
    expect(result.reason).toMatch(/laptop or desktop/i);
  });

  it("stops a narrow desktop window, which is fixable", () => {
    const result = assessDeviceSupport({
      userAgent: desktopChrome,
      viewportWidth: 800,
      hasGetDisplayMedia: true
    });

    expect(result.canRun).toBe(false);
    // Actionable where the phone case is not: this one says resize.
    expect(result.reason).toMatch(/wider/i);
  });

  it("stops a browser that cannot share a screen at all", () => {
    const result = assessDeviceSupport({
      userAgent: desktopChrome,
      viewportWidth: 1440,
      hasGetDisplayMedia: false
    });

    expect(result.canRun).toBe(false);
    expect(result.reason).toMatch(/screen/i);
  });

  it("does not gate before hydration, where nothing is knowable yet", () => {
    // The welcome stage renders before the device snapshot is collected; a null
    // snapshot must not flash a blocker at a participant on a good machine.
    expect(assessDeviceSupport(null)).toEqual({ canRun: true, reason: null });
  });
});
