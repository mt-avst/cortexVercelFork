#!/usr/bin/env node
/**
 * Post-deploy verification.
 *
 * Answers the question a green pipeline cannot: is the change I just merged
 * actually being served? Both halves of the app report the commit they were
 * built from, so this asks them rather than inferring from job status.
 *
 * Usage:
 *   node scripts/verify-production.mjs [BASE_URL]
 *   BASE_URL=<url>            defaults to the playground host
 *   EXPECTED_REVISION=<sha>   assert THIS commit is live (full or short sha)
 *
 * Exit 0 if every check passes, 1 otherwise.
 *
 * WHY `EXPECTED_REVISION` TAKES A MERGE COMMIT. MRs here are squashed, so the
 * commit you pushed to your branch never lands on main - what lands is a new
 * commit under a merge commit, and the images are stamped with the merge
 * commit's sha (`CI_COMMIT_SHA` of the main pipeline). Passing your branch tip
 * will always report "not live" even when it is. Use the merge commit, or run
 * `git tag --contains <reported-revision>` afterwards to recover the release.
 */

const BASE_URL =
  process.env.BASE_URL ||
  process.argv[2] ||
  'https://adaptalabs.kubera-playground.adaptavist.net';
const base = BASE_URL.replace(/\/$/, '');
const expected = process.env.EXPECTED_REVISION?.trim().toLowerCase() || null;

const failures = [];

function fail(name, detail) {
  console.error(`FAIL ${name}: ${detail}`);
  failures.push(name);
  return null;
}

async function fetchText(name, url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return { res, text: await res.text() };
  } catch (err) {
    return fail(name, err.message);
  }
}

/**
 * The backend's own report.
 *
 * `status` is the field, NOT `ok` - this check previously validated
 * `j.ok === true`, which no version of the endpoint has ever returned, so it
 * failed against a perfectly healthy deployment and the script's overall
 * verdict was "failed" every time anyone ran it.
 */
async function checkBackend() {
  const got = await fetchText('backend', `${base}/api/health`);
  if (!got) return null;

  const { res, text } = got;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail('backend', `not JSON: ${text.slice(0, 120)}`);
  }

  // 503 is a real answer here, not a transport failure: the endpoint reports a
  // degraded database deliberately, and it still carries the revision.
  if (body.status !== 'ok') {
    fail('backend', `status=${body.status} database=${body.database} (HTTP ${res.status})`);
  } else {
    console.log(`OK   backend        ${body.database} (${body.databaseLatencyMs}ms)`);
  }

  return body.revision ?? null;
}

/**
 * The frontend's own report.
 *
 * CHECKS THE CONTENT TYPE, NOT THE STATUS CODE, and that is the whole point of
 * this check. nginx serves the SPA with `try_files $uri $uri/ /index.html`, so
 * any pod WITHOUT this file answers `/version.json` with index.html and
 * **HTTP 200**. A status-code check reports success against a frontend that
 * has not rolled at all - observed live during the rollout that introduced it.
 */
async function checkFrontend() {
  const got = await fetchText('frontend', `${base}/version.json`);
  if (!got) return null;

  const { res, text } = got;
  const contentType = res.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    return fail(
      'frontend',
      `served ${contentType || 'no content-type'} (HTTP ${res.status}) - this is the SPA ` +
        'fallback, so the frontend pod predates /version.json and has not rolled yet'
    );
  }

  try {
    const body = JSON.parse(text);
    console.log('OK   frontend      version.json served as JSON');
    return body.revision ?? null;
  } catch {
    return fail('frontend', `not JSON despite content-type: ${text.slice(0, 120)}`);
  }
}

/** Unchanged: confirms the database and environment through the nginx proxy. */
async function checkOpportunities() {
  const got = await fetchText('opportunities', `${base}/api/opportunities`);
  if (!got) return;

  const { res, text } = got;
  if (!res.ok) return void fail('opportunities', `${res.status} ${res.statusText}`);
  if (!(res.headers.get('content-type') || '').includes('application/json')) {
    return void fail('opportunities', 'not JSON');
  }
  try {
    if (!Array.isArray(JSON.parse(text))) return void fail('opportunities', 'not an array');
  } catch {
    return void fail('opportunities', 'unparseable');
  }
  console.log('OK   opportunities  database and environment reachable');
}

const backendRevision = await checkBackend();
const frontendRevision = await checkFrontend();
await checkOpportunities();

console.log('');
console.log(`     backend  revision: ${backendRevision ?? 'not reported'}`);
console.log(`     frontend revision: ${frontendRevision ?? 'not reported'}`);

/**
 * `unknown` is not a deploy failure and must not be reported as a healthy one
 * either: it means the pod rolled but the APP_COMMIT_SHA build argument never
 * reached the image, so the deploy cannot be verified at all. Both endpoints
 * report the field always, rather than omitting it, precisely so this case is
 * visible instead of silent.
 */
for (const [name, revision] of [
  ['backend', backendRevision],
  ['frontend', frontendRevision]
]) {
  if (revision === 'unknown') {
    fail(name, 'reports revision "unknown" - the build argument did not reach the image');
  }
}

// The two roll independently, so a mismatch mid-roll is expected rather than
// broken - but it does mean the deploy is not finished, and saying "passed"
// here would be the same false confidence this script exists to remove.
if (
  backendRevision &&
  frontendRevision &&
  backendRevision !== 'unknown' &&
  frontendRevision !== 'unknown' &&
  backendRevision !== frontendRevision
) {
  fail(
    'revisions',
    'backend and frontend are serving different commits - they roll independently, ' +
      'so this is usually a deploy in progress. Re-run in a few minutes.'
  );
}

if (expected) {
  const matches = [backendRevision, frontendRevision].every(
    (revision) => revision && revision.toLowerCase().startsWith(expected)
  );
  if (matches) {
    console.log(`OK   expected       ${expected} is live on both halves`);
  } else {
    fail('expected', `${expected} is not what both halves are serving`);
  }
}

console.log('');
if (failures.length === 0) {
  console.log('Production verification passed.');
  process.exit(0);
}
console.error(`Production verification failed: ${failures.join(', ')}`);
process.exit(1);
