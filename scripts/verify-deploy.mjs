#!/usr/bin/env node
/**
 * Post-deploy verification for cto/AdaptaLabs#158.
 *
 * cto/AdaptaLabs#158: the Kubera platform's ArgoCD push can fail silently -
 * the deploy job's trace logs "failed to push some refs" as a WARNING,
 * immediately follows it with "Pushed changes to the remote repository", and
 * exits 0. Every pipeline surface (the job, the `trigger-deployment-prod`
 * bridge, the parent pipeline) reports green while that half of the app never
 * rolled. This script is the in-repo mitigation: it polls what is actually
 * SERVED rather than trusting job exit codes, and turns a silent skip into a
 * red pipeline.
 *
 * This is NOT a fix for the platform bug - the real fix (fail the push,
 * retry on rejection) belongs to the Kubera platform component
 * (to-be-continuous/kubera) and is tracked in #158, which stays open.
 *
 * NO RELEASE GATE, DELIBERATELY - and this needs explaining, because an
 * earlier version of this script skipped the check whenever
 * $SEMREL_INFO_NEXT_VERSION was empty (i.e. whenever semantic-release cut no
 * version). That was wrong, and would have defeated the whole point of #158
 * on most real deploys. What actually happens on every push to main that
 * reaches this job:
 *
 *   - DOCKER_BUILD_ARGS (the root `variables:` block in .gitlab-ci.yml) bakes
 *     `--build-arg APP_COMMIT_SHA=$CI_COMMIT_SHA` into both images, and both
 *     backend and frontend set `DOCKER_BUILD_CACHE_DISABLED: "true"` - so
 *     EVERY commit on main produces a fresh image build, keyed on that
 *     commit's own sha, regardless of whether semantic-release releases it.
 *   - `.kubera-image-work-skip` (the only build-skip rule the kubera
 *     component defines) only applies to $FEAT_REF branches, never to
 *     $PROD_REF - so main's build is never skipped.
 *   - `trigger-deployment-prod` itself has no release condition either - its
 *     only rule is `$CI_COMMIT_REF_NAME =~ $PROD_REF`. It always fires, and
 *     its downstream dynamic pipeline (`generate-environment-jobs`) resolves
 *     and deploys the image DIGEST this pipeline's build produced - confirmed
 *     against real traces (pipeline 383708, a `chore:` merge with no
 *     SEMREL_INFO_NEXT_VERSION: deploy job 383713 logged "deploying image
 *     digest resolved by this pipeline" for BOTH apps).
 *     `$SEMREL_INFO_NEXT_VERSION`/`$SEMREL_INFO_LAST_VERSION` only choose the
 *     cosmetic `APP_VERSION` label attached to the deploy, not which image
 *     digest gets rolled - so their absence is not evidence of a no-op
 *     deploy.
 *   - The ONLY commits that deploy nothing are the ones `check-release-will-
 *     deploy` (in .gitlab-ci.yml) already fails the pipeline on BEFORE the
 *     build/deploy stages run: deploy-path changes squashed as a
 *     non-releasing commit type. Those never reach `trigger-deployment-prod`
 *     at all, so they never reach `verify-deploy` either - `needs:
 *     [trigger-deployment-prod]` is the only gate this script needs, because
 *     if this script is running, something was just deployed and
 *     $CI_COMMIT_SHA is what should be live.
 *
 * Usage (CI):
 *   CI_COMMIT_SHA=<sha> node scripts/verify-deploy.mjs
 *
 * Usage (manual):
 *   node scripts/verify-deploy.mjs --sha <sha> [--base-url <url>]
 *
 * Exit 0 when the deploy is confirmed live (or already superseded by a newer
 * one - see classifyRevision). Exit 1, BY NAME, when the timeout is hit
 * before both sides serve the expected revision (or a descendant of it).
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://adaptalabs.kubera-playground.adaptavist.net';

// Pinned literals, not derived from each other - see scripts/verify-deploy.test.js,
// which asserts these exact numbers so a change to either is a visible diff.
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, per #158
export const DEFAULT_POLL_INTERVAL_MS = 15 * 1000; // 15 seconds
// Per-request cap, so a hung server cannot stall a single poll attempt past
// the overall budget - each request gets min(this, whatever of the overall
// timeout remains).
export const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;

// Which deploy job's trace to point the reader at for each lagging side -
// the exact job names from #158's own trace (kubera-playground-backend /
// kubera-playground-frontend), not a paraphrase.
const DEPLOY_JOB_BY_SIDE = {
  api: 'kubera-playground-backend',
  web: 'kubera-playground-frontend'
};

async function fetchRevision(fetchImpl, url, { requestTimeoutMs } = {}) {
  let res;
  try {
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && requestTimeoutMs > 0
        ? AbortSignal.timeout(requestTimeoutMs)
        : undefined;
    res = await fetchImpl(url, signal ? { signal } : undefined);
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timed out' : err.message;
    return { ok: false, error: `request failed: ${reason}` };
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    return { ok: false, error: `could not read response body: ${err.message}` };
  }

  const contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') || '' : '';

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // The frontend's nginx serves the SPA fallback (index.html, HTTP 200) for
    // any pod that predates /version.json, so a JSON-parse failure here is
    // "not deployed yet", not a transport error - same reasoning as
    // verify-production.mjs's checkFrontend.
    return {
      ok: false,
      error: `not JSON (HTTP ${res.status}, content-type "${contentType || 'none'}"): ${text.slice(0, 120)}`
    };
  }

  return { ok: true, revision: typeof body.revision === 'string' ? body.revision : null, status: res.status };
}

/**
 * Whether `candidate` is an ancestor of (or equal to) `of`, using the
 * checkout `verify-deploy` runs inside (GitLab's default clone).
 *
 * Returns true/false when git can answer, or null when it cannot (git
 * missing, or the commit is unknown locally - e.g. a shallow clone that
 * never fetched it). null means "don't know", not "no" - callers must treat
 * it as inconclusive, not as a failed ancestry check.
 */
export function isAncestor(candidate, of, { cwd = process.cwd() } = {}) {
  if (!candidate || !of) return null;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', candidate, of], { cwd, stdio: 'ignore' });
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    return null;
  }
}

/**
 * How a served revision compares to what we expected - so the failure
 * message never tells someone to retry a deploy job that would roll
 * production BACKWARD.
 *
 * - 'ahead': servedRevision equals expectedSha, or expectedSha is an
 *   ancestor of servedRevision (a LATER pipeline already deployed something
 *   newer - commonly because this pipeline got superseded rather than
 *   cancelled). Counts as caught up; not a failure.
 * - 'behind': servedRevision is an ancestor of expectedSha - the ordinary
 *   "still rolling out, or the push silently failed" case. Safe to suggest
 *   retrying that side's deploy job.
 * - 'unknown': no served revision, or git could not establish either
 *   direction (missing history, git unavailable, unrelated trees). Treated
 *   as a failure like 'behind', but the message says ordering is unknown
 *   rather than suggesting a retry that could be the wrong direction.
 */
export function classifyRevision(expectedSha, servedRevision, { isAncestorFn = isAncestor, cwd } = {}) {
  if (!servedRevision) return 'unknown';
  const expectedLower = expectedSha.toLowerCase();
  const servedLower = servedRevision.toLowerCase();
  if (servedLower === expectedLower) return 'ahead'; // exact match; treated as caught up
  if (isAncestorFn(servedRevision, expectedSha, { cwd }) === true) return 'behind';
  if (isAncestorFn(expectedSha, servedRevision, { cwd }) === true) return 'ahead';
  return 'unknown';
}

function describe(result) {
  if (!result.ok) return result.error;
  if (!result.revision) return 'responded with no revision field';
  return `revision=${result.revision}`;
}

function buildTimeoutMessage({ lagging, api, web, expectedSha, timeoutMs, classification }) {
  const seconds = Math.round(timeoutMs / 1000);
  const sideLines = lagging
    .map((side) => {
      const result = side === 'api' ? api : web;
      const job = DEPLOY_JOB_BY_SIDE[side];
      const cls = classification[side];
      const advice =
        cls === 'unknown'
          ? `ordering against ${expectedSha} could not be established (no git history, or the served ` +
            `revision is unrelated) - do NOT assume retrying ${job} is safe until you have checked by hand`
          : `grep the ${job} job's trace for "failed to push" and retry that job (see cto/AdaptaLabs#158)`;
      return `  - ${side}: ${describe(result)} (expected ${expectedSha}) - ${advice}`;
    })
    .join('\n');

  return (
    `verify-deploy: timed out after ${seconds}s waiting for ${lagging.join(' and ')} ` +
    `to serve ${expectedSha} (or a later commit).\n${sideLines}`
  );
}

/**
 * Poll /api/health and /version.json until both report `expectedSha` (or a
 * commit that descends from it - see classifyRevision), or `timeoutMs`
 * elapses.
 *
 * `fetchImpl` defaults to the global `fetch` (Node 20+); tests inject a fake
 * so no test makes a real HTTP call or waits the real interval.
 */
export async function pollDeploy({
  baseUrl,
  expectedSha,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  isAncestorFn = isAncestor,
  cwd,
  onAttempt
} = {}) {
  if (!baseUrl) throw new Error('pollDeploy: baseUrl is required');
  if (!expectedSha) throw new Error('pollDeploy: expectedSha is required');

  const base = baseUrl.replace(/\/$/, '');
  const start = Date.now();

  for (;;) {
    const elapsedSoFar = Date.now() - start;
    const remaining = Math.max(1, timeoutMs - elapsedSoFar);
    const perRequestTimeout = Math.min(requestTimeoutMs, remaining);

    // Cache-bust both requests: version.json is already `no-store`, but this
    // is belt-and-braces against any intermediate cache (CDN, proxy) that
    // does not honour it.
    const cb = Date.now();
    const [api, web] = await Promise.all([
      fetchRevision(fetchImpl, `${base}/api/health?cb=${cb}`, { requestTimeoutMs: perRequestTimeout }),
      fetchRevision(fetchImpl, `${base}/version.json?cb=${cb}`, { requestTimeoutMs: perRequestTimeout })
    ]);

    // A transport failure or a response with no revision field is the
    // ordinary "hasn't deployed" case, not an ambiguous-ordering one - only
    // classify as 'unknown' when we actually have a revision to compare and
    // git cannot place it, so the failure message's retry advice stays
    // correct for the common case (silent push failure, #158) and only
    // hedges when there is a genuine "which way is this?" question.
    const classification = {
      api: api.ok && api.revision ? classifyRevision(expectedSha, api.revision, { isAncestorFn, cwd }) : 'behind',
      web: web.ok && web.revision ? classifyRevision(expectedSha, web.revision, { isAncestorFn, cwd }) : 'behind'
    };
    const apiMatches = classification.api === 'ahead';
    const webMatches = classification.web === 'ahead';

    if (typeof onAttempt === 'function') {
      onAttempt({ api, web, apiMatches, webMatches, elapsedMs: Date.now() - start });
    }

    if (apiMatches && webMatches) {
      return { ok: true, api, web, elapsedMs: Date.now() - start };
    }

    const elapsedMs = Date.now() - start;
    if (elapsedMs >= timeoutMs) {
      const lagging = [];
      if (!apiMatches) lagging.push('api');
      if (!webMatches) lagging.push('web');
      return {
        ok: false,
        api,
        web,
        lagging,
        elapsedMs,
        message: buildTimeoutMessage({ lagging, api, web, expectedSha, timeoutMs, classification })
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function parseArgs(argv) {
  const args = { sha: null, baseUrl: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sha') args.sha = argv[++i];
    else if (argv[i] === '--base-url') args.baseUrl = argv[++i];
  }
  return args;
}

/**
 * The whole CLI, minus process.exit - so a test can call this directly and
 * assert on the returned code instead of forking a subprocess for every
 * case. Nothing here reads `process.env`/`process.argv` except through the
 * `env`/`argv` parameters, so every input is injectable.
 */
export async function run({
  env = process.env,
  argv = process.argv.slice(2),
  fetchImpl = fetch,
  log = console.log,
  error = console.error
} = {}) {
  const cliArgs = parseArgs(argv);
  const expectedSha = cliArgs.sha || env.CI_COMMIT_SHA;
  const baseUrl = cliArgs.baseUrl || env.VERIFY_DEPLOY_BASE_URL || DEFAULT_BASE_URL;
  // Test-only overrides so a subprocess test can exercise the real timeout
  // path without actually waiting ten minutes. Unset in every real CI run,
  // where the pinned defaults above apply.
  const timeoutMs = env.VERIFY_DEPLOY_TIMEOUT_MS ? Number(env.VERIFY_DEPLOY_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = env.VERIFY_DEPLOY_POLL_INTERVAL_MS
    ? Number(env.VERIFY_DEPLOY_POLL_INTERVAL_MS)
    : DEFAULT_POLL_INTERVAL_MS;

  if (!expectedSha) {
    error('FAIL verify-deploy: no commit sha given (CI_COMMIT_SHA or --sha).');
    return 1;
  }

  log(
    `verify-deploy: polling ${baseUrl} for up to ${Math.round(timeoutMs / 1000)}s for both ` +
      `/api/health and /version.json to report ${expectedSha} (or a later commit)...`
  );

  const result = await pollDeploy({ baseUrl, expectedSha, fetchImpl, timeoutMs, pollIntervalMs });

  if (result.ok) {
    log(`OK verify-deploy: api and web both serve ${expectedSha} (after ${Math.round(result.elapsedMs / 1000)}s).`);
    return 0;
  }

  error(result.message);
  return 1;
}

// Run only when invoked directly - so importing this module from a test
// never triggers the CLI. `realpathSync` + `pathToFileURL` (rather than the
// bare `pathToFileURL(process.argv[1])` this repo's deploy-timing.mjs uses)
// so this still resolves correctly when the script is reached through a
// symlink or a path containing a space: `pathToFileURL` alone already
// percent-encodes the space, `realpathSync` is what canonicalises a symlink.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMain) {
  const code = await run();
  process.exitCode = code;
}
