import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readdirSync } from 'fs';

/**
 * Dead brand CSS (fix-first row 1 "Then").
 *
 * `.logo-image` styled the old raster-image lockup; CortexMark.tsx (the
 * Neuron SVG) replaced it with no `<img className="logo-image">` left
 * anywhere. `.adaptalabs-home-title` styled a gradient hero title with no
 * matching JSX either. The "Beaded C" comment describes a mark the codebase
 * no longer ships (the Neuron). All three are dead weight, not behavior.
 *
 * Search scope for "no references", stated per the repo's sweep convention:
 * case-insensitive grep across every `.tsx`/`.ts`/`.css`/`.html` file under
 * `frontend/src` (excluding node_modules and __tests__ directories, which
 * legitimately name these strings as the thing being searched for), for
 * `logo-image` and `adaptalabs-home-title`.
 */

const STYLES_DIR = join(__dirname, '..');
const read = (name: string) => readFileSync(join(STYLES_DIR, name), 'utf8');

// Excludes __tests__: this file (and any sibling test) legitimately names the
// dead strings it searches for, which would otherwise flag itself.
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'dist' || entry.name === 'build') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|css|html)$/i.test(entry.name)) out.push(full);
  }
  return out;
};

// __dirname is frontend/src/styles/__tests__ - two levels up is frontend/src.
const FRONTEND_SRC = join(__dirname, '..', '..');

describe('dead brand CSS is removed, not merely unused (row 1 "Then")', () => {
  it('no .logo-image rule survives in styles/', () => {
    for (const name of ['_components.css', '_themes.css']) {
      expect(read(name), name).not.toMatch(/\.logo-image\s*\{/);
    }
  });

  it('no .adaptalabs-home-title rule survives in styles/', () => {
    for (const name of ['_components.css', '_themes.css']) {
      expect(read(name), name).not.toMatch(/\.adaptalabs-home-title/);
    }
  });

  it('the stale "Beaded C" comment is gone from _components.css', () => {
    expect(read('_components.css')).not.toMatch(/Beaded C/i);
  });

  it('no .tsx/.ts/.css/.html file under frontend/src references logo-image or adaptalabs-home-title (case-insensitive, whole tree)', () => {
    const files = walk(FRONTEND_SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (/logo-image|adaptalabs-home-title/i.test(text)) offenders.push(file);
    }
    expect(offenders, `searched ${files.length} .tsx/.ts/.css/.html files under frontend/src (excluding __tests__, which legitimately names these strings)`).toEqual([]);
  });
});

describe('the recording-session.css webfont comment states the current truth (row 1 "Then")', () => {
  const RECORDING_CSS = join(__dirname, '..', '..', 'components', 'recording', 'recording-session.css');

  it('no longer claims the FirstHand webfonts are unbundled ("a webfont import is a follow-up, not a blocker")', () => {
    const css = readFileSync(RECORDING_CSS, 'utf8');
    expect(css).not.toMatch(/a webfont import is a follow-up, not a blocker/i);
  });

  it('states that Fraunces is already self-hosted and reaches this scoped surface via the global @font-face', () => {
    const css = readFileSync(RECORDING_CSS, 'utf8');
    expect(css).toMatch(/self-hosted/i);
    expect(css).toMatch(/@font-face/);
  });
});
