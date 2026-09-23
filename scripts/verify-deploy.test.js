// Guards scripts/verify-deploy.mjs, the post-deploy check for cto/AdaptaLabs#158
// (a Kubera deploy job can go green after its ArgoCD push silently fails, so
// that side never actually deploys). These tests never make a real HTTP call
// and never wait a real interval: pollDeploy takes a fake `fetchImpl` and
// tiny timeout/poll-interval overrides, so the whole file runs in well under
// a second despite exercising the real bounded-wait loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollDeploy, releaseWillDeploy, DEFAULT_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS } from './verify-deploy.mjs';

const SHA = 'ed28f3d3abc1234567890abcdef1234567890ab';
const OLD_SHA = 'ce212d1dabc1234567890abcdef1234567890ab';

function jsonResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => JSON.stringify(body)
  };
}

function htmlResponse() {
  return {
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => '<!doctype html><html>spa fallback</html>'
  };
}

// A fetch stub that always answers the given revision for both endpoints,
// regardless of URL - good enough because pollDeploy never inspects the URL
// beyond building it.
function fetchAlwaysRevision(revision) {
  return async () => jsonResponse({ revision });
}

test('the timeout is pinned at ten minutes and the poll interval at fifteen seconds', () => {
  // Written down as literals, not derived from the export itself - so a
  // change to either constant shows up as a failing assertion here rather
  // than passing silently because the test recomputed the same value.
  assert.equal(DEFAULT_TIMEOUT_MS, 600000);
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 15000);
});

test('releaseWillDeploy: both arms', () => {
  assert.equal(releaseWillDeploy('7.111.0'), true);
  assert.equal(releaseWillDeploy(''), false);
  assert.equal(releaseWillDeploy(undefined), false);
  assert.equal(releaseWillDeploy('   '), false);
});

test('resolves ok as soon as both sides already serve the expected revision', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return jsonResponse({ revision: SHA });
  };

  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl,
    timeoutMs: 200,
    pollIntervalMs: 5
  });

  assert.equal(result.ok, true);
  assert.equal(calls, 2); // one /api/health + one /version.json, no retry needed
});

test('cache-busts both requests with a ?cb= query param', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return jsonResponse({ revision: SHA });
  };

  await pollDeploy({ baseUrl: 'https://example.test', expectedSha: SHA, fetchImpl, timeoutMs: 200, pollIntervalMs: 5 });

  assert.equal(urls.length, 2);
  assert.match(urls.find((u) => u.includes('/api/health')), /\/api\/health\?cb=\d+/);
  assert.match(urls.find((u) => u.includes('/version.json')), /\/version\.json\?cb=\d+/);
});

// CONTROL ARM. An absence-assertion (the ok:false / failure path below) only
// means something if the checker can ALSO report ok:true when the revisions
// genuinely match - this test is that positive control, run with the exact
// same fetch shape the mismatch tests use below.
test('CONTROL: matching revisions on both sides report ok', async () => {
  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl: fetchAlwaysRevision(SHA),
    timeoutMs: 200,
    pollIntervalMs: 5
  });
  assert.equal(result.ok, true);
});

test('fails by name when the api side never catches up, naming api and pointing at its deploy job', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/api/health')) return jsonResponse({ revision: OLD_SHA });
    return jsonResponse({ revision: SHA });
  };

  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl,
    timeoutMs: 30,
    pollIntervalMs: 5
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.lagging, ['api']);
  assert.match(result.message, /\bapi\b/);
  assert.doesNotMatch(result.message, /\bweb\b/);
  assert.match(result.message, /kubera-playground-backend/);
  assert.match(result.message, /failed to push/);
  assert.match(result.message, /cto\/AdaptaLabs#158/);
});

test('fails by name when the web side never catches up, naming web and pointing at its deploy job', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/version.json')) return jsonResponse({ revision: OLD_SHA });
    return jsonResponse({ revision: SHA });
  };

  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl,
    timeoutMs: 30,
    pollIntervalMs: 5
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.lagging, ['web']);
  assert.match(result.message, /\bweb\b/);
  assert.match(result.message, /kubera-playground-frontend/);
});

test('fails by name naming BOTH sides when neither catches up', async () => {
  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl: fetchAlwaysRevision(OLD_SHA),
    timeoutMs: 30,
    pollIntervalMs: 5
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.lagging.sort(), ['api', 'web']);
  assert.match(result.message, /kubera-playground-backend/);
  assert.match(result.message, /kubera-playground-frontend/);
});

test('a mismatch is not attributable to a bug in the fixture: same revision on both sides but wrong one still fails', async () => {
  // Guards against a checker that only ever compares api to web (which a
  // wrong-but-equal pair would pass) rather than each side to expectedSha.
  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl: fetchAlwaysRevision(OLD_SHA),
    timeoutMs: 20,
    pollIntervalMs: 5
  });
  assert.equal(result.ok, false);
});

test('the SPA fallback (HTML, HTTP 200) reads as "not yet deployed", not a transport error', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/version.json')) return htmlResponse();
    return jsonResponse({ revision: SHA });
  };

  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl,
    timeoutMs: 15,
    pollIntervalMs: 5
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.lagging, ['web']);
  assert.match(result.message, /not JSON/);
});

test('a fetch that throws (network error) is treated as a non-match, not an unhandled rejection', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/api/health')) throw new Error('ECONNREFUSED');
    return jsonResponse({ revision: SHA });
  };

  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl,
    timeoutMs: 15,
    pollIntervalMs: 5
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.lagging, ['api']);
  assert.match(result.message, /ECONNREFUSED/);
});

test('retries until the timeout: a side that starts stale and then catches up still resolves ok', async () => {
  let apiCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/api/health')) {
      apiCalls += 1;
      return jsonResponse({ revision: apiCalls >= 3 ? SHA : OLD_SHA });
    }
    return jsonResponse({ revision: SHA });
  };

  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl,
    timeoutMs: 1000,
    pollIntervalMs: 5
  });

  assert.equal(result.ok, true);
  assert.ok(apiCalls >= 3);
});
