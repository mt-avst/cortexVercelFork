export const defaultRecordingMimeType = "video/webm";

export function normalizeRecordingMimeType(
  mimeType: string | null | undefined
) {
  if (!mimeType) {
    return defaultRecordingMimeType;
  }

  const trimmedMimeType = mimeType.trim().toLowerCase();

  if (!trimmedMimeType) {
    return defaultRecordingMimeType;
  }

  const [baseMimeType] = trimmedMimeType.split(";", 1);

  return baseMimeType?.trim() || defaultRecordingMimeType;
}
