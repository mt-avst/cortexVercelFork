import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

/**
 * #169 renamed the researcher workspace (`/admin`) to "Create & Manage" and the
 * participant study list (`/`) to "Participate". The first pass missed several
 * places that still called `/admin` "Dashboard", each a one-off string with no
 * test on it. The per-site tests pin the sites known today; this scan fails for
 * a NEW string that names either page the old way.
 *
 * It parses every shipped .ts/.tsx in frontend/src, backend/src and shared
 * (tests excluded) and reads only string literals, template text and JSX text,
 * so comments and code names can never match, and a phrase split across JSX
 * lines is read as one. Any stand-alone "dashboard" in that text is a finding
 * unless ALLOWED names it: nothing in the product is called a dashboard now.
 *
 * Deliberately NOT retired: the "Browse studies" button on My bookings' empty
 * state (an action, not the page's name) and the "Admin" role label (a role,
 * not a page).
 */

const REPO = join(__dirname, '..', '..', '..', '..');
const ROOTS = ['frontend/src', 'backend/src', 'shared'];

const RETIRED: RegExp[] = [
  /(?<![-\w/])dashboard(?![-\w])/i, // "admin-dashboard-page" and "adminDashboard" are code, not copy
  /\b(back|return|exit|go) to (the )?(admin|studies|browse studies|cortex)\b/i, // "Back to Cortex" meant /
  /\bBrowse Studies\b/, // the retired header label; the lower-case action is kept
  /\bAdmin · Cortex\b/,
  /\bBrowse studies · Cortex\b/i,
];

/** Literal text that matches a pattern but is not a page name, each with its reason. */
const ALLOWED: ReadonlyArray<{ file: string; text: string; why: string }> = [
  { file: 'frontend/src/pages/Admin.tsx', text: 'Failed to load dashboard stats', why: 'log message, not shown' },
  {
    file: 'frontend/src/components/OpportunityForm/BasicInfoTab.tsx',
    text: 'e.g., Help us test the new dashboard interface to improve user experience',
    why: 'example study content',
  },
  { file: 'frontend/src/components/OpportunityForm/BasicInfoTab.tsx', text: 'e.g., Mobile App, Dashboard, API, etc.', why: 'example study content' },
  {
    file: 'frontend/src/components/recording/StudyRunner.tsx',
    text: 'Go back to the Cortex tab to see what happened. Nothing you do here is being recorded.',
    why: 'the browser tab Cortex runs in, not a page',
  },
];

const shippedFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return ['__tests__', 'node_modules', 'dist'].includes(name) ? [] : shippedFiles(full);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });

/** Every string literal, template chunk and JSX text in `source`, whitespace collapsed. */
const literalTexts = (source: string, tsx: boolean): string[] => {
  const file = ts.createSourceFile('scan.tsx', source, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      // A CSS block in a string carries its own comments; those are notes too.
      const text = node.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
      if (text) out.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};

const findRetired = (source: string, tsx = true): string[] =>
  literalTexts(source, tsx).filter((text) => RETIRED.some((re) => re.test(text)));

describe('retired page names (#169)', () => {
  const files = ROOTS.flatMap((root) => shippedFiles(join(REPO, root)));

  it('reads every source root', () => {
    // A path mistake that read nothing would pass the scan below vacuously.
    for (const root of ROOTS) {
      expect(files.filter((f) => relative(REPO, f).startsWith(`${root}/`)).length, root).toBeGreaterThan(10);
    }
  });

  it('finds no user-facing string that names /admin or / the old way', () => {
    const hits = files.flatMap((file) => {
      const rel = relative(REPO, file);
      return findRetired(readFileSync(file, 'utf8'), file.endsWith('.tsx'))
        .filter((text) => !ALLOWED.some((a) => a.file === rel && a.text === text))
        .map((text) => `${rel}: ${text}`);
    });
    expect(hits, 'rename it to the new page name, or add an ALLOWED entry with its reason').toEqual([]);
  });

  it('every allow-list entry is still needed, so none outlives its reason', () => {
    const scanned = files.map((f) => relative(REPO, f));
    for (const a of ALLOWED) {
      expect(scanned, `${a.file} is not a file the scan reads - fix or delete the ALLOWED entry`).toContain(a.file);
      const source = readFileSync(join(REPO, a.file), 'utf8');
      expect(literalTexts(source, a.file.endsWith('.tsx')), `${a.file}: "${a.text}" is gone - fix or delete the ALLOWED entry`).toContain(a.text);
      expect(RETIRED.some((re) => re.test(a.text)), `${a.file}: "${a.text}" matches no RETIRED pattern - delete the ALLOWED entry`).toBe(true);
    }
  });

  it('the control: the scan catches each retired form, and not the kept ones', () => {
    const planted = [
      'const a = <a href="/admin">Admin Dashboard</a>;',
      'const a = <button>Back to Dashboard</button>;',
      'const a = <button>Back to\n  Dashboard</button>;',
      'const a = <p>Your study is on the <strong>dashboard</strong>.</p>;',
      "const a = 'Go to the dashboard';",
      'const a = `Add them from the dashboard.`;',
      "const a = 'Back to admin';",
      "const a = 'Back to studies';",
      "const a = 'Back to Browse studies';",
      'const a = <Link to="/">Back to Cortex</Link>;',
      'const a = <button aria-label="Navigate back to Cortex home" />;',
      "useDocumentTitle('Admin · Cortex');",
      "useDocumentTitle('Browse studies · Cortex');",
      'const a = <span>Browse Studies</span>;',
      // A "/*" inside a string must not hide what follows it.
      'const a = <input accept="video/*" />;\nconst b = <span>Back to Dashboard</span>;',
    ];
    for (const source of planted) expect(findRetired(source), source).not.toEqual([]);

    const kept = [
      '/* Back to Dashboard, in a comment */',
      '// Exit to dashboard, in a comment',
      'const a = <div>{/* Return to Dashboard */}</div>;',
      'const a = <button>Browse studies</button>;',
      "const a = user.role === 'researcher_admin' ? 'Admin' : 'Participant';",
      "import { summarise } from '../utils/adminDashboard';",
      'const a = <div className="admin-dashboard-page" />;',
      'const a = <button>Back to Create & Manage</button>;',
      'const a = <button>Back to Participate</button>;',
    ];
    for (const source of kept) expect(findRetired(source), source).toEqual([]);
  });
});
