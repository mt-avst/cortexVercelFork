import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * A fill that carries text may not use an identity colour.
 *
 * The brand ramp's identity steps exist to be seen, not read off. Measured with
 * white text on them: 500 is 2.60, 700 is 3.87 in dark and 3.29 in light. None
 * of them reach the 4.5 that AA asks for small text, and `--brand-primary`
 * carried a comment in _tokens.css asserting the opposite for long enough that
 * nine separate rules put white text on it.
 *
 * Two things let that spread. The token said it was safe, and nothing could
 * contradict it: axe scans a resting DOM, so it never evaluates a `:hover`
 * fill, and it only judges what a scanned route actually renders - which the
 * leaderboard's active tab and the period buttons are not. Six of the nine were
 * invisible to every accessibility run this project has.
 *
 * So this reads the stylesheets instead of the page. It is a policy check, not
 * a contrast measurement: the measurement lives in e2e/accessibility.test.ts,
 * which resolves --accent-fill-text-safe in a real browser in both themes. This
 * one exists to catch the NEXT rule that pairs a light text colour with an
 * identity fill, in a state no scan can reach.
 */

const STYLES_DIR = join(__dirname, '..');

/** Ramp steps and aliases that must never sit behind text. */
const IDENTITY_FILLS = [
  '--brand-primary',
  '--brand-secondary',
  '--brand-headline',
  '--brand-orange-400',
  '--brand-orange-500',
  '--brand-orange-600',
  '--brand-orange-700',
  '--brand-orange-vibrant',
  '--fs-accent',
];

/**
 * Text colours light enough that an identity fill behind them fails AA. Kept
 * deliberately loose - #fff, #FFFFFF, white, and the CTA text tokens, which all
 * resolve to white.
 */
const LIGHT_TEXT = /(^|[^-\w])color\s*:\s*(#fff(fff)?\b|white\b|var\(--cta-text[\w-]*\))/i;

const declaresIdentityFill = (block: string): string | null => {
  const backgrounds = block.match(/(?:^|[;{\s])background(?:-color)?\s*:[^;]*/gi) || [];
  for (const declaration of backgrounds) {
    for (const token of IDENTITY_FILLS) {
      if (declaration.includes(`var(${token})`)) return token;
    }
  }
  return null;
};

/** Split a stylesheet into `selector { declarations }` blocks. */
const ruleBlocks = (css: string): Array<{ selector: string; body: string }> => {
  const blocks: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    blocks.push({ selector: match[1].trim().replace(/\s+/g, ' '), body: match[2] });
  }
  return blocks;
};

const cssFiles = readdirSync(STYLES_DIR).filter((name) => name.endsWith('.css'));

describe('accent fill policy', () => {
  it('finds the stylesheets it is supposed to be checking', () => {
    // A policy test that silently reads nothing passes forever.
    expect(cssFiles).toContain('_tokens.css');
    expect(cssFiles).toContain('_themes.css');
    expect(cssFiles).toContain('_components.css');
    expect(cssFiles).toContain('_utilities.css');
    expect(cssFiles.length).toBeGreaterThanOrEqual(6);
  });

  it.each(cssFiles)('%s puts no light text on an identity fill', (file) => {
    const css = readFileSync(join(STYLES_DIR, file), 'utf8');
    const offenders = ruleBlocks(css)
      .map(({ selector, body }) => {
        const token = declaresIdentityFill(body);
        if (!token || !LIGHT_TEXT.test(body)) return null;
        return `${selector} fills with var(${token}) and sets a near-white color`;
      })
      .filter((entry): entry is string => entry !== null);

    expect(
      offenders,
      `Use var(--accent-fill-text-safe) for a fill that carries text; it is defined in both themes and measures 5.77 under white on the unified #FF5A1F ramp.\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  /**
   * A hardcoded fill must declare its own text colour, and the pair must pass.
   *
   * The token checks above cannot see a raw hex, and the admin role badges were
   * exactly that: four Bootstrap 4 fills written inline in a component with
   * `!important` and no text colour, so the label fell through to `.badge`'s
   * --tag-text - white in dark, navy in light. A fixed fill under a colour that
   * flips per theme fails on one side or the other, and all four did.
   *
   * So this measures every rule that declares a hex background and a hex text
   * colour together, and requires 4.5.
   *
   * Two things it cannot see, stated so nobody reads a green run as more than
   * it is. It compares declarations WITHIN one rule, so a fill on a parent and
   * a colour on a child are invisible to it - that is exactly how
   * .calendar-slot-booked held white text on a 3.12 fill, and it was found only
   * by following .calendar-slot-selected, which happened to declare both, to
   * the sibling states that had to match it. And it does not resolve `var()`,
   * so a token-valued fill is checked by the browser test instead.
   *
   * It deliberately does NOT flag a hex background with no text colour. That
   * shape is what the badges had, but it is also what every page background and
   * every hover-fill-only rule has, and there are dozens of them - the first
   * version of this check produced twenty-odd false positives, which is a check
   * that gets deleted rather than one that gets fixed. The badges are pinned by
   * being declared as pairs now; the general case is caught where it is
   * measurable.
   */
  const HEX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i;

  const toRgb = (hex: string): [number, number, number] => {
    const raw = hex.replace('#', '');
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  };

  const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
    const channel = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [relativeLuminance(toRgb(a)), relativeLuminance(toRgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const declaration = (block: string, property: RegExp): string | null => {
    const match = block.match(property);
    return match ? match[0] : null;
  };

  /* Components carry CSS in template literals, which is where the badges lived.
     Walk for them rather than listing them: a hand-maintained list of files to
     check is a list somebody forgets to add the next one to, and the next one
     is precisely the case this exists to catch. */
  const SRC_DIR = join(STYLES_DIR, '..');

  const collectComponentStyles = (dir: string, found: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        collectComponentStyles(path, found);
      } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
        const contents = readFileSync(path, 'utf8');
        if (/background(-color)?\s*:\s*#[0-9a-fA-F]{3,6}/.test(contents)) found.push(path);
      }
    }
    return found;
  };

  const componentStyleFiles = collectComponentStyles(SRC_DIR);

  const sourcesToScan = [
    ...cssFiles.map((name) => ({ label: name, css: readFileSync(join(STYLES_DIR, name), 'utf8') })),
    ...componentStyleFiles.map((path) => ({
      label: path.slice(path.indexOf('src/')),
      css: readFileSync(path, 'utf8'),
    })),
  ];

  it.each(sourcesToScan.map((s) => [s.label, s.css]))(
    '%s pairs every hardcoded fill with a text colour that passes AA',
    (_label, css) => {
      const failures: string[] = [];
      for (const { selector, body } of ruleBlocks(css as string)) {
        const bg = declaration(body, /background(?:-color)?\s*:\s*#[0-9a-fA-F]{3,6}/);
        if (!bg) continue;
        const bgHex = bg.match(HEX)?.[0];
        if (!bgHex) continue;

        const fg = declaration(body, /(?:^|[;{\s])color\s*:\s*#[0-9a-fA-F]{3,6}/);
        const fgHex = fg?.match(HEX)?.[0];
        if (!fgHex) continue;

        const ratio = contrast(bgHex, fgHex);
        if (ratio < 4.5) {
          failures.push(`${selector} pairs ${fgHex} on ${bgHex} at ${ratio.toFixed(2)}, below 4.5`);
        }
      }
      expect(failures, failures.join('\n  ')).toEqual([]);
    }
  );

  it('the hex check can actually fail', () => {
    /* The measurement above is only worth having if it rejects something. This
       pins the arithmetic against the exact pair that started this: Bootstrap
       blue under white, which reads as obviously fine and is not. */
    expect(contrast('#007bff', '#ffffff')).toBeLessThan(4.5);
    expect(contrast('#E0F2FE', '#075985')).toBeGreaterThanOrEqual(4.5);
  });

  it('the safe fill is defined in BOTH themes, not just light', () => {
    /* The bug underneath the skip link: --accent-fill-on-light is declared only
       under body.theme-light, so `var(--accent-fill-on-light, var(--brand-primary))`
       silently took the fallback arm in dark and landed on 3.87. A token used by
       unscoped rules has to exist wherever those rules apply. */
    const tokens = readFileSync(join(STYLES_DIR, '_tokens.css'), 'utf8');
    const themes = readFileSync(join(STYLES_DIR, '_themes.css'), 'utf8');

    expect(tokens, '--accent-fill-text-safe must have a base (dark) value in _tokens.css')
      .toMatch(/--accent-fill-text-safe\s*:/);

    const lightBlock = themes.slice(themes.indexOf('body.theme-light {'));
    expect(lightBlock.slice(0, lightBlock.indexOf('\n}')), '--accent-fill-text-safe must be redefined for the light theme')
      .toMatch(/--accent-fill-text-safe\s*:/);
  });
});

/**
 * Row 15 (second-pass fix-first register): a hard-coded orange-family colour
 * used instead of a `var(--brand-orange-*)` ramp step or a `color-mix()` over
 * one. The landing CTA (`.btn-power`) carried a literal `#C2410C` that did not
 * even match the CURRENT ramp's 700 step (`#BF4417`) - a colour frozen at
 * whatever the ramp happened to be when it was typed, immune to the next ramp
 * tune. `rgba(255, 122, 51, *)` (`#FF7A33`) is worse: it is the pre-#12
 * "vibrant" hue brand-identity.test.ts already forbids as a hex string in
 * _themes.css, surviving as decimal rgb() in both _themes.css AND
 * _components.css, a form that check cannot see.
 *
 * This sweeps every `.css`/`.tsx`/`.ts` under frontend/src (excluding
 * _tokens.css, the ramp's own definition, and __tests__) for a hex or rgb()/
 * rgba() literal whose hue sits in the orange band, comment text excluded so
 * prose describing a colour does not count as using one. It is a policy
 * check like its neighbour above: it does not resolve `var()`, so a
 * token-valued fill is invisible to it and that is fine - the point is to
 * catch a LITERAL.
 *
 * A hit is either fixed or named in ALLOW_LIST with why. "Fixed" is not
 * always a no-op token swap: an exact match to the CURRENT ramp value became
 * that token with zero visual change (`.btn-power`'s hover fill, the pulse
 * dot), but the deprecated `#FF7A33` family and the landing CTA's `#C2410C`
 * were deliberate hue corrections onto the current ramp - documented at each
 * site, not silent. `ALLOW_LIST.length` is checked against a literal ceiling
 * so the list cannot silently grow to "everything" and pass forever; a new
 * unlisted hit must be fixed or added to the list by name, in review.
 */
describe('orange sweep: a literal orange belongs on the ramp, not typed in (row 15)', () => {
  const SRC_DIR = join(STYLES_DIR, '..');

  const hexToHsl = (hex: string): { h: number; s: number; l: number } => {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (max + min) / 2;
    const d = max - min;
    let hue = 0;
    let sat = 0;
    if (d !== 0) {
      sat = d / (1 - Math.abs(2 * light - 1));
      switch (max) {
        case r: hue = ((g - b) / d) % 6; break;
        case g: hue = (b - r) / d + 2; break;
        default: hue = (r - g) / d + 4; break;
      }
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    return { h: hue, s: sat, l: light };
  };

  const rgbToHsl = (r: string, g: string, b: string) =>
    hexToHsl(`#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`);

  /** Saturated, mid-lightness, hue 5-28: red-orange through orange. Excludes
   * amber/gold/yellow (hue > 28, e.g. warning/level-badge colours) and any
   * desaturated or near-black/near-white value, which is not "an orange". */
  const isBrandOrangeFamily = ({ h, s, l }: { h: number; s: number; l: number }): boolean => {
    if (s < 0.45) return false;
    if (l < 0.1 || l > 0.85) return false;
    return h >= 5 && h <= 28;
  };

  /* Known blind spots, none of which hide a real hit as of this MR (checked
   * by running the sweep with each guard disabled and confirming the count
   * is unchanged): an 8-digit hex (#RRGGBBAA) or space-syntax rgb() with a
   * slash-alpha (`rgb(255 90 31 / 0.4)`) match neither regex; the `//`
   * comment mask for .ts/.tsx blanks the rest of any line containing one
   * (an inline SVG attribute after a `xmlns="http://..."` on the same line
   * would be invisible); a `/*` inside a string literal would mask to the
   * next real `*\/`. */
  const HEX_RE = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  const RGBA_RE = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)/g;

  /** Mask block comments (and // line comments for .ts/.tsx) to spaces,
   * keeping every other character - including newlines - in place, so a
   * match's line number is unaffected by what got masked out. */
  const maskComments = (src: string, isTs: boolean): string => {
    const out = src.split('');
    const mask = (re: RegExp) => {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(src))) {
        for (let i = m.index; i < m.index + m[0].length; i++) if (out[i] !== '\n') out[i] = ' ';
      }
    };
    mask(/\/\*[\s\S]*?\*\//g);
    if (isTs) mask(/\/\/[^\n]*/g);
    return out.join('');
  };

  /**
   * Keyed on file+match+count, not file+line - a line number drifts on
   * every unrelated edit above it in a 13,000-line stylesheet (measured:
   * every entry in _components.css and _themes.css moved at least once
   * while this very suite was being written, purely from comments added
   * elsewhere in this MR). Content is what a reviewer actually approved;
   * the line is not.
   */
  type AllowEntry = { file: string; match: string; count: number };

  const collectSourceFiles = (dir: string, found: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const stat = require('fs').statSync(path);
      if (stat.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        collectSourceFiles(path, found);
      } else if (
        /\.(css|tsx|ts)$/.test(entry.name) &&
        entry.name !== '_tokens.css' &&
        !/\.test\.tsx?$/.test(entry.name)
      ) {
        found.push(path);
      }
    }
    return found;
  };

  /** Returns counts keyed by "file::match", plus the raw hits (with line,
   * kept for error messages only - never for allow-list matching). */
  const sweep = (): { counts: Map<string, number>; raw: { file: string; line: number; match: string }[] } => {
    const counts = new Map<string, number>();
    const raw: { file: string; line: number; match: string }[] = [];
    for (const path of collectSourceFiles(SRC_DIR)) {
      const label = path.slice(path.indexOf('src/'));
      const original = readFileSync(path, 'utf8');
      const isTs = path.endsWith('.ts') || path.endsWith('.tsx');
      const masked = maskComments(original, isTs);
      const lineOf = (idx: number) => masked.slice(0, idx).split('\n').length;

      const record = (match: string, idx: number) => {
        const key = `${label}::${match}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        raw.push({ file: label, line: lineOf(idx), match });
      };

      let m: RegExpExecArray | null;
      HEX_RE.lastIndex = 0;
      while ((m = HEX_RE.exec(masked))) {
        if (isBrandOrangeFamily(hexToHsl(m[0]))) record(m[0], m.index);
      }
      RGBA_RE.lastIndex = 0;
      while ((m = RGBA_RE.exec(masked))) {
        if (isBrandOrangeFamily(rgbToHsl(m[1], m[2], m[3]))) record(m[0], m.index);
      }
    }
    return { counts, raw };
  };

  /**
   * Every (file, literal) pair this sweep currently finds outside Lane A's
   * own fixes, with how many times it occurs and why it is not fixed in
   * this MR. `count` caps how many occurrences are tolerated - fixing SOME
   * of a repeated literal needs no update here (fewer than `count` always
   * passes); a NEW occurrence of the same literal, or any literal not
   * listed at all, fails by name.
   */
  const ALLOW_LIST: (AllowEntry & { reason: string })[] = [
    {
      file: 'src/api/gamification.ts', match: '#fd7e14', count: 1,
      reason: 'No owning lane in this plan (AGENTS.md: AdaptaBits/gamification is untouched during the beta) - a level-badge colour, not a UI orange.',
    },
    {
      file: 'src/components/AdminSessionManager.tsx', match: '#C2410C', count: 5,
      reason: 'Lane C owns AdminSessionManager.tsx (Collision map).',
    },
    {
      file: 'src/components/OrganicNeuralBackground.tsx', match: '#FF5500', count: 1,
      reason: 'Not listed in any lane\'s Owns. A landing background visual effect, closest to Lane A\'s remit but out of this MR\'s named scope - left alone rather than touched without being asked for.',
    },
    { file: 'src/components/OrganicNeuralBackground.tsx', match: '#FF6B00', count: 1, reason: 'Same file, same reason as #FF5500 above.' },
    { file: 'src/components/OrganicNeuralBackground.tsx', match: '#CC3300', count: 1, reason: 'Same file, same reason as #FF5500 above.' },
    {
      file: 'src/pages/booking-slot-list.css', match: 'rgba(197, 78, 18, 0.10)', count: 1,
      reason: 'Lane B owns booking-slot-list.css (Collision map, row 15\'s own note).',
    },
    { file: 'src/pages/booking-slot-list.css', match: '#92400e', count: 1, reason: 'Lane B owns booking-slot-list.css.' },
    { file: 'src/pages/booking-slot-list.css', match: 'rgba(255, 122, 51, 0.14)', count: 1, reason: 'Lane B owns booking-slot-list.css - also the deprecated #FF7A33 hue, worth Lane B\'s attention independent of ownership.' },
    { file: 'src/pages/booking-slot-list.css', match: '#fb923c', count: 1, reason: 'Lane B owns booking-slot-list.css.' },

    // _components.css and _themes.css are Lane A's own files, and Lane H's in
    // Wave 2 for the same Decision 4/5 rework as recording-session.css above.
    // A2 left every entry below as "Lane H judgement call" without making
    // one; Lane H reviewed each at the site, converted every one that was
    // really the brand accent drifted onto a different literal (dropdown
    // hover states, a focus-ring glow, a step-tab current indicator, a
    // var() fallback, decorative landing-page glows - about 30 occurrences,
    // onto var(--brand-orange-*) or color-mix() over one), and kept only the
    // entries below, each now reasoned individually rather than by the
    // one-line placeholder A2 left.
    { file: 'src/styles/_components.css', match: 'rgba(255, 90, 31, 0.08)', count: 1, reason: 'Deliberate: the @supports color-mix fallback for browsers without it - a color-mix() over the token here would defeat the one job this declaration has. It is var(--brand-orange-500)\'s own current RGB, so it is on-ramp without depending on the feature it exists to work around.' },
    { file: 'src/styles/_components.css', match: '#FF7A45', count: 1, reason: 'Hero gradient stop: a bespoke lightened midpoint between --brand-orange-500 and white with no ramp equivalent - the comment right above this declaration already says so. Reviewed, not deferred: no ramp step sits between 500 and white at this position.' },
    { file: 'src/styles/_components.css', match: '#FFA070', count: 1, reason: 'Same hero gradient, the next midpoint stop closer to white. Same reasoning as #FF7A45 above.' },
    { file: 'src/styles/_components.css', match: '#FB923C', count: 2, reason: 'Lane B\'s calendar slot-state system (.calendar-slot-booked/.legend-booked dark-mode border) - a dense, already-shipped, deliberately graduated fill/border/glow hierarchy across several orange shades to keep "booked" and "selected" visually distinct. Redesigning it is a UX decision belonging to Lane B\'s surface, not this token/ground pass.' },
    { file: 'src/styles/_components.css', match: '#EA580C', count: 3, reason: 'Same calendar slot-state system as #FB923C above (.calendar-slot-selected border, both themes) - Lane B\'s surface. (A fourth match of this hex, .booking-popover-confirm:hover, was NOT this - a plain button hover fill, converted onto var(--brand-orange-600).)' },
    { file: 'src/styles/_components.css', match: 'rgba(255, 171, 145, 0.15)', count: 1, reason: '.booking-badge-poll: one hue in a categorical type-badge palette (test=cyan, poll=deep-orange, survey=green, ...) - a distinct-per-type colour scheme, not the brand accent. Same system as the lozenge tokens below.' },
    { file: 'src/styles/_components.css', match: '#FFAB91', count: 1, reason: 'Same .booking-badge-poll categorical badge as rgba(255, 171, 145, 0.15) above.' },
    { file: 'src/styles/_components.css', match: '#BF360C', count: 1, reason: 'Same .booking-badge-poll categorical badge, the light-theme variant.' },
    { file: 'src/styles/_components.css', match: '#DD6E42', count: 1, reason: '--opportunity-row-urgent, with its own comment at the site explaining it: deliberately NOT the brand accent, so an urgent-row indicator reads as a distinct colour from ordinary brand-orange UI. Reviewed and kept exactly for the reason already given.' },
    { file: 'src/styles/_components.css', match: '#B4471F', count: 1, reason: '.booking-outcome-rejected (light): paired with .booking-outcome-approved\'s green as a deliberate two-colour outcome semantic. Collapsing "rejected" onto the same brand orange used for primary CTAs would read as an invitation, not a negative outcome.' },
    { file: 'src/styles/_components.css', match: '#F08A5D', count: 1, reason: 'Same .booking-outcome-rejected semantic as #B4471F above, the dark-theme variant.' },
    { file: 'src/styles/_themes.css', match: '#c2410c', count: 1, reason: '--lozenge-poll-text: the study-type categorical colour system (Decision 6, Lane E\'s icon-system MR) - a deliberately distinct hue per study type, not the brand accent. Out of Decision 4/5\'s scope.' },
    { file: 'src/styles/_themes.css', match: 'rgba(234, 88, 12, 0.15)', count: 1, reason: '--lozenge-poll-bg, the tint half of the same Decision 6 token as #c2410c above.' },
    { file: 'src/styles/_themes.css', match: '#b45309', count: 1, reason: '--lozenge-question-text, the same Decision 6 categorical system as #c2410c above (the question type\'s colour, not poll\'s).' },
    { file: 'src/styles/_themes.css', match: 'rgba(234, 88, 12, 0.1)', count: 1, reason: '.lozenge-poll text colour source (#ea580c below) and its bg/border tints - the class form of the same Decision 6 --lozenge-poll-* tokens above, not a second system.' },
    { file: 'src/styles/_themes.css', match: 'rgba(234, 88, 12, 0.2)', count: 1, reason: '.lozenge-poll border tint, same as rgba(234, 88, 12, 0.1) above.' },
    { file: 'src/styles/_themes.css', match: '#ea580c', count: 1, reason: '.lozenge-poll text colour, same Decision 6 categorical system as #c2410c above.' },
    { file: 'src/styles/_themes.css', match: '#B45309', count: 1, reason: '.cortex-badge--peak (light mode): an amber "peak" badge, a different semantic from the brand accent (compare .cortex-badge--best\'s green, --info\'s neutral) - not part of the primary-colour system Decision 5 governs.' },
    { file: 'src/styles/_themes.css', match: '#92400E', count: 1, reason: 'Leaderboard gold-rank score colour (light mode) - the gamification medal palette the header comment above names, a deliberately distinct "gold" semantic rather than the brand accent.' },
  ];

  /** Ceiling on the allow-list itself, so it cannot grow to cover
   * "everything" and pass forever. Raise it only alongside a reviewed
   * addition above naming the new entry and why. */
  const MAX_ALLOWLIST_SIZE = 60;

  it('the allow-list has a pinned ceiling', () => {
    expect(ALLOW_LIST.length).toBeLessThanOrEqual(MAX_ALLOWLIST_SIZE);
  });

  it('the classifier can actually flag an orange (and ignores a token reference)', () => {
    // Non-vacuous: prove detection works before trusting an empty diff below.
    expect(isBrandOrangeFamily(hexToHsl('#FF7A33'))).toBe(true);
    expect(isBrandOrangeFamily(hexToHsl('#C2410C'))).toBe(true);
    // A cool grey and a saturated blue must not read as orange.
    expect(isBrandOrangeFamily(hexToHsl('#888888'))).toBe(false);
    expect(isBrandOrangeFamily(hexToHsl('#1E40AF'))).toBe(false);
    // A pure amber/gold (warning-token territory) sits outside the window.
    expect(isBrandOrangeFamily(hexToHsl('#FFC107'))).toBe(false);
  });

  it('every orange-family literal found is either fixed or on the allow-list, and no more often than allowed', () => {
    const { counts, raw } = sweep();
    const allowedCount = new Map(ALLOW_LIST.map((e) => [`${e.file}::${e.match}`, e.count]));

    const overLimit = [...counts.entries()].filter(([key, n]) => n > (allowedCount.get(key) ?? 0));

    expect(
      overLimit,
      `New or more-frequent hard-coded orange(s) found than the allow-list permits - use a ` +
        `var(--brand-orange-*) token or color-mix() over one, or add/raise a reviewed allow-list ` +
        `entry naming why:\n  ` +
        overLimit
          .map(([key, n]) => {
            const [file, match] = key.split('::');
            const example = raw.find((r) => r.file === file && r.match === match);
            return `${key} found ${n}x, allowed ${allowedCount.get(key) ?? 0}x (e.g. line ${example?.line})`;
          })
          .join('\n  ')
    ).toEqual([]);
  });

  it('no allow-list entry is stale (every entry still matches at least one real occurrence)', () => {
    // The inverse of the check above: an entry that no longer matches
    // anything is dead weight quietly consuming ceiling headroom, and -
    // rarer but real - could mask a rename that moved the SAME defect to a
    // slightly different literal without anyone updating the list.
    const { counts } = sweep();
    const stale = ALLOW_LIST.filter((e) => !(counts.get(`${e.file}::${e.match}`) ?? 0));
    expect(
      stale.map((e) => `${e.file}::${e.match}`),
      'these allow-list entries no longer match anything - remove them'
    ).toEqual([]);
  });

  it('the landing CTA (.btn-power) no longer carries a literal orange (row 15)', () => {
    const components = readFileSync(join(STYLES_DIR, '_components.css'), 'utf8');
    const start = components.indexOf('.btn-power {');
    const activeAt = components.indexOf('.btn-power:active {');
    expect(start, '.btn-power selector must exist').toBeGreaterThan(-1);
    expect(activeAt, '.btn-power:active selector must exist').toBeGreaterThan(start);
    const end = components.indexOf('\n}', activeAt);
    expect(end, 'the block must close after .btn-power:active').toBeGreaterThan(activeAt);
    const block = components.slice(start, end);
    // #FFFFFF is fine here - it is the button's text colour in both themes,
    // not an orange fill; the policy this test guards is "no literal
    // orange", not "no hex at all".
    const nonWhiteHex = block.match(/#[0-9a-fA-F]{3,6}\b/g)?.filter((h) => !/^#(fff|ffffff)$/i.test(h)) ?? [];
    expect(nonWhiteHex, '.btn-power must read its fill from a var(), not a literal hex').toEqual([]);
    // NOT var(--cta-bg): that token is ink navy under body.theme-light (a
    // different button's convention - see .btn-primary), which would turn
    // this orange landing CTA navy in light mode. And not a raw
    // --brand-orange-* step as the BACKGROUND either: every ramp step is an
    // identity colour that fails AA under the white label this button
    // carries (the "puts no light text on an identity fill" test above
    // catches that) - --accent-fill-text-safe is the token that resolves to
    // whichever step actually passes, per theme.
    expect(block).toContain('background: var(--accent-fill-text-safe)');
  });
});
