import {
  targetRolesSchema,
  TARGET_ROLES_TOO_MANY,
  TARGET_ROLE_EMPTY,
  TARGET_ROLE_TOO_LONG,
} from '../../../../shared/target-roles';

const firstError = (input: unknown): string | undefined => {
  const result = targetRolesSchema.safeParse(input);
  return result.success ? undefined : result.error.issues[0]?.message;
};

const parsed = (input: unknown): string[] | undefined => {
  const result = targetRolesSchema.safeParse(input);
  return result.success ? result.data : undefined;
};

describe('targetRolesSchema', () => {
  it('accepts a small list of roles', () => {
    expect(parsed(['Product Manager', 'ScriptRunner admin'])).toEqual([
      'Product Manager',
      'ScriptRunner admin',
    ]);
  });

  it('accepts an empty array (no advertised audience)', () => {
    expect(parsed([])).toEqual([]);
  });

  it('trims each entry before validating and storing', () => {
    expect(parsed(['  Product Manager  '])).toEqual(['Product Manager']);
  });

  it('rejects a blank or whitespace-only entry', () => {
    expect(firstError([''])).toBe(TARGET_ROLE_EMPTY);
    expect(firstError(['   '])).toBe(TARGET_ROLE_EMPTY);
  });

  // Policy cap pinned as a LITERAL (TARGET_ROLE_MAX_CHARS = 60): a test that
  // derived it from the constant could not see the constant change.
  it('holds each entry to 60 characters', () => {
    expect(parsed(['a'.repeat(60)])).toEqual(['a'.repeat(60)]);
    expect(firstError(['a'.repeat(61)])).toBe(TARGET_ROLE_TOO_LONG);
  });

  // Policy cap pinned as a LITERAL (TARGET_ROLES_MAX_COUNT = 10).
  it('holds the list to 10 entries', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `Role ${i}`);
    expect(parsed(ten)).toHaveLength(10);
    expect(firstError([...ten, 'Role 10'])).toBe(TARGET_ROLES_TOO_MANY);
  });

  // The count cap is checked on the RAW array, so near-duplicates cannot slip
  // past it: eleven entries that dedupe to fewer still fail the cap.
  it('applies the count cap before deduping', () => {
    const elevenSame = Array.from({ length: 11 }, () => 'Product Manager');
    expect(firstError(elevenSame)).toBe(TARGET_ROLES_TOO_MANY);
  });

  it('dedupes case-insensitively, keeping the first spelling', () => {
    expect(parsed(['Jira admin', 'jira admin', 'JIRA ADMIN'])).toEqual([
      'Jira admin',
    ]);
  });

  it('rejects a non-array', () => {
    expect(targetRolesSchema.safeParse('Product Manager').success).toBe(false);
    expect(targetRolesSchema.safeParse({ role: 'PM' }).success).toBe(false);
  });

  it('rejects a non-string entry', () => {
    expect(targetRolesSchema.safeParse(['PM', 42]).success).toBe(false);
  });
});
