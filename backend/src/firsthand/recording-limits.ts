const DEFAULT_MAXIMUM_RECORDING_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Upper bound for a single recording upload. Overridable via
 * FIRSTHAND_MAX_RECORDING_BYTES so integration tests can exercise the
 * rejection path without moving gigabytes.
 */
export function getMaximumRecordingSizeBytes(): number {
  const configured = process.env.FIRSTHAND_MAX_RECORDING_BYTES?.trim();

  if (!configured) {
    return DEFAULT_MAXIMUM_RECORDING_SIZE_BYTES;
  }

  const parsed = Number(configured);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid FIRSTHAND_MAX_RECORDING_BYTES "${configured}": expected a positive integer.`
    );
  }

  return parsed;
}
