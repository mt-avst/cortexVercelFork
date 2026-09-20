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
 * Pre-existing offences outside #140's scope (opportunity-analytics and
 * session-review only). ponytail: known debt, not fixed here - #140 named
 * seven specific files. Each entry is `file:token`; remove a line as its
 * file is fixed so this allowlist only ever shrinks. A NEW occurrence
 * anywhere, including a new line in an allowlisted file, still fails.
 */
const KNOWN_DEBT = new Set([
  'components/CalendarGrid.tsx:--color-emerald-500',
  'components/OpportunityForm/ConsentStep.tsx:--border-color',
  'components/OpportunityForm/DescribeIt.tsx:--fs-border',
  'components/OpportunityForm/ExternalLinkTab.tsx:--fs-border',
  'styles/_components.css:--dynamic-hover-color',
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
