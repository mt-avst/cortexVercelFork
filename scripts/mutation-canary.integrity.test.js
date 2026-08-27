'use strict';

/**
 * Run with: node --test scripts/mutation-canary.integrity.test.js
 *
 * THE MANIFEST-LOSS GATE. cto/AdaptaLabs#29.
 *
 * `scripts/mutation-canary.manifest.json` is a JSON array every branch appends
 * to, so two branches in flight conflict on it routinely, and the danger is not
 * the conflict - it is a SILENT RESOLUTION that takes one side and drops
 * entries. `validateManifest` checks shape and duplicate ids, not counts, so the
 * canary then reports e.g. `70/70 killed` over a manifest that quietly lost
 * seven. Measured twice on 2026-08-23 (!227 and !228 into main): the union had
 * to be computed by hand each time, and neither branch's own count was the
 * number to expect.
 *
 * This gate compares the working manifest against the manifest as committed at
 * the MERGE-BASE with the base branch, and fails on any id that is gone and not
 * listed in `mutation-canary.removed.json`. It is the DURABLE form, not the
 * merge-time "zero deletions" form: a legitimate removal is stated in the ledger
 * and passes, so the gate never red-blocks a real removal and get itself
 * switched off. The pure logic lives in `unstatedRemovals`; this file drives it
 * against real throwaway git repositories and against this repo.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const load = () => import('./mutation-canary.mjs');

const MANIFEST_REL = 'scripts/mutation-canary.manifest.json';
const LEDGER_REL = 'scripts/mutation-canary.removed.json';

/**
 * These tests drive real git against throwaway repos, and the node alpine image
 * CI uses does not ship git. Fail once, clearly, rather than as a wall of
 * `spawnSync git ENOENT`; the `test-scripts` job installs it with
 * `apk add --no-cache git`, as check-release-will-deploy.test.js already needs.
 */
function requireGit() {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(
      'git is not available on PATH, so the manifest-loss gate cannot be tested. ' +
        'The test-scripts CI job installs it with `apk add --no-cache git`.'
    );
  }
}

const entry = (id) => ({
  id,
  why: 'because',
  file: 'backend/src/x.ts',
  anchor: `anchor-${id}`,
  mutation: `mutation-${id}`,
  runner: 'jest',
  spec: 'src/x.test.ts',
  test: `test ${id}`,
});

/**
 * A throwaway repo whose `main` holds a manifest of `baseIds` and an empty
 * ledger, then a `feature` branch checked out on top. Returns helpers to mutate
 * the working tree and to advance `main` after the fork - the latter is how the
 * merge-base property is exercised.
 */
function repoOnFeature(baseIds) {
  requireGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-loss-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

  const writeManifest = (ids) => {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_REL), JSON.stringify(ids.map(entry), null, 2));
  };
  const writeLedger = (removed) =>
    fs.writeFileSync(path.join(dir, LEDGER_REL), JSON.stringify(removed, null, 2));

  writeManifest(baseIds);
  writeLedger([]);
  git('add', '-A');
  git('commit', '-qm', 'base');

  git('checkout', '-q', '-b', 'feature');

  return {
    dir,
    writeManifest,
    writeLedger,
    // Advance main past the fork, so merge-base(feature, main) is the fork, not
    // main's tip - the whole reason the comparison is against the merge-base.
    advanceMain(ids) {
      git('stash', '-q', '--include-untracked');
      git('checkout', '-q', 'main');
      writeManifest(ids);
      git('add', '-A');
      git('commit', '-qm', 'main advances');
      git('checkout', '-q', 'feature');
      try {
        git('stash', 'pop', '-q');
      } catch {
        // nothing was stashed
      }
    },
  };
}

// ---- the pure logic ----

test('unstatedRemovals flags a dropped id, and the ledger excuses a stated one', async () => {
  const { unstatedRemovals } = await load();
  const base = [entry('a'), entry('b'), entry('c')];

  // A dropped id with no ledger entry is a loss.
  assert.deepEqual(unstatedRemovals(base, [entry('a'), entry('b')], []), ['c']);

  // The same drop, stated in the ledger, is fine.
  assert.deepEqual(unstatedRemovals(base, [entry('a'), entry('b')], [{ id: 'c', reason: 'gone' }]), []);

  // Nothing dropped is fine, and a NEW id in current is not a loss.
  assert.deepEqual(unstatedRemovals(base, base, []), []);
  assert.deepEqual(unstatedRemovals(base, [...base, entry('d')], []), []);

  // The control: a ledger for a DIFFERENT id does not excuse the real loss.
  assert.deepEqual(unstatedRemovals(base, [entry('a'), entry('b')], [{ id: 'z', reason: 'x' }]), ['c']);
});

test('the ledger must be a well-formed array, and cannot excuse a live id', async () => {
  const { validateRemovedLedger } = await load();
  const manifest = [entry('a'), entry('b')];

  assert.deepEqual(validateRemovedLedger([], manifest), []);
  assert.deepEqual(validateRemovedLedger([{ id: 'gone', reason: 'anchor removed' }], manifest), []);

  assert.match(validateRemovedLedger('nope', manifest).join(), /must be a JSON array/);
  assert.match(validateRemovedLedger([{ id: 'x' }], manifest).join(), /reason is missing/);
  assert.match(validateRemovedLedger([{ reason: 'x' }], manifest).join(), /id is missing/);
  assert.match(
    validateRemovedLedger([{ id: 'x', reason: 'a' }, { id: 'x', reason: 'b' }], manifest).join(),
    /duplicate id/
  );

  // THE LOAD-BEARING ONE. A ledger entry for an id that is back in the manifest
  // would silently excuse a future real loss of it.
  assert.match(
    validateRemovedLedger([{ id: 'a', reason: 'stale' }], manifest).join(),
    /present in the manifest again/
  );
});

// ---- the real git plumbing, against throwaway repos ----

test('a silent drop against the merge-base is caught, and stating it clears it', async () => {
  const { unstatedRemovalsAgainst, baseRefFor } = await load();
  const repo = repoOnFeature(['a', 'b', 'c']);

  // Drop c on feature, in the working tree.
  repo.writeManifest(['a', 'b']);

  const base = baseRefFor('main', repo.dir);
  assert.deepEqual(unstatedRemovalsAgainst(base, { cwd: repo.dir }), ['c']);

  // State the removal; now it passes.
  repo.writeLedger([{ id: 'c', reason: 'anchor removed in this change' }]);
  assert.deepEqual(unstatedRemovalsAgainst(base, { cwd: repo.dir }), []);
});

test('an entry main gained after the fork is not a false loss', async () => {
  const { unstatedRemovalsAgainst, baseRefFor } = await load();
  const repo = repoOnFeature(['a', 'b', 'c']);

  // main advances to add d; feature never had it. Comparing against main's TIP
  // would flag d as lost - the merge-base does not, because d is not in it.
  repo.advanceMain(['a', 'b', 'c', 'd']);

  const base = baseRefFor('main', repo.dir);
  assert.deepEqual(unstatedRemovalsAgainst(base, { cwd: repo.dir }), []);
});

test('a base commit that lacks the manifest refuses rather than passing', async () => {
  const { unstatedRemovalsAgainst, Refusal } = await load();
  requireGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-loss-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'no manifest here\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').toString().trim();

  // Fails closed: a base it cannot read is a refusal, never an empty result
  // that reads as "nothing was lost".
  assert.throws(() => unstatedRemovalsAgainst(base, { cwd: dir }), Refusal);
});

test('a base manifest that is not a non-empty array refuses rather than passing', async () => {
  const { unstatedRemovalsAgainst, baseRefFor, Refusal } = await load();
  requireGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-loss-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  // A parseable-but-wrong base manifest: valid JSON, not an array. `idsOf` would
  // read it as zero ids and report "nothing lost" - the fail-open the guard
  // closes.
  fs.writeFileSync(path.join(dir, MANIFEST_REL), '{}');
  fs.writeFileSync(path.join(dir, LEDGER_REL), '[]');
  git('add', '-A');
  git('commit', '-qm', 'base with a non-array manifest');
  git('checkout', '-q', '-b', 'feature');
  // A real, well-formed current manifest, so only the BASE is suspect.
  fs.writeFileSync(path.join(dir, MANIFEST_REL), JSON.stringify([entry('a')], null, 2));

  const base = baseRefFor('main', dir);
  assert.throws(() => unstatedRemovalsAgainst(base, { cwd: dir }), Refusal);
});

// ---- the live gate, against THIS repo ----

test('the working manifest has lost no entry against origin/main without saying so', async (t) => {
  const { unstatedRemovalsAgainst, baseRefFor, validateRemovedLedger } = await load();
  requireGit();

  const repoRoot = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, MANIFEST_REL), 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(path.join(repoRoot, LEDGER_REL), 'utf8'));

  // The ledger is checked here too, so a malformed one fails the gate rather
  // than silently excusing everything or nothing.
  assert.deepEqual(validateRemovedLedger(ledger, manifest), []);

  let base;
  try {
    base = baseRefFor('origin/main', repoRoot);
  } catch (error) {
    // A skip that hides in CI is the exact failure the canary docs warn about,
    // so in CI an unresolvable base is a FAILURE, not a skip. Locally - on the
    // shallow exFAT clone where origin/main has no common ancestor - it skips,
    // loudly. The test-scripts job sets GIT_DEPTH:0 and fetches origin/main so
    // this branch is not taken there.
    if (process.env.CI) {
      throw new Error(
        `cannot resolve the merge-base with origin/main in CI (${error.message}). ` +
          'The test-scripts job must fetch origin/main with GIT_DEPTH:0.'
      );
    }
    t.skip('no merge-base with origin/main here (shallow clone); runs in CI where GIT_DEPTH:0 makes it available');
    return;
  }

  const lost = unstatedRemovalsAgainst(base, { cwd: repoRoot });
  assert.deepEqual(
    lost,
    [],
    `the manifest lost these entries against the merge-base without listing them in ${LEDGER_REL}: ${lost.join(', ')}`
  );
});

/**
 * A `-postgres` spec must declare `needsDatabase`.
 *
 * The flag is what makes `ENVIRONMENT_FAILED` reachable: without it,
 * `if (needsDatabase && environmentFailed(...)) return ENVIRONMENT_FAILED` is
 * switched off for the entry, so a mutated run that goes red BECAUSE THE
 * CONTAINER FAILED TO START is graded KILLED. That is a false kill in the one
 * harness whose whole purpose is refusing them, and it fails in the safe-looking
 * direction - green.
 *
 * Found by a gate on !298, which noticed a new entry had omitted it and that two
 * older ones had too. Nothing enforced the invariant, which is why all three
 * were able to omit it, so the invariant is enforced here rather than
 * remembered. Keyed on the spec's filename because that is what actually decides
 * whether a database is needed - the vitest config routes `*-postgres.test.ts`
 * to the suites that start one.
 */
/**
 * The predicate, in ONE place, so the control below exercises the real thing.
 *
 * It was written twice - once in the check, once in the control - and a gate
 * demonstrated exactly what that costs: with an offender present in the
 * manifest, changing the CHECK's regex to `-postgres.test.js` left the file at
 * `pass / fail 0`, invariant blind and control still green. A control that
 * re-declares its subject proves a copy works.
 */
const undeclaredNeedsDatabase = (entries) =>
  entries
    .filter((entry) => /-postgres\.test\.ts$/.test(entry.spec) && !entry.needsDatabase)
    .map((entry) => entry.id);

/**
 * A `-postgres` spec must declare `needsDatabase`.
 *
 * The flag is what makes `ENVIRONMENT_FAILED` reachable: without it,
 * `if (needsDatabase && environmentFailed(...)) return ENVIRONMENT_FAILED` is
 * switched off for the entry, so a mutated run that goes red BECAUSE THE
 * CONTAINER FAILED TO START is graded KILLED. That is a false kill in the one
 * harness whose whole purpose is refusing them, and it fails in the
 * safe-looking direction - green.
 *
 * Found by a gate on !298, which noticed a new entry had omitted it and that two
 * older ones had too. Nothing enforced the invariant, which is why all three
 * were able to omit it, so the invariant is enforced here rather than
 * remembered. Keyed on the spec's filename because that is what actually decides
 * whether a database is needed - backend/vitest.config.ts routes
 * `*-postgres.test.ts` to the suites that start one.
 */
test('every -postgres spec declares needsDatabase', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', MANIFEST_REL), 'utf8')
  );

  const undeclared = undeclaredNeedsDatabase(manifest);

  assert.deepEqual(
    undeclared,
    [],
    'these entries run a -postgres spec without needsDatabase, so a container ' +
      `failure would be graded KILLED: ${undeclared.join(', ')}`
  );
});

test('the check above can see an offender, and calls the real predicate', () => {
  // THE CONTROL, and it calls `undeclaredNeedsDatabase` - the same function the
  // check calls - so breaking the predicate fails HERE too rather than leaving
  // the check blind and this arm green.
  assert.deepEqual(
    undeclaredNeedsDatabase([
      { id: 'made-up', spec: 'src/x/__tests__/thing-postgres.test.ts' },
      { id: 'declared', spec: 'src/x/__tests__/other-postgres.test.ts', needsDatabase: true },
      { id: 'not-a-db-spec', spec: 'src/x/__tests__/plain.test.ts' }
    ]),
    ['made-up']
  );
});
