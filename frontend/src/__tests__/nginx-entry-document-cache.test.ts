import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THE ENTRY DOCUMENT MUST REVALIDATE, AND THE SPA ROUTES MUST KEEP THEIR
 * SECURITY HEADERS WHILE IT DOES. cto/AdaptaLabs#91.
 *
 * Two properties of `frontend/nginx.conf`, pinned structurally because nothing
 * else can see them: no test runs nginx, and the deployed symptom - a tab open
 * across a release 404ing on content-hashed chunks - only ever appears in
 * production, one deploy after the header quietly goes missing.
 *
 * The second property exists because of how the first is implemented. nginx
 * does not inherit server-level `add_header` directives into a location block
 * that declares its own, so the moment `location /` gained `Cache-Control` it
 * had to restate all four security headers - and any future edit that trims
 * "duplicate" headers from that block would strip nosniff from every SPA route
 * while every other check stayed green.
 *
 * Parsed by brace-matching from the location directive rather than by regex
 * over the whole file, so a header in SOME OTHER block cannot satisfy an
 * assertion about this one.
 */

const CONF = readFileSync(path.resolve(__dirname, '../../nginx.conf'), 'utf8');

/**
 * The body of the first location block whose directive line matches `opener`.
 * COMMENT-BLIND on purpose kept simple: a comment containing an opener string
 * or an unbalanced brace misparses, but every such misparse fails RED (wrong
 * block body fails the assertions), never green, so the fragility is fail-safe.
 */
function locationBlock(opener: string): string {
  const at = CONF.indexOf(opener);
  if (at === -1) throw new Error(`nginx.conf has no block opening with: ${opener}`);
  const open = CONF.indexOf('{', at);
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < CONF.length) {
    if (CONF[i] === '{') depth += 1;
    if (CONF[i] === '}') depth -= 1;
    i += 1;
  }
  return CONF.slice(open + 1, i - 1);
}

describe('nginx.conf entry-document caching (cto/AdaptaLabs#91)', () => {
  const spaBlock = locationBlock('location / {');

  it('serves the SPA fallback with Cache-Control no-cache', () => {
    expect(spaBlock).toMatch(/add_header\s+Cache-Control\s+"no-cache"\s+always;/);
  });

  it('does not weaken no-cache to no-store, which would re-download every navigation', () => {
    expect(spaBlock).not.toMatch(/no-store/);
  });

  it('restates all four security headers beside the Cache-Control it declares', () => {
    // nginx add_header inheritance: a location block with its own add_header
    // inherits NOTHING from the server level. Cache-Control alone here would
    // silently strip these from every SPA route.
    for (const header of [
      /add_header\s+X-Frame-Options\s+"SAMEORIGIN"\s+always;/,
      /add_header\s+X-Content-Type-Options\s+"nosniff"\s+always;/,
      /add_header\s+X-XSS-Protection\s+"1; mode=block"\s+always;/,
      /add_header\s+Referrer-Policy\s+"strict-origin-when-cross-origin"\s+always;/,
    ]) {
      expect(spaBlock).toMatch(header);
    }
  });

  it('declares no competing freshness directive beside no-cache', () => {
    // The review gate proved this arm's necessity by adding `expires 1y;` to
    // the SPA block: real nginx then emitted max-age=31536000 AND no-cache -
    // the entry document silently cacheable again - with every presence
    // assertion still green. Absence is the property; presence cannot see it.
    expect(spaBlock).not.toMatch(/expires\s|max-age/);
  });

  it('still routes unknown URIs to index.html', () => {
    expect(spaBlock).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/);
  });

  it('control: the hashed-asset block keeps its long immutable cache', () => {
    // Without this arm, a change that disabled caching EVERYWHERE would pass
    // every assertion above while making each deploy a full re-download.
    const assets = locationBlock('location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg)$ {');
    // NOT `always`: that would stamp a year of immutable onto a 404 for a
    // chunk name mid-rollout, and browsers store explicit-cacheable 404s.
    expect(assets).toMatch(/Cache-Control\s+"public,\s*max-age=31536000,\s*immutable";/);
  });

  it('fonts are cacheable but never immutable: they are not content-hashed', () => {
    // public/ files are copied verbatim, so a year of immutable would make a
    // font swap invisible for a year - and no cache-control at all makes every
    // page load revalidate three @font-face files. Finite max-age, no more.
    const fonts = locationBlock('location ~* \\.(woff2?|ttf|otf|eot)$ {');
    expect(fonts).toMatch(/Cache-Control\s+"public,\s*max-age=2592000";/);
    expect(fonts).not.toMatch(/immutable/);
  });

  it('every location block that declares add_header restates the four security headers', () => {
    // The inheritance trap, enforced wholesale: any block with its own
    // add_header inherits nothing from the server level, so each one must
    // carry the full set. /health carries them too, Content-Type and all.
    for (const opener of [
      'location / {',
      'location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg)$ {',
      'location ~* \\.(woff2?|ttf|otf|eot)$ {',
      'location = /version.json {',
      'location /health {',
    ]) {
      const block = locationBlock(opener);
      for (const header of [
        /add_header\s+X-Frame-Options/,
        /add_header\s+X-Content-Type-Options/,
        /add_header\s+X-XSS-Protection/,
        /add_header\s+Referrer-Policy/,
      ]) {
        expect(block, `${opener} is missing ${header}`).toMatch(header);
      }
    }
  });
});
