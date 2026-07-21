const units = ["bytes", "KB", "MB", "GB"] as const;

/**
 * A file size a participant can read.
 *
 * The completion screen used to divide by 1024 and append " KB" regardless, so
 * a real 150MB recording reported "153600 KB". Recordings run to 2GB.
 */
export function formatFileSize(bytes: number) {
  if (bytes === 1) {
    return "1 byte";
  }

  if (bytes < 1024) {
    return `${bytes} bytes`;
  }

  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  // One decimal only where it says something: 1.5 MB, but 2 MB rather than
  // 2.0 MB.
  const rounded = Math.round(value * 10) / 10;

  return `${rounded} ${units[unitIndex]}`;
}
