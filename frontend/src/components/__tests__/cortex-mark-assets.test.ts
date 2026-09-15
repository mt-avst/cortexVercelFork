import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { inflateSync } from 'zlib';
import { join } from 'path';

/**
 * The Cortex mark ships in THREE places, and they have to stay one mark:
 *
 *   - `CortexMark.tsx`            the component, `currentColor`, in the app
 *   - `public/favicon.svg`        the tab icon, orange baked in because
 *                                 `currentColor` cannot resolve standalone
 *   - `public/apple-touch-icon.png` a 180px raster baked from the same geometry
 *
 * Why this file exists. On 2026-09-14, checking which files carried the
 * geometry, `apple-touch-icon.png` turned out to be a DAMAGED PNG that did not
 * contain the mark at all: its IDAT chunk failed its own CRC, the deflate
 * stream failed its Adler-32, only 179 of 180 scanlines were present, and the
 * pixels were white and blue with no brand orange anywhere. It had been live on
 * the playground since the favicon work landed.
 *
 * Nothing caught it because the check written for that row was "icon link
 * resolves 200". It did resolve 200, with `Content-Type: image/png`, because
 * the file existed and was named correctly. A 200 cannot tell a working image
 * from a corrupt one, and neither can a byte-length check.
 *
 * So these tests decode the assets rather than looking at them. Each one is
 * written to fail on the specific defect that shipped.
 */

const PUBLIC_DIR = join(__dirname, '..', '..', '..', 'public');
const COMPONENT = join(__dirname, '..', 'CortexMark.tsx');

const BRAND_ORANGE = { r: 0xff, g: 0x5a, b: 0x1f }; // --brand-orange-500, #FF5A1F
const ARTBOARD = '6.8 3.05 34.4 34.4';

/**
 * Read a source file with its comments removed.
 *
 * Both files EXPLAIN themselves in prose that quotes the very tokens these
 * assertions look for - favicon.svg's docblock says "currentColor cannot
 * resolve on a standalone favicon", and CortexMark.tsx's names its own radii.
 * Matching raw text would make a docblock satisfy a code assertion, which is
 * the mirror image of the Lane E bug where a sweep read PAST its own comment
 * and went blind at the site that motivated it. Strip, then match.
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '') // SVG/HTML comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/^\s*\/\/.*$/gm, ''); // line comments

/** Every `viewBox="..."` value in a blob of SVG or TSX. */
const viewBoxes = (src: string): string[] =>
  [...src.matchAll(/viewBox="([^"]+)"/g)].map((m) => m[1]);

/**
 * Geometry as a comparable shape: the three limb paths and the four circles,
 * normalised so a difference in attribute ORDER or colour syntax between the
 * component (`currentColor`) and the favicon (a baked hex) is not a difference
 * in geometry.
 */
const geometryOf = (src: string) => ({
  paths: [...src.matchAll(/d="([^"]+)"/g)].map((m) => m[1].trim()),
  // `matchAll` yields match ARRAYS, not strings - take [0] for the whole tag.
  // Passing the array straight to `exec` happens to work at runtime (a
  // one-element array stringifies to its element) and is a real bug the moment
  // a tag matches twice; `npm run typecheck` is what catches it, since neither
  // `tsc -p tsconfig.json` nor lint reads files under `__tests__`.
  circles: [...src.matchAll(/<circle\b[^>]*>/g)].map(([tag]) => ({
    cx: /cx="([^"]+)"/.exec(tag)?.[1],
    cy: /cy="([^"]+)"/.exec(tag)?.[1],
    r: /\br="([^"]+)"/.exec(tag)?.[1],
  })),
  strokeWidth: /stroke-?[wW]idth="([^"]+)"/.exec(src)?.[1],
  // Linecap is geometry here, not decoration: the limbs are drawn to the node
  // CENTRES, so round caps are what makes each limb end inside its node rather
  // than stopping square across it. Without this, flipping the favicon alone to
  // `butt` changed nothing in the suite - measured, 12/12 still green.
  linecap: /stroke-?[lL]ine[cC]ap="([^"]+)"/.exec(src)?.[1],
});

// ---------------------------------------------------------------------------
// A minimal PNG reader. Deliberately NOT a library: the whole point is to
// verify the chunk CRCs and the deflate stream that the shipped file failed,
// and a forgiving decoder would have rendered the broken file without
// complaining, exactly as the browsers did.
// ---------------------------------------------------------------------------

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

interface PngChunk {
  type: string;
  data: Buffer;
  crcOk: boolean;
}

const readChunks = (buf: Buffer): PngChunk[] => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('not a PNG: bad signature');
  const out: PngChunk[] = [];
  let i = 8;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const data = buf.subarray(i + 8, i + 8 + len);
    const stored = buf.readUInt32BE(i + 8 + len);
    out.push({ type, data, crcOk: crc32(buf.subarray(i + 4, i + 8 + len)) === stored });
    i += 12 + len;
  }
  return out;
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Decode an 8-bit RGB or RGBA PNG to flat pixel bytes, applying the scanline
 * filters. Both colour types are accepted because an app icon is an OPAQUE
 * tile - the encoder drops the alpha channel when nothing is transparent, and
 * refusing colour type 2 would reject the correct output.
 */
const decodePng = (buf: Buffer) => {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('no IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colourType = ihdr.data[9];
  if (bitDepth !== 8 || (colourType !== 6 && colourType !== 2)) {
    throw new Error(`expected 8-bit RGB or RGBA, got bit depth ${bitDepth} colour type ${colourType}`);
  }
  // Interlaced data is laid out in seven passes, so the scanline walk below
  // would read it as garbage and report a misleading "truncated" length.
  if (ihdr.data[12] !== 0) throw new Error('interlaced PNG is not supported by this reader');
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat); // throws on a bad Adler-32 - which is the point
  const ch = colourType === 6 ? 4 : 3;
  const stride = width * ch;
  const expected = height * (1 + stride);
  if (raw.length !== expected) {
    throw new Error(`truncated image data: ${raw.length} bytes of ${expected} (${Math.floor(raw.length / (1 + stride))} of ${height} scanlines)`);
  }
  const px = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)];
    const line = Buffer.from(raw.subarray(y * (1 + stride) + 1, (y + 1) * (1 + stride)));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 0xff;
      else if (filter === 2) line[x] = (line[x] + b) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) line[x] = (line[x] + paeth(a, b, c)) & 0xff;
    }
    line.copy(px, y * stride);
    prev = line;
  }
  return { width, height, chunks, px, channels: ch };
};

// ---------------------------------------------------------------------------

describe('the Cortex mark is one mark across all three assets', () => {
  const component = read(COMPONENT);
  const favicon = read(join(PUBLIC_DIR, 'favicon.svg'));

  it('the component and the favicon share one artboard', () => {
    expect(viewBoxes(component)).toEqual([ARTBOARD]);
    expect(viewBoxes(favicon)).toEqual([ARTBOARD]);
  });

  it('the favicon draws the same geometry as the component, not a stale copy', () => {
    // The favicon is a hand-maintained duplicate of the component's path data.
    // Nothing but this assertion stops the two drifting apart, and a drifted
    // favicon is invisible in the app - it only shows in the browser tab.
    const a = geometryOf(component);
    const b = geometryOf(favicon);
    expect(b.paths).toEqual(a.paths);
    expect(b.circles).toEqual(a.circles);
    expect(b.strokeWidth).toEqual(a.strokeWidth);
    expect(b.linecap).toEqual(a.linecap);

    // Control: the matcher must actually be finding geometry. An empty array
    // equals an empty array, so without this the test passes on two files that
    // contain no mark at all.
    expect(a.paths).toHaveLength(3);
    expect(a.circles).toHaveLength(4);
  });

  it('the favicon bakes the brand orange, since currentColor cannot resolve standalone', () => {
    expect(favicon.toLowerCase()).not.toContain('currentcolor');
    const hexes = new Set([...favicon.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toUpperCase()));
    expect([...hexes]).toEqual(['#FF5A1F']);
  });
});

describe('apple-touch-icon.png is a real image of the real mark', () => {
  const buf = readFileSync(join(PUBLIC_DIR, 'apple-touch-icon.png'));

  it('is a structurally valid PNG - every chunk passes its own CRC', () => {
    // The shipped file failed here: IDAT CRC BAD. Browsers rendered it anyway,
    // partially, which is why it went unnoticed.
    const bad = readChunks(buf).filter((c) => !c.crcOk).map((c) => c.type);
    expect(bad).toEqual([]);
  });

  it('decodes completely - no truncated scanlines, no broken deflate stream', () => {
    // The shipped file failed here too: 179 of 180 scanlines, and zlib refused
    // the stream outright on its Adler-32.
    const { width, height } = decodePng(buf);
    expect(width).toBe(180);
    expect(height).toBe(180);
  });

  it('actually contains the brand orange, so it is the mark and not a blank tile', () => {
    // This is the assertion "the URL returns 200" could never make. The shipped
    // file decoded (leniently) to white and blue with no orange in it at all.
    const { px, width, height, channels } = decodePng(buf);
    let opaque = 0;
    let orange = 0;
    let x0 = Infinity;
    let x1 = -1;
    let y0 = Infinity;
    let y1 = -1;
    for (let i = 0; i < px.length; i += channels) {
      if (channels === 4 && px[i + 3] < 16) continue;
      opaque++;
      // Allow for antialiasing against the ground: a near-miss counts, a
      // different hue does not.
      if (
        Math.abs(px[i] - BRAND_ORANGE.r) <= 24 &&
        Math.abs(px[i + 1] - BRAND_ORANGE.g) <= 24 &&
        Math.abs(px[i + 2] - BRAND_ORANGE.b) <= 24
      ) {
        orange++;
        const p = i / channels;
        const x = p % width;
        const y = Math.floor(p / width);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const total = width * height;
    expect(opaque / total).toBeGreaterThan(0.95); // an app icon is a full tile
    expect(orange).toBeGreaterThan(0);

    // Counting orange pixels is SHAPE-BLIND. Measured: a plain 80x80 orange
    // square containing no mark at all passes a count-only check comfortably
    // (share 0.198 against a 0.08-0.45 band). So pin the EXTENT of the ink and
    // where it sits, which a square, a dot or a stale artboard all get wrong.
    //
    // 122 x 116 centred on the tile is what the mark's own proportions
    // predict: 180 x INSET(0.72) x (32.4/34.4 ink fill) = 122.1 wide, and the
    // ink is 30.9/32.4 as tall as it is wide. Regenerating from a stale
    // "0 0 48 48" favicon paints 106 x 101 instead and fails here BY NAME.
    expect({ w: x1 - x0 + 1, h: y1 - y0 + 1 }).toEqual({ w: 122, h: 116 });
    expect((x0 + x1) / 2).toBeCloseTo((width - 1) / 2, 0);
    expect((y0 + y1) / 2).toBeCloseTo((height - 1) / 2, 0);
  });

  it('sits on the ink ground, not on white or on transparency', () => {
    // Control for the assertion above: it counts orange, and an orange count
    // is satisfied by orange-on-anything. The tile's dominant colour has to be
    // the ink ground, which is also what stops a transparent PNG shipping (iOS
    // composites those onto black and the mark disappears).
    const { px, width, height, channels } = decodePng(buf);
    let ground = 0;
    for (let i = 0; i < px.length; i += channels) {
      if (px[i] === 0x0a && px[i + 1] === 0x09 && px[i + 2] === 0x1a) ground++;
    }
    expect(ground / (width * height)).toBeGreaterThan(0.5);
  });
});
