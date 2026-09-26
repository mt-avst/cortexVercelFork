// vercel.json carries the page headers nginx.conf used to set on Kubera.
//
// On Kubera, nginx served the SPA and set its security headers and cache
// policy; helmet only ever covered API responses. On Vercel the CDN serves
// the SPA straight from frontend/dist, so those headers exist only if
// vercel.json declares them. This pins what the two retired canary entries
// (nginx-entry-document-is-no-cache, nginx-spa-block-restates-security-headers)
// pinned against nginx.conf:
//
// - index.html names content-hashed chunks that stop existing at the next
//   deploy, so the entry document must revalidate every time (no-cache).
//   A stale index.html points at chunks that 404.
// - every page response carries the four security headers.
// - API and auth responses get none of them from here - helmet owns those,
//   and a second, different X-Frame-Options/Referrer-Policy would conflict.
// - no path is matched by two Cache-Control rules. Vercel does not document
//   which one wins, so the table must never ask.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

// Vercel `source` patterns are path-to-regexp: literal text is escaped, a bare
// `( ... )` group is raw regex. This models exactly that subset and refuses
// anything else (named params, modifiers), so a new pattern shape fails here
// rather than being silently mis-modelled.
function sourceToRegExp(source) {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') {
      let depth = 0;
      let j = i;
      for (; j < source.length; j++) {
        if (source[j] === '\\') { j++; continue; }
        if (source[j] === '(') depth++;
        if (source[j] === ')' && --depth === 0) break;
      }
      out += source.slice(i, j + 1);
      i = j;
    } else if (/[:*+?{}]/.test(ch)) {
      throw new Error(`vercel-config.test.js does not model "${ch}" in source ${source}`);
    } else {
      out += ch.replace(/[.\\^$|[\]]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function headersFor(urlPath) {
  const found = [];
  for (const rule of config.headers) {
    if (sourceToRegExp(rule.source).test(urlPath)) found.push(...rule.headers);
  }
  return found;
}

const SECURITY = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const PAGE_PATHS = ['/', '/admin', '/admin/studies/new', '/index.html', '/assets/Admin-UqImercu.js',
  '/fonts/fraunces-latin.woff2', '/version.json', '/images/logo.png', '/survey/abc'];
const BACKEND_PATHS = ['/api/health', '/api/opportunities/1', '/auth/login', '/auth/callback', '/health'];

test('the source model is exact on a literal dot (control)', () => {
  assert.ok(sourceToRegExp('/version.json').test('/version.json'));
  assert.ok(!sourceToRegExp('/version.json').test('/versionXjson'));
});

for (const p of PAGE_PATHS) {
  test(`${p} carries every security header nginx set`, () => {
    const got = headersFor(p);
    for (const [key, value] of Object.entries(SECURITY)) {
      assert.deepEqual(got.filter((h) => h.key === key).map((h) => h.value), [value], key);
    }
  });

  test(`${p} is matched by exactly one Cache-Control rule`, () => {
    assert.equal(headersFor(p).filter((h) => h.key === 'Cache-Control').length, 1);
  });
}

for (const p of BACKEND_PATHS) {
  test(`${p} gets no headers from vercel.json (helmet owns API responses)`, () => {
    assert.deepEqual(headersFor(p), []);
  });
}

const cacheOf = (p) => headersFor(p).find((h) => h.key === 'Cache-Control').value;

test('the entry document and SPA routes revalidate on every load', () => {
  for (const p of ['/', '/index.html', '/admin', '/survey/abc']) assert.equal(cacheOf(p), 'no-cache', p);
});

test('content-hashed build assets are cached for a year, immutably', () => {
  assert.equal(cacheOf('/assets/Admin-UqImercu.js'), 'public, max-age=31536000, immutable');
});

test('fonts are cached for thirty days, as nginx did', () => {
  assert.equal(cacheOf('/fonts/fraunces-latin.woff2'), 'public, max-age=2592000');
});

test('version.json is never cached', () => {
  assert.equal(cacheOf('/version.json'), 'no-store');
});

test('un-hashed files outside /assets are not cached long', () => {
  assert.equal(cacheOf('/images/logo.png'), 'no-cache');
});
