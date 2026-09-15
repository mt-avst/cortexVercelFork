// Generates the light-mode hero "cortex" network SVG: a dense, bilobed brain
// silhouette (two hemispheres + a central fissure) of terracotta nodes on faint
// slate connections. Deterministic (seeded) so regenerating is reproducible.
//
//   node frontend/scripts/gen-landing-network.mjs
//
// Writes frontend/public/images/landing-network-static.svg. Bump the ?v= query
// on the <img> in Landing.tsx when the content changes (filename is stable).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'images', 'landing-network-static.svg');

// Sized to fill the hero's right side as a field (mirroring dark mode): shown
// with object-fit: cover in a tall right-hand band and faded on its inner edge,
// so a dense, roughly square cloud crops cleanly at any band aspect.
const W = 780;
const H = 620;

// Deterministic RNG (mulberry32) - a fixed seed keeps the asset stable.
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(20260915);

const cx = W / 2;
const cy = H / 2;

// Two heavily-overlapping hemisphere ellipses (a full cortex mass with a soft
// central fissure for character). Wide overlap so the mass reads as one field
// that crops cleanly rather than a discrete peanut.
const lobes = [
  { x: cx - 0.15 * W, y: cy, a: 0.36 * W, b: 0.47 * H },
  { x: cx + 0.15 * W, y: cy, a: 0.36 * W, b: 0.47 * H },
];
const FISSURE = 0.008 * W;

const inLobe = (x, y, l) => ((x - l.x) ** 2) / (l.a ** 2) + ((y - l.y) ** 2) / (l.b ** 2) <= 1;
const inside = (x, y) => {
  if (Math.abs(x - cx) < FISSURE && Math.abs(y - cy) < 0.34 * H) return false; // fissure gap
  return lobes.some((l) => inLobe(x, y, l));
};

// Poisson-ish sampling by rejection: keep points at least MIN_D apart.
const MIN_D = 27;
const nodes = [];
let attempts = 0;
while (nodes.length < 210 && attempts < 60000) {
  attempts++;
  const x = rand() * W;
  const y = rand() * H;
  if (!inside(x, y)) continue;
  if (nodes.some((n) => (n.x - x) ** 2 + (n.y - y) ** 2 < MIN_D ** 2)) continue;
  // ~6% hotspots (larger, denser cores near the middle of each hemisphere).
  const hotspot = rand() < 0.06;
  nodes.push({ x, y, r: hotspot ? 3.6 + rand() * 2.4 : 1.6 + rand() * 1.6, hotspot });
}

// Connect near neighbours; cap per node; cross-fissure links are rarer so the
// hemispheres stay legible. Opacity fades with length (short = stronger).
const THRESH = 76;
const MAX_CONN = 6;
const counts = new Array(nodes.length).fill(0);
const edges = [];
for (let i = 0; i < nodes.length; i++) {
  for (let j = i + 1; j < nodes.length; j++) {
    if (counts[i] >= MAX_CONN || counts[j] >= MAX_CONN) continue;
    const dx = nodes[j].x - nodes[i].x;
    const dy = nodes[j].y - nodes[i].y;
    const d = Math.hypot(dx, dy);
    const crossesFissure = nodes[i].x < cx !== nodes[j].x < cx;
    const limit = crossesFissure ? THRESH * 0.72 : THRESH;
    if (d > limit) continue;
    if (crossesFissure && rand() > 0.4) continue; // thin out cross-hemisphere links
    const t = 1 - d / THRESH; // 0..1, closer = stronger
    const opacity = (0.2 + t * 0.28).toFixed(3); // 0.20..0.48 (bolder lines, Mav's steer)
    edges.push({ ...nodes[i], x2: nodes[j].x, y2: nodes[j].y, opacity });
    counts[i]++;
    counts[j]++;
  }
}

const f = (n) => n.toFixed(1);
const lines = edges
  .map((e) => `    <line x1="${f(e.x)}" y1="${f(e.y)}" x2="${f(e.x2)}" y2="${f(e.y2)}" stroke="rgb(100, 116, 139)" stroke-opacity="${e.opacity}" stroke-width="1" stroke-linecap="round" />`)
  .join('\n');

const circles = nodes
  .map((n) => `    <circle cx="${f(n.x)}" cy="${f(n.y)}" r="${n.r.toFixed(1)}" fill="rgb(194, 65, 12)" fill-opacity="${(n.hotspot ? 0.95 : 0.8).toFixed(2)}" />`)
  .join('\n');

const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
  <g>
${lines}
  </g>
  <g>
${circles}
  </g>
</svg>
`;

writeFileSync(OUT, svg);
console.log(`Wrote ${OUT}: ${nodes.length} nodes, ${edges.length} edges, viewBox ${W}x${H}`);
