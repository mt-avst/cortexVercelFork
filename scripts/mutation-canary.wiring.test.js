const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * THE GUARDS ARE CONNECTED, not merely correct.
 *
 * `mutation-canary.test.js` proves what `verdictFor` decides. It cannot prove
 * that `main()` still HANDS IT the facts, and that gap was measured rather than
 * imagined: deleting these two lines from the call site
 *
 *     baselineFinished: baseline.finished,
 *     mutatedFinished: mutated.finished,
 *
 * left both RUNNER_DID_NOT_FINISH guards unreachable in production, and the
 * whole scripts suite reported 160 pass, 0 fail. They are property accesses, so
 * eslint has nothing to say about them either. Dropping `mutationHeld` alone
 * passed 160/160 too, noticed only incidentally by `no-unused-vars`.
 *
 * That is exactly the defect this harness exists to catch - a fact that decides
 * a verdict, unchecked - reintroduced one call site above the fix for it.
 *
 * SO THIS RUNS THE REAL `main()`, end to end, over a throwaway repository:
 * a copy of the script, a one-entry manifest, a target file to mutate, and a
 * FAKE `npx` on PATH that writes whatever report the scenario needs. Nothing is
 * stubbed inside the script itself.
 *
 * Each scenario is its own test so a broken wire fails with a name that says
 * which wire. The KILLED and SURVIVED controls are not decoration: without
 * them, a fixture that had stopped working would satisfy every "this is not a
 * survivor" assertion by never producing one.
 */

const SCRIPT = path.join(__dirname, 'mutation-canary.mjs');
const ENTRY_ID = 'wiring-fixture';
const TEST_NAME = 'holds the line';
const ANCHOR = 'const LOAD_BEARING = 1;';
const MUTATION = 'const LOAD_BEARING = 2;';

/**
 * A fake `npx`, chosen ahead of the real one by PATH.
 *
 * It reads which half of the entry it is running from the `--outputFile` name
 * the harness already passes, so the scenario is driven entirely by env.
 */
const FAKE_NPX = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const outputFile = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
const testName = args[args.indexOf('-t') + 1];
const phase = outputFile.endsWith('.baseline.json') ? 'BASELINE' : 'MUTATED';
const mode = process.env['FAKE_' + phase] || 'pass';

// Death by signal, which is how a runner killed at the ceiling or by the OOM
// killer reaches the harness: no report written, and \`run.signal\` set.
if (mode === 'kill') process.kill(process.pid, 'SIGKILL');

// The clobber: something else puts the original bytes back while the runner is
// working, so the runner never sees the mutation and the test passes.
if (mode === 'revert') fs.writeFileSync(process.env.FAKE_TARGET, process.env.FAKE_PRISTINE);

const status = mode === 'fail' ? 'failed' : 'passed';
fs.writeFileSync(
  outputFile,
  JSON.stringify({
    testResults: [
      {
        message: '',
        assertionResults: [
          {
            fullName: 'a describe chain ' + testName,
            status,
            failureMessages: status === 'failed' ? ['AssertionError: expected 1 to be 2'] : []
          }
        ]
      }
    ]
  })
);
process.exit(status === 'failed' ? 1 : 0);
`;

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-wiring-'));

  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'src'));
  // `runNamedTest` spawns with cwd REPO_ROOT/backend. A missing cwd is an
  // ENOENT from spawnSync itself, which would make every scenario report
  // RUNNER_DID_NOT_FINISH and quietly pass three of these tests for the wrong
  // reason.
  fs.mkdirSync(path.join(root, 'backend'));
  fs.mkdirSync(path.join(root, 'fakebin'));

  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'mutation-canary.mjs'));
  fs.writeFileSync(
    path.join(root, 'scripts', 'mutation-canary.manifest.json'),
    JSON.stringify([
      {
        id: ENTRY_ID,
        why: 'a fixture entry, so this file can drive the real main()',
        file: 'src/target.ts',
        anchor: ANCHOR,
        mutation: MUTATION,
        runner: 'jest',
        spec: 'src/target.test.ts',
        test: TEST_NAME
      }
    ])
  );
  fs.writeFileSync(path.join(root, 'scripts', 'mutation-canary.removed.json'), '[]');

  const target = path.join(root, 'src', 'target.ts');
  const pristine = `export ${ANCHOR}\n`;
  fs.writeFileSync(target, pristine);

  const npx = path.join(root, 'fakebin', 'npx');
  fs.writeFileSync(npx, FAKE_NPX, { mode: 0o755 });

  // main() reads the tree through `git status --porcelain` and REFUSES if git
  // cannot run at all, so the throwaway repository needs to be one.
  const init = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);

  return { root, target, pristine, npx };
}

function runHarness(fixture, modes) {
  const run = spawnSync(process.execPath, ['scripts/mutation-canary.mjs', '--allow-dirty'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.dirname(fixture.npx)}${path.delimiter}${process.env.PATH}`,
      FAKE_TARGET: fixture.target,
      FAKE_PRISTINE: fixture.pristine,
      ...modes
    }
  });

  const line = `${run.stdout}\n${run.stderr}`
    .split('\n')
    .find((l) => l.includes(ENTRY_ID));

  return {
    verdict: (line ?? '').trim().split(/\s+/)[0] ?? '',
    status: run.status,
    output: `${run.stdout}\n${run.stderr}`
  };
}

const withFixture = (t, modes, assertions) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = runHarness(fixture, modes);
  assertions(result, fixture);
  // Whatever the verdict, the tree goes back. A harness that dies mid-mutation
  // hands the next reader a defect wearing its name.
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.pristine);
};

test('main() grades an honest entry, so the fixture can produce a kill', (t) => {
  withFixture(t, { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'fail' }, (result) => {
    assert.equal(result.verdict, 'KILLED', result.output);
    assert.equal(result.status, 0);
  });
});

test('main() can still report a survivor, or the guards below prove nothing', (t) => {
  // THE CONTROL FOR MUTATION_WAS_LOST. A guard that fired always would satisfy
  // the clobber test just as well as a correct one; this is what says SURVIVED
  // is still reachable through the real loop.
  withFixture(t, { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'pass' }, (result) => {
    assert.equal(result.verdict, 'SURVIVED', result.output);
    assert.equal(result.status, 1);
  });
});

test('main() hands verdictFor whether the BASELINE runner finished', (t) => {
  // Deleting `baselineFinished: baseline.finished` from the call site makes
  // this TEST_MISSING - the manifest blamed for naming a test that is right
  // there - and nothing else in the suite notices.
  withFixture(t, { FAKE_BASELINE: 'kill' }, (result) => {
    assert.equal(result.verdict, 'RUNNER_DID_NOT_FINISH', result.output);
    assert.equal(result.status, 1);
  });
});

test('main() hands verdictFor whether the MUTATED runner finished', (t) => {
  // Deleting `mutatedFinished: mutated.finished` makes this
  // MUTATION_DID_NOT_BUILD - go and look for a syntax error in a mutation that
  // is fine.
  withFixture(t, { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'kill' }, (result) => {
    assert.equal(result.verdict, 'RUNNER_DID_NOT_FINISH', result.output);
    assert.equal(result.status, 1);
  });
});

test('main() hands verdictFor whether the mutation was still on disk', (t) => {
  // The clobber cto/AdaptaLabs#50 is about, driven through the real loop:
  // the runner puts the original bytes back and then passes. Deleting
  // `mutationHeld` makes this SURVIVED, which reads as "your test is
  // decorative" about a test nobody has broken.
  withFixture(t, { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'revert' }, (result) => {
    assert.equal(result.verdict, 'MUTATION_WAS_LOST', result.output);
    assert.equal(result.status, 1);
  });
});
