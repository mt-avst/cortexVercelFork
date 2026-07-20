export function buildStorageFileName(fileName: string) {
  const safeFileName = (fileName || "asset").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${Date.now()}-${crypto.randomUUID()}-${safeFileName}`;
}
