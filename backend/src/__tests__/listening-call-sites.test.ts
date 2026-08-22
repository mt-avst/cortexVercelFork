import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/**
 * NO TEST FILE MAY BIND ITS OWN SERVER.
 *
 * This asks a different question from listening-helper.test.ts, and the
 * difference is the whole reason it exists. Those tests count the syscall and
 * prove the helper WORKS - but they can only see a file they import. A new test
 * file, or a merge bringing one in, that calls `request(app)` directly is
 * invisible to them: it binds and closes an ephemeral port per request, brings
 * back its share of the ~20% per-run failure rate, and every counter stays at
 * one.
 *
 * Raised by a peer reviewing the change, who put it exactly right: the check
 * that a call site was MISSED is not the check that the helper works.
 *
 * That gap is not hypothetical here. This change converted 414 call sites, and
 * it lands into a repository where two other branches are adding test files
 * with supertest calls of their own. Without this, the conversion is correct on
 * the day it merges and decays from then on, silently, with a green suite.
 *
 * A source scan rather than a runtime check, because the failure is a file that
 * never runs the helper at all - there is nothing to instrument.
 */

const backendSrc = path.resolve(__dirname, '..');

/**
 * The one file allowed to bind directly, and why.
 *
 * `listening-helper.test.ts` measures the BARE app on purpose: its control arm
 * asserts that an unconverted call site binds once per request, which is what
 * makes the "binds exactly once" assertion beside it mean anything. Without a
 * control, a broken counter reads as a perfect fix.
 *
 * Named as one path rather than a pattern. A pattern would quietly re-admit
 * the next file that happened to match it.
 */
const ALLOWED = new Set([
  '__tests__/listening-helper.test.ts',
  // The scanner itself. Its control case below holds sample offender lines as
  // STRINGS, and on the first run this file flagged its own fixtures - which
  // is the scan working, not a defect, but it has to be exempted to say so.
  '__tests__/listening-call-sites.test.ts'
]);

function testFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

/**
 * `request(x)` / `request.agent(x)` whose argument is not `listening(...)`.
 *
 * Comment lines are dropped first: several docblocks in this change discuss
 * `request(app)` by name, and a scan that flagged prose would be turned off
 * within a week.
 */
const UNCONVERTED = /\brequest(?:\.agent)?\(\s*(?!listening\s*\()[A-Za-z_$]/;

describe('supertest call sites', () => {
  it('all go through listening(), so none binds its own server', () => {
    const offenders: string[] = [];

    for (const file of testFiles(backendSrc)) {
      const relative = path.relative(backendSrc, file);
      if (ALLOWED.has(relative)) continue;

      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes('supertest')) continue;

      source.split('\n').forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '');
        if (code.trimStart().startsWith('*')) return;
        if (UNCONVERTED.test(code)) {
          offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('can actually see an offender, when there is one', () => {
    // The control. An assertion that a list is empty passes just as well when
    // the scan is broken, and this file's whole value is that it fails for a
    // file nothing else looks at.
    const sample = [
      "const r = await request(app).get('/x');",
      'const s = await request.agent(ownerApp);',
      'const ok = await request(listening(app)).get(*/x*);'
    ];

    expect(sample.filter((line) => UNCONVERTED.test(line))).toHaveLength(2);
  });
});
