import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One vocabulary in user-facing backend errors (V-18): the product calls them
 * STUDIES, so no error message a caller can see may say "opportunity".
 *
 * SCOPE, stated so the "returns 0" claim is not wider than the check:
 *   - Walks every *.ts under backend/src, excluding __tests__ dirs and *.test.ts.
 *   - Extracts only USER-FACING message text: the first string literal of a
 *     `throw new <X>Error(...)`, and the value of an `error:`/`message:` object
 *     property (the shape of `res.status(n).json({ error: '...' })`). Positional
 *     logger strings (`logger.error('...')`) are internal and out of scope.
 *   - For template literals, `${...}` expressions are stripped before matching,
 *     so a constant NAME that contains "opportunity"
 *     (`${MAX_OPPORTUNITY_SEARCH_LENGTH}`) is not a prose hit.
 *   - case-insensitive match on /opportunit/.
 *
 * ALLOW-LIST (identifiers, not prose), each justified:
 *   - 'opportunity_id is required' — names the wire request field, which is
 *     deliberately kept `opportunity_id` across the API (row-18 decision).
 *
 * Fails BY NAME on main: 11 prose strings in bookings.ts and session-outputs.ts
 * still say "opportunity". Passes once V-18 renames them to "study".
 */

const ALLOWED_LITERALS = new Set<string>([
  'opportunity_id is required',
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
      out.push(...tsFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Remove ${...} interpolations so a constant name is not read as prose. */
function stripInterpolations(literal: string): string {
  return literal.replace(/\$\{[^}]*\}/g, '');
}

function userFacingMessages(source: string): string[] {
  const messages: string[] = [];
  // throw new <X>Error('...') | "..." | `...`
  const throwRe = /throw new [A-Za-z]*Error\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  // error: '...' | message: '...'  (object-property shape used by res.json)
  const propRe = /\b(?:error|message)\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  for (const re of [throwRe, propRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      messages.push(m[2]);
    }
  }
  return messages;
}

describe('user-facing backend errors use the study vocabulary (V-18)', () => {
  const root = join(__dirname, '..', '..'); // backend/src
  const files = tsFiles(root);

  it('collects a non-trivial corpus of files to scan (control against an empty walk)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no user-facing error message says "opportunity"', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const raw of userFacingMessages(source)) {
        if (ALLOWED_LITERALS.has(raw)) continue;
        if (/opportunit/i.test(stripInterpolations(raw))) {
          offenders.push(`${file.replace(root, 'backend/src')}: ${JSON.stringify(raw)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
