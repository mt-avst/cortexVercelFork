/**
 * Parse integer with default fallback
 */
export function parseIntSafe(value: unknown, defaultValue: number = 0): number {
  if (typeof value === 'number') {
    return isNaN(value) ? defaultValue : value;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

/**
 * Serialize date for API response - handles Date objects, strings, and null
 */
export function serializeDate(date: unknown): string | null {
  if (!date) return null;
  if (date instanceof Date) {
    return date.toISOString();
  }
  if (typeof date === 'string') {
    // If already ISO string, return as-is
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(date)) {
      return date;
    }
    // Try to parse and convert
    try {
      return new Date(date).toISOString();
    } catch {
      return null;
    }
  }
  try {
    return new Date(date).toISOString();
  } catch {
    return null;
  }
}

/**
 * Serialize database row with date fields
 */
export function serializeRow<T extends Record<string, any>>(
  row: T,
  dateFields: string[] = ['created_at', 'updated_at', 'last_activity_date', 'cancelled_at']
): T {
  const serialized = { ...row };
  for (const field of dateFields) {
    if (field in serialized) {
      (serialized as any)[field] = serializeDate(serialized[field]);
    }
  }
  return serialized;
}

