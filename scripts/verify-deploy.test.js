// Guards scripts/verify-deploy.mjs, the post-deploy check for cto/AdaptaLabs#158
// (a Kubera deploy job can go green after its ArgoCD push silently fails, so
// that side never actually deploys). Most tests never make a real HTTP call
// and never wait a real interval: pollDeploy/run take a fake `fetchImpl` and
// tiny timeout/poll-interval overrides. Two tests deliberately DO spawn the
// real file as a subprocess and DO exercise real git ancestry, because those
// are exactly the two things a prior review pass found untested: the CLI
// entry-point wiring, and the "which way did this revision move" question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  pollDeploy,
  run,
  isAncestor,
  classifyRevision,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS
} from './verify-deploy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, 'verify-deploy.mjs');

const SHA = 'ed28f3d3abc1234567890abcdef1234567890ab';
const OLD_SHA = 'ce212d1dabc1234567890abcdef1234567890ab';

// Neither SHA/OLD_SHA is a real git object in this checkout, so a mismatch
// test that wants a definite (not "unknown") classification must supply its
// own isAncestorFn rather than let pollDeploy fall through to the real
// `isAncestor`, which would report null (unrelated/unknown) for a
// fabricated hash. classifyRevision's first ancestry check is "is the served
// revision an ancestor of expected" (= behind), so returning true
// unconditionally simulates "servedRevision is definitely behind, not ahead,
// not ambiguous" - the ordinary #158 case - for any pair passed to it.
const alwaysBehind = () => true;

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

function fetchAlwaysRevision(revision) {
  return async () => jsonResponse({ revision });
}

test('the timeout is pinned at ten minutes, the poll interval at fifteen seconds, the request timeout at thirty', () => {
  // Written down as literals, not derived from the export itself - so a
  // change to any constant shows up as a failing assertion here rather than
  // passing silently because the test recomputed the same value.
  assert.equal(DEFAULT_TIMEOUT_MS, 600000);
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 15000);
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 30000);
});

test('resolves ok as soon as both sides already serve the expected revision', async () => {
  let calls = 0;
  const fetchImpl = async () => {
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
    pollIntervalMs: 5,
    isAncestorFn: alwaysBehind
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
    pollIntervalMs: 5,
    isAncestorFn: alwaysBehind
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
    pollIntervalMs: 5,
    isAncestorFn: alwaysBehind
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
    pollIntervalMs: 5,
    isAncestorFn: alwaysBehind
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
  // No revision was ever returned for this side, so this is the ordinary
  // "hasn't deployed" case - the retry advice, not the "ordering unknown" one.
  assert.match(result.message, /failed to push/);
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
    pollIntervalMs: 5,
    isAncestorFn: alwaysBehind
  });

  assert.equal(result.ok, true);
  assert.ok(apiCalls >= 3);
});

test('a hung request is aborted by the per-request timeout rather than blocking past the overall budget', async () => {
  const hungFetch = async (url, opts) =>
    new Promise((resolve, reject) => {
      // A real (ref'd) fallback timer, not just the abort listener: if the
      // per-request abort never fires this still resolves the promise
      // (failing the assertion below on wall-clock time) instead of leaving
      // an unref'd, un-resolvable promise that the test runner reports as
      // "still pending but the event loop has already resolved".
      const fallback = setTimeout(() => resolve(jsonResponse({ revision: OLD_SHA })), 2000);
      opts?.signal?.addEventListener('abort', () => {
        clearTimeout(fallback);
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  const startedAt = Date.now();
  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl: hungFetch,
    timeoutMs: 60,
    pollIntervalMs: 10,
    requestTimeoutMs: 15,
    isAncestorFn: alwaysBehind
  });
  const wallClockMs = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.match(result.message, /timed out/);
  // The real proof: this must not block for anywhere near "forever" - well
  // under the old unbounded-fetch failure mode, and not much past timeoutMs.
  assert.ok(wallClockMs < 2000, `expected well under 2s, took ${wallClockMs}ms`);
});

// --- classifyRevision / isAncestor: the "don't suggest retrying a newer deploy" fix ---

test('classifyRevision: an exact match is "ahead" (caught up)', () => {
  assert.equal(classifyRevision(SHA, SHA), 'ahead');
});

test('classifyRevision: a served revision that is an ancestor of expected is "behind"', () => {
  const cls = classifyRevision(SHA, OLD_SHA, { isAncestorFn: (candidate) => candidate === OLD_SHA });
  assert.equal(cls, 'behind');
});

test('classifyRevision: a served revision that DESCENDS from expected (newer pipeline landed first) is "ahead", not a failure', () => {
  const newerSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const isAncestorFn = (candidate, of) => candidate === SHA && of === newerSha; // expected is an ancestor of served
  assert.equal(classifyRevision(SHA, newerSha, { isAncestorFn }), 'ahead');
});

test('classifyRevision: no revision at all is "unknown"', () => {
  assert.equal(classifyRevision(SHA, null), 'unknown');
  assert.equal(classifyRevision(SHA, undefined), 'unknown');
});

test('classifyRevision: unrelated history (git can place neither direction) is "unknown"', () => {
  const isAncestorFn = () => null;
  assert.equal(classifyRevision(SHA, OLD_SHA, { isAncestorFn }), 'unknown');
});

test('a served revision that is genuinely NEWER than expected resolves ok, and does not suggest retrying', async () => {
  const newerSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const isAncestorFn = (candidate, of) => candidate === SHA && of === newerSha;

  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl: fetchAlwaysRevision(newerSha),
    timeoutMs: 200,
    pollIntervalMs: 5,
    isAncestorFn
  });

  assert.equal(result.ok, true);
});

test('when ordering cannot be established, the failure message hedges instead of advising a retry', async () => {
  const result = await pollDeploy({
    baseUrl: 'https://example.test',
    expectedSha: SHA,
    fetchImpl: fetchAlwaysRevision(OLD_SHA),
    timeoutMs: 15,
    pollIntervalMs: 5,
    isAncestorFn: () => null // git cannot place it either direction
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /could not be established/);
  assert.match(result.message, /do NOT assume retrying/i);
  assert.doesNotMatch(result.message, /failed to push/);
});

test("isAncestor: real git, against this checkout's own history", () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname }).toString().trim();
  const parent = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: __dirname }).toString().trim();

  assert.equal(isAncestor(parent, head, { cwd: __dirname }), true);
  assert.equal(isAncestor(head, parent, { cwd: __dirname }), false);
});

test('isAncestor: an unknown sha (not fetched, or made up) returns null, not false', () => {
  const fake = '0000000000000000000000000000000000dead';
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname }).toString().trim();
  assert.equal(isAncestor(fake, head, { cwd: __dirname }), null);
});

// --- run(): the CLI entry point, called in-process ---

test('run(): fails by name when no commit sha is available, without ever polling', async () => {
  let fetchCalled = false;
  const code = await run({
    env: {},
    argv: [],
    fetchImpl: async () => {
      fetchCalled = true;
      return jsonResponse({ revision: SHA });
    },
    log: () => {},
    error: () => {}
  });

  assert.equal(code, 1);
  assert.equal(fetchCalled, false);
});

test('run(): exits 0 and logs OK when the deploy is already live', async () => {
  const logs = [];
  const code = await run({
    env: { CI_COMMIT_SHA: SHA },
    argv: [],
    fetchImpl: fetchAlwaysRevision(SHA),
    log: (msg) => logs.push(msg)
  });

  assert.equal(code, 0);
  assert.ok(logs.some((l) => l.includes('OK verify-deploy')));
});

test('run(): exits 1 by name on timeout, honouring the test-only VERIFY_DEPLOY_TIMEOUT_MS override', async () => {
  const errors = [];
  const code = await run({
    env: {
      CI_COMMIT_SHA: SHA,
      VERIFY_DEPLOY_TIMEOUT_MS: '20',
      VERIFY_DEPLOY_POLL_INTERVAL_MS: '5'
    },
    argv: [],
    fetchImpl: fetchAlwaysRevision(OLD_SHA),
    log: () => {},
    error: (msg) => errors.push(msg)
  });

  assert.equal(code, 1);
  assert.ok(errors.some((e) => e.includes('timed out')));
});

test('run(): --sha and --base-url override the environment', async () => {
  const urls = [];
  const code = await run({
    env: { CI_COMMIT_SHA: 'ignored-env-sha' },
    argv: ['--sha', SHA, '--base-url', 'https://cli-arg.example.test'],
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse({ revision: SHA });
    },
    log: () => {}
  });

  assert.equal(code, 0);
  assert.ok(urls.every((u) => u.startsWith('https://cli-arg.example.test/')));
});

// --- Subprocess: proves the CLI entry-point WIRING itself (isMain / run() /
// process.exitCode) works, not just the functions it calls. A prior review
// pass mutated the isMain guard, commented out the call to run(), and forced
// exit 0 on timeout - all three left the in-process tests above green,
// because none of them actually execute this file as a program. ---

function startFakeDeployServer(revision) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revision }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runSubprocess(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('SUBPROCESS: the real file exits 0 and prints OK when the deploy is already live', async () => {
  const server = await startFakeDeployServer(SHA);
  const port = server.address().port;
  try {
    const { code, stdout } = await runSubprocess({
      CI_COMMIT_SHA: SHA,
      VERIFY_DEPLOY_BASE_URL: `http://127.0.0.1:${port}`
    });
    assert.equal(code, 0);
    assert.match(stdout, /OK verify-deploy/);
  } finally {
    server.close();
  }
});

test('SUBPROCESS: the real file exits 1 by name on timeout against a server that never catches up', async () => {
  const server = await startFakeDeployServer(OLD_SHA);
  const port = server.address().port;
  try {
    const { code, stderr } = await runSubprocess({
      CI_COMMIT_SHA: SHA,
      VERIFY_DEPLOY_BASE_URL: `http://127.0.0.1:${port}`,
      VERIFY_DEPLOY_TIMEOUT_MS: '30',
      VERIFY_DEPLOY_POLL_INTERVAL_MS: '5'
    });
    assert.equal(code, 1);
    assert.match(stderr, /verify-deploy: timed out/);
  } finally {
    server.close();
  }
});
