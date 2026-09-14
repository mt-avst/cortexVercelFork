import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Lane E, second-pass review row 24 (Helena's icon read): one icon system
 * instead of nine ad hoc ones. This reads source files as text - the same
 * shape as brand-identity.test.ts and accent-fill-policy.test.ts - so a
 * mutation that reintroduces a unicode glyph, a squashed chevron, or a
 * contrast-losing `!important` lock fails here BY NAME, not only in a
 * browser.
 */
const SRC = join(__dirname, '..');
const read = (relPath: string) => readFileSync(join(SRC, relPath), 'utf8');

describe('one icon system (row 24)', () => {
  describe('the kebab menu is a lucide glyph, not a unicode character', () => {
    it('Admin.tsx no longer renders the literal ⋮ glyph', () => {
      expect(read('pages/Admin.tsx')).not.toContain('⋮');
    });
  });

  describe('sort indicators go through one SortCaret component, not four inline ternaries', () => {
    const files = [
      'pages/Admin.tsx',
      'components/AdminFeedback.tsx',
      'components/opportunity-analytics/ParticipantsTab.tsx',
      'components/opportunity-analytics/SessionsTab.tsx',
    ];

    it.each(files)('%s no longer contains a literal ↑/↓ sort glyph', (file) => {
      const content = read(file);
      expect(content).not.toMatch(/['"]\s?[↑↓]['"]/);
    });

    it.each(files)('%s renders sort indicators through <SortCaret', (file) => {
      expect(read(file)).toContain('<SortCaret');
    });
  });

  describe('back-navigation uses a lucide ArrowLeft, not a unicode arrow', () => {
    it('OpportunityDetail.tsx and SurveySession.tsx no longer render "← Back to Cortex"', () => {
      expect(read('pages/OpportunityDetail.tsx')).not.toContain('← Back to Cortex');
      expect(read('pages/SurveySession.tsx')).not.toContain('← Back to Cortex');
    });
  });

  describe('the three analytics/stat icon colour locks are gone (row 24: ~1.92:1 measured contrast)', () => {
    const components = read('styles/_components.css');
    const themes = read('styles/_themes.css');

    it('.stat-icon no longer forces --color-slate-400 with !important', () => {
      expect(components).not.toMatch(/\.stat-icon\s*\{[^}]*--color-slate-400\)\s*!important/);
    });

    it('.stat-icon-wrapper .stat-icon no longer forces --color-slate-400 with !important', () => {
      expect(components).not.toMatch(/\.stat-icon-wrapper \.stat-icon\s*\{[^}]*!important/);
    });

    it('.cortex-analytics-card-icon no longer forces --color-slate-400 with !important', () => {
      expect(components).not.toMatch(/\.cortex-analytics-card-icon\s*\{[^}]*--color-slate-400\)\s*!important/);
    });

    it('none of the three icon rules dims itself with an opacity below 1', () => {
      for (const selector of ['\\.stat-icon\\b', '\\.stat-icon-wrapper \\.stat-icon', '\\.cortex-analytics-card-icon\\b']) {
        const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`);
        const m = components.match(re);
        expect(m, `expected to find a rule for ${selector}`).not.toBeNull();
        expect(m![1]).not.toMatch(/opacity:\s*0\.\d/);
      }
    });

    // Caught only by measuring the live page, not by reading _components.css
    // alone: both `body.theme-dark .admin-stat-card .stat-icon` and its
    // `body.theme-light` twin in _themes.css re-forced the SAME dark-slate
    // value with `!important` regardless of which theme was active, more
    // specific than the component-level fix above and so still winning.
    // Light mode was rendering the dark theme's colour on a white card.
    it('neither theme re-locks .admin-stat-card .stat-icon in _themes.css', () => {
      expect(themes).not.toMatch(/body\.theme-(dark|light) \.admin-stat-card \.stat-icon\s*\{/);
    });

    // The same duplicate-lock shape existed a second time, on the analytics
    // card icon, and was missed in the first pass of this file: a review
    // gate found it by re-measuring the live page. Both theme blocks are
    // deleted now (the component rule is already theme-aware); this pins
    // that they do not come back.
    it('neither theme re-locks .cortex-analytics-card-icon in _themes.css', () => {
      expect(themes).not.toMatch(/body\.theme-(dark|light) \.cortex-analytics-card-icon\s*\{/);
    });
  });

  describe('the CSS select chevron is no longer squashed (16x16 viewBox rendered into a 16x12 box)', () => {
    it('no stylesheet declares the old 16x12 background-size for the chevron', () => {
      expect(read('styles/_components.css')).not.toContain('background-size: 16px 12px');
      expect(read('styles/_themes.css')).not.toContain('background-size: 16px 12px');
    });

    // Fixing the size alone left the chevron invisible in dark mode, found
    // only by measuring the live page. `body.theme-dark .form-control,
    // .form-select { background: ... !important }` sits in the `components`
    // cascade layer, EARLIER than `themes`; CSS reverses layer priority for
    // `!important` declarations, so this earlier layer's `!important`
    // shorthand - which resets background-image to `none` as an unspecified
    // sub-property - beat the `themes`-layer chevron fix outright, on every
    // dark-mode select. The source-level test above and the component test
    // both read as green; only the browser showed the real defect.
    it('the dark-mode form-control/form-select glass fill uses background-color, not the background shorthand', () => {
      const components = read('styles/_components.css');
      const block = components.match(
        /body\.theme-dark \.form-control,\nbody\.theme-dark \.form-select,\nbody\.theme-dark textarea\.form-control \{([^}]*)\}/
      );
      expect(block, 'expected to find the dark-mode form-control/form-select glass-fill rule').not.toBeNull();
      expect(block![1]).not.toMatch(/\n\s*background:\s*rgba/);
      expect(block![1]).toMatch(/background-color:\s*rgba\([^)]*\)\s*!important/);
    });

    // General sweep, not just the two instances found by hand: an
    // `!important` `background` SHORTHAND on any rule naming form-select
    // resets `background-image` to `none` as an unspecified sub-value,
    // silently deleting the chevron - unless the SAME rule also sets
    // `background-image` explicitly afterwards (several rules in
    // _themes.css do exactly that, correcting themselves within one block,
    // and are not a defect). A rule that resets the image and never
    // restores it in the same block is the real bug shape: found twice this
    // way already (_components.css rest and :focus states, _themes.css's
    // `select.form-select` variant outranking the plain chevron rule).
    it.each(['_components.css', '_themes.css'] as const)(
      'no form-select rule in %s resets background-image via an !important shorthand without restoring it',
      (file) => {
        const text = read(`styles/${file}`);
        const offenders: string[] = [];
        // Matches `<selector list> { <body> }` blocks (no nested braces,
        // true of every rule in these two files).
        const blockRe = /([^{}]+)\{([^{}]*)\}/g;
        let m: RegExpExecArray | null;
        while ((m = blockRe.exec(text))) {
          const [, selector, body] = m;
          if (!/form-select/.test(selector)) continue;
          // A native <option> is rendered by the OS's own popup, never by
          // the page's background-image, so a shorthand there cannot delete
          // a chevron - excluded rather than a false positive to chase.
          if (/form-select\s+option/.test(selector)) continue;
          const shorthandImportant = /(?<![-\w])background\s*:\s*[^;]*!important/.test(body);
          if (!shorthandImportant) continue;
          const restoresImage = /background-image\s*:/.test(body);
          if (!restoresImage) offenders.push(selector.trim().replace(/\s+/g, ' '));
        }
        expect(offenders, `shorthand resets the chevron without restoring it:\n${offenders.join('\n')}`).toEqual([]);
      }
    );
  });

  describe('the two orphan image assets are gone', () => {
    it('research-icon.png no longer exists under public/images', () => {
      expect(existsSync(join(SRC, '..', 'public', 'images', 'research-icon.png'))).toBe(false);
    });

    it('x.svg no longer exists under public/images', () => {
      expect(existsSync(join(SRC, '..', 'public', 'images', 'x.svg'))).toBe(false);
    });
  });

  describe('the three medal emoji are gone from Leaderboard', () => {
    it('Leaderboard.tsx renders no medal emoji', () => {
      const content = read('components/Leaderboard.tsx');
      for (const medal of ['🥇', '🥈', '🥉']) {
        expect(content).not.toContain(medal);
      }
    });
  });

  describe('three time metaphors, not nine', () => {
    // Before this row the codebase imported Clock, Calendar, CalendarDays,
    // CalendarX, CalendarClock, CalendarRange, CalendarCheck, Timer and
    // History from lucide-react - nine distinct "when" glyphs. Clock (a
    // duration or a point in time), Calendar (a scheduled date - CalendarX
    // is its empty-state negation, not a fourth metaphor) and History (a
    // retrospective record) now cover every case; the other six fold onto
    // one of those three.
    const RETIRED_TIME_ICONS = ['CalendarClock', 'CalendarRange', 'CalendarCheck', 'CalendarDays', 'Timer'];

    /** Every .ts/.tsx file under `dir`, skipping node_modules-shaped dirs. */
    function listSourceFiles(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...listSourceFiles(full));
        } else if (/\.tsx?$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    }

    it('no .ts/.tsx file under src imports a retired time-metaphor icon from lucide-react', () => {
      // Whole tree, case-sensitive (these are exact export names): every
      // .ts/.tsx file under frontend/src. A .tsx-only sweep would miss a
      // retired icon re-exported or imported from a plain .ts module.
      const files = listSourceFiles(SRC);
      expect(files.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        const importBlocks = [...content.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/gs)];
        for (const block of importBlocks) {
          const names = block[1].split(',').map((n) => n.trim()).filter(Boolean);
          for (const retired of RETIRED_TIME_ICONS) {
            if (names.includes(retired)) {
              offenders.push(`${file}: ${retired}`);
            }
          }
        }
      }
      expect(offenders, `retired time icons still imported:\n${offenders.join('\n')}`).toEqual([]);
    });
  });

  describe('the analytics cards no longer contradict themselves with a directional icon', () => {
    const analytics = read('pages/OpportunityAnalytics.tsx');
    const importedIcons = [...analytics.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/gs)]
      .flatMap((m) => m[1].split(','))
      .map((n) => n.trim())
      .filter(Boolean);

    it('does not import MousePointerClick (an action is not always a click)', () => {
      expect(importedIcons).not.toContain('MousePointerClick');
    });

    it('does not import TrendingUp for Conversion Rate (the figure can read negative week over week)', () => {
      expect(importedIcons).not.toContain('TrendingUp');
    });
  });
});
