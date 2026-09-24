import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * #169 renamed the researcher workspace (`/admin`) to "Create & Manage" and the
 * participant study list (`/`) to "Participate". The first pass missed four
 * places that still called `/admin` "Dashboard", because each was a one-off
 * string with no test on it. The per-site tests pin the sites known today;
 * this scan fails for a NEW string that names either page the old way.
 *
 * It reads every shipped .ts/.tsx under frontend/src (tests excluded) with
 * comments stripped, so notes about the old names stay allowed. Code names such
 * as `adminDashboard.ts` or the `admin-dashboard-page` class are not matched:
 * every pattern is a phrase a person would read.
 *
 * Deliberately NOT retired: the "Browse studies" button on My bookings' empty
 * state (an action, not the page's name) and the "Admin" role label in the
 * profile menu (a role, not a page).
 */

const SRC = join(__dirname, '..', '..');

const RETIRED: RegExp[] = [
  /admin dashboard/i,
  /\b(back|return|exit) to (the )?(admin|dashboard|studies)\b/i,
  /\bfrom the dashboard\b/i,
  /\bcortex dashboard\b/i,
  /['"`]Admin · Cortex/,
  /Browse studies · Cortex/i,
  /Browse Studies/, // the retired header label; the lower-case action button is kept
];

const shippedFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : shippedFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });

/** Block comments (JSX comments included) and whole-line // comments. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const findRetired = (source: string): string[] =>
  stripComments(source)
    .split('\n')
    .filter((line) => RETIRED.some((re) => re.test(line)))
    .map((line) => line.trim());

describe('retired page names (#169)', () => {
  it('reads a real number of shipped source files', () => {
    // A path mistake that read nothing would pass the scan below vacuously.
    expect(shippedFiles(SRC).length).toBeGreaterThan(100);
  });

  it('finds no user-facing string that names /admin or / the old way', () => {
    const hits = shippedFiles(SRC).flatMap((file) =>
      findRetired(readFileSync(file, 'utf8')).map((line) => `${relative(SRC, file)}: ${line}`)
    );
    expect(hits).toEqual([]);
  });

  it('the control: the scan catches each retired form, and not the kept ones', () => {
    const planted = [
      '<a href="/admin">Admin Dashboard</a>',
      'Back to Dashboard',
      'Return to Dashboard',
      'Exit to dashboard',
      'Back to admin',
      'Back to studies',
      'Add them from the dashboard.',
      'Browse the Cortex dashboard to find studies.',
      "useDocumentTitle('Admin · Cortex');",
      "useDocumentTitle('Browse studies · Cortex');",
      'Browse Studies',
    ];
    for (const line of planted) expect(findRetired(line), line).toEqual([line]);

    const kept = [
      '/* Back to Dashboard, in a comment */',
      '// Exit to dashboard, in a comment',
      'Browse studies',
      "user.role === 'researcher_admin' ? 'Admin' :",
      "import { summarise } from '../utils/adminDashboard';",
      'Back to Create & Manage',
    ];
    for (const line of kept) expect(findRetired(line), line).toEqual([]);
  });
});
