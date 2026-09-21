import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * cto/AdaptaLabs#140: a `var(--undefined-token, <colour literal>)` silently
 * renders its literal fallback in BOTH themes, because the custom property
 * never resolves. opportunity-analytics and session-review did this with
 * --cortex-border, --cortex-surface, --cortex-orange and --bs-danger - none
 * defined anywhere in src - so borders/surfaces/error text ignored the theme
 * entirely (near-invisible hairlines in light, mis-contrasted text).
 *
 * The two-literal contrast checks elsewhere in this directory (accent-fill-
 * policy, brand-identity) compare a hardcoded value against its theme-aware
 * replacement - they never catch a token that was never defined, because
 * there is no theme-aware value to compare against. This test closes that
 * gap: every `var(--x, <colour>)` in src must have `--x` defined by some
 * stylesheet in the project, so a broken/renamed token fails here BY NAME
 * instead of rendering a silently-wrong fallback colour.
 */

const SRC_DIR = join(__dirname, '..', '..');

const walk = (dir: string, exts: string[]): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full, exts));
    } else if (exts.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
};

const cssFiles = walk(SRC_DIR, ['.css']);
const sourceFiles = walk(SRC_DIR, ['.ts', '.tsx', '.css']).filter(
  (f) => !f.includes('__tests__') && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx')
);

const definedTokens = new Set<string>();
for (const file of cssFiles) {
  const css = readFileSync(file, 'utf8');
  for (const m of css.matchAll(/(?:^|[;{])\s*(--[a-z0-9-]+)\s*:/gim)) {
    definedTokens.add(m[1]);
  }
}

const COLOR_FALLBACK = /var\((--[a-z0-9-]+)\s*,\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))\)/gi;

/**
 * Pre-existing offences, carried as an allowlist so the guard can be strict
 * about everything else. Each entry is `file:token`; remove a line as its file
 * is fixed, so this list only ever shrinks. A NEW occurrence anywhere,
 * including a new line in an allowlisted file, still fails.
 *
 * MEASURED DOWN FROM SIX TO ONE by cto/AdaptaLabs#141, which fixed the five
 * others in source. The remaining debt was established by emptying this set
 * and reading what the guard still reported, rather than by reasoning about
 * which entries the fix had covered.
 *
 * THE GUARD READS RAW FILE CONTENT, COMMENTS INCLUDED. So a comment that
 * QUOTES a `var(--undefined-token, #hex)` shape - the obvious way to record
 * what a line used to be - reports itself as a live offence and pins its own
 * entry here for ever, long after the code is fixed. #141 hit exactly that on
 * `components/CalendarGrid.tsx:--color-emerald-500`: the source was fixed and
 * the entry still could not be removed, because the comment explaining the fix
 * matched the regex. Describe an old value, do not quote it.
 */
const KNOWN_DEBT = new Set([
  'styles/_components.css:--accent-border-color'
]);

interface Offence {
  file: string;
  token: string;
  fallback: string;
}

const offences: Offence[] = [];
for (const file of sourceFiles) {
  const content = readFileSync(file, 'utf8');
  const relFile = relative(SRC_DIR, file);
  for (const m of content.matchAll(COLOR_FALLBACK)) {
    const [, token, fallback] = m;
    if (!definedTokens.has(token) && !KNOWN_DEBT.has(`${relFile}:${token}`)) {
      offences.push({ file: relFile, token, fallback });
    }
  }
}

describe('undefined design tokens with a colour-literal fallback', () => {
  it('finds at least one legitimately-defined token (control)', () => {
    expect(definedTokens.has('--brand-orange-500')).toBe(true);
    expect(definedTokens.has('--border-subtle-current')).toBe(true);
  });

  it('flags a known-undefined token as an offence (control)', () => {
    const probe = "const style = { color: 'var(--totally-made-up-token, #dc3545)' }";
    const matches = [...probe.matchAll(COLOR_FALLBACK)];
    expect(matches).toHaveLength(1);
    expect(definedTokens.has(matches[0][1])).toBe(false);
  });

  it('has no var(--undefined, <colour>) fallbacks anywhere under src', () => {
    if (offences.length > 0) {
      const detail = offences
        .map((o) => `  ${o.file}: ${o.token} falls back to ${o.fallback}`)
        .join('\n');
      throw new Error(
        `${offences.length} undefined token(s) with a colour fallback - each one renders ` +
          `the same fallback colour in every theme:\n${detail}`
      );
    }
    expect(offences).toHaveLength(0);
  });
});

/**
 * THE OTHER HALF OF THE SAME DEFECT: a BARE `var` reference to a token that
 * does not exist.
 *
 * The guard above only sees the two-argument form, where a colour literal
 * sits behind the token as a fallback. A bare reference to a misspelt or
 * renamed token is strictly worse and completely invisible to it: the
 * property simply does not apply, so the element inherits whatever its
 * parent had. Text keeps rendering - in the wrong colour, with no fallback
 * to point at and nothing in the console.
 *
 * SCOPE, STATED. This arm covers the file set cto/AdaptaLabs#141 touched,
 * not all of src. That is not because the rest is clean - it has not been
 * measured - but because this round changed these files and owes a guard
 * over its own blast radius. Widening it is a separate, measured piece of
 * work.
 */

/**
 * Tokens a component SETS at runtime through an inline style property, which
 * are real definition sites that no stylesheet declares. Kept separate from
 * `definedTokens` rather than folded into it, so the allowlist and the
 * behaviour of the #140 guard above are left exactly as they were.
 */
const inlineSetTokens = new Set<string>();
for (const file of walk(SRC_DIR, ['.ts', '.tsx'])) {
  const content = readFileSync(file, 'utf8');
  for (const m of content.matchAll(/["'`](--[a-z0-9-]+)["'`]\s*(?:as[^:]*)?:/g)) {
    inlineSetTokens.add(m[1]);
  }
}

const resolvableTokens = new Set([...definedTokens, ...inlineSetTokens]);

/** A `var` reference with NO fallback argument - it resolves or it vanishes. */
const BARE_VAR = /var\(\s*(--[a-z0-9-]+)\s*\)/gi;

/** The source files this branch changed. */
const TOUCHED_FILES = [
  'components/AdminFeedback.tsx',
  'components/CalendarGrid.tsx',
  'components/OpportunityForm/ConsentStep.tsx',
  'components/OpportunityForm/DescribeIt.tsx',
  'components/OpportunityForm/ExternalLinkTab.tsx',
  'components/OpportunityForm/question-list.css',
  'components/OpportunityForm/screener-questions.css',
  'components/admin-feedback.css',
  'styles/_components.css',
  'styles/_themes.css',
];

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const bareReferences = (source: string): string[] =>
  [...stripComments(source).matchAll(BARE_VAR)].map((m) => m[1]);

describe('bare token references in the files this branch touched', () => {
  it('resolves every bare token reference to a definition', () => {
    const unresolved: string[] = [];
    let scanned = 0;

    for (const relFile of TOUCHED_FILES) {
      const content = readFileSync(join(SRC_DIR, relFile), 'utf8');
      for (const token of bareReferences(content)) {
        scanned += 1;
        if (!resolvableTokens.has(token)) unresolved.push(`${relFile}: ${token}`);
      }
    }

    // An empty offence list from a scan that read nothing is indistinguishable
    // from a clean bill of health, so the scan has to prove it ran.
    expect(scanned).toBeGreaterThan(500);
    expect([...new Set(unresolved)]).toEqual([]);
  });

  it('reports a misspelt token as unresolved, on real file content', () => {
    // CONTROL. Not a hand-written probe string: a real file from the set
    // above, with one character dropped from the name of whichever token it
    // happens to reference first. Derived rather than hardcoded on purpose -
    // a control pinned to one named declaration goes red the moment an
    // unrelated edit touches that line, and an arm that cries wolf is an arm
    // somebody eventually weakens.
    const real = readFileSync(
      join(SRC_DIR, 'components/OpportunityForm/question-list.css'),
      'utf8'
    );
    const [victim] = bareReferences(real);
    expect(resolvableTokens.has(victim)).toBe(true);

    const typo = victim.slice(0, -1);
    expect(resolvableTokens.has(typo)).toBe(false);
    const misspelt = real.split(`var(${victim})`).join(`var(${typo})`);
    expect(misspelt).not.toEqual(real);

    // The unmutated file is clean, so the scanner is not simply saying yes to
    // everything; the mutated one reports the typo. Asserted as a CONTAINS
    // rather than an equality, so a separate real offence elsewhere in the
    // file is reported by the arm above and does not also redden this one.
    expect(bareReferences(real).filter((t) => !resolvableTokens.has(t))).toEqual([]);
    const found = bareReferences(misspelt).filter((t) => !resolvableTokens.has(t));
    // Missing here would mean the scanner has stopped detecting anything, and
    // the arm above is then asserting nothing at all.
    expect(found).toContain(typo);
  });

  it('counts the runtime set tokens as defined, since a stylesheet never declares them', () => {
    // CONTROL on the widening above: these two are set from a component's
    // inline style and referenced from the stylesheets, so without this the
    // first arm would report two false offences and somebody would reach for
    // an allowlist instead.
    expect(inlineSetTokens.has('--study-type-color')).toBe(true);
    expect(inlineSetTokens.has('--cal-content-w')).toBe(true);
    expect(definedTokens.has('--study-type-color')).toBe(false);
  });
});
