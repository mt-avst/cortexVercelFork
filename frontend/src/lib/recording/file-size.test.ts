import { describe, expect, it } from "vitest";

import { formatFileSize } from "./file-size";

describe("formatFileSize", () => {
  it("scales past kilobytes, because real recordings are not small", () => {
    expect(formatFileSize(150 * 1024 * 1024)).toBe("150 MB");
  });

  it("keeps small captures in kilobytes", () => {
    expect(formatFileSize(2048)).toBe("2 KB");
  });

  it("shows one decimal only where it carries information", () => {
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2 MB");
  });

  it("scales to gigabytes at the recording cap", () => {
    // Recordings are capped at 2GB (FIRSTHAND_MAX_RECORDING_BYTES).
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe("2 GB");
  });

  it("handles bytes and zero without producing nonsense", () => {
    expect(formatFileSize(0)).toBe("0 bytes");
    expect(formatFileSize(1)).toBe("1 byte");
    expect(formatFileSize(512)).toBe("512 bytes");
  });
});
