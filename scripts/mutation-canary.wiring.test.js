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

// NO DATABASE. Measured on vitest 3.2.7: a beforeAll that throws reports the
// suite FAILED with every assertion \`skipped\`, an empty message and 0 bytes of
// stderr. cto/AdaptaLabs#58.
if (mode === 'nodatabase') {
  fs.writeFileSync(
    outputFile,
    JSON.stringify({
      testResults: [
        {
          status: 'failed',
          message: '',
          assertionResults: [
            { fullName: 'a describe chain ' + testName, status: 'skipped', failureMessages: [] }
          ]
        }
      ]
    })
  );
  process.exit(1);
}

// The named test was renamed away: a PASSED suite with nothing selected, which
// is what a genuinely stale manifest entry looks like. Measured on vitest 3.2.7.
if (mode === 'notselected') {
  fs.writeFileSync(
    outputFile,
    JSON.stringify({
      testResults: [
        {
          status: 'passed',
          message: '',
          assertionResults: [
            { fullName: 'a describe chain some other test', status: 'skipped', failureMessages: [] }
          ]
        }
      ]
    })
  );
  process.exit(0);
}

// The database went away mid-test, so the named test is red without the
// property ever having been evaluated.
if (mode === 'dbdied') {
  fs.writeFileSync(
    outputFile,
    JSON.stringify({
      testResults: [
        {
          status: 'failed',
          message: '',
          assertionResults: [
            {
              fullName: 'a describe chain ' + testName,
              status: 'failed',
              failureMessages: ['Error: Connection terminated unexpectedly']
            }
          ]
        }
      ]
    })
  );
  process.exit(1);
}

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

// Sorts BEFORE `wiring-fixture`, so with two entries sharded two ways the
// partition is knowable here: shard 1 owns this one, shard 2 owns ENTRY_ID.
const SECOND_ENTRY_ID = 'another-wiring-fixture';

function makeFixture(entryExtra = {}, { withSecondEntry = false } = {}) {
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
  const manifest = [
    {
      id: ENTRY_ID,
      why: 'a fixture entry, so this file can drive the real main()',
      file: 'src/target.ts',
      anchor: ANCHOR,
      mutation: MUTATION,
      runner: 'jest',
      spec: 'src/target.test.ts',
      test: TEST_NAME,
      ...entryExtra
    }
  ];
  if (withSecondEntry) {
    // Same target, same test: the fake npx answers for any entry, so the
    // second one exists purely to give the partition two cells to separate.
    manifest.push({
      id: SECOND_ENTRY_ID,
      why: 'a second fixture entry, so sharding has a partition to get wrong',
      file: 'src/target.ts',
      anchor: ANCHOR,
      mutation: MUTATION,
      runner: 'jest',
      spec: 'src/target.test.ts',
      test: TEST_NAME
    });
  }
  fs.writeFileSync(path.join(root, 'scripts', 'mutation-canary.manifest.json'), JSON.stringify(manifest));
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

function runHarness(fixture, modes, argv = ['--allow-dirty']) {
  const run = spawnSync(process.execPath, ['scripts/mutation-canary.mjs', ...argv], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.dirname(fixture.npx)}${path.delimiter}${process.env.PATH}`,
      // A `needsDatabase` entry is REFUSED outright without this, so the
      // scenarios that use one would never reach a verdict. Never connected to:
      // the fake npx writes the report itself.
      FIRSTHAND_TEST_DATABASE_URL: 'postgres://never-dialled.invalid:5432/fixture',
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

const withFixture = (t, modes, assertions, argv, entryExtra, fixtureOptions) => {
  const fixture = makeFixture(entryExtra, fixtureOptions);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = runHarness(fixture, modes, argv);
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

/**
 * cto/AdaptaLabs#53. The parser was `process.argv.includes('--allow-dirty')`, so
 * every other argument fell through in silence and the run went ahead as a full
 * one. Driven through the real `main()` because that is the only place argv is
 * read at all.
 *
 * THE CONTROL IS THE FIRST TEST IN THIS FILE: it runs the same fixture with
 * `--allow-dirty` and reaches KILLED, exit 0. Without it, a parser that refused
 * EVERYTHING would satisfy the two tests below just as well as a correct one.
 */
test('an unrecognised argument is refused rather than silently running everything', (t) => {
  // `--allow-dirty` is present and valid, so the only thing left to refuse is
  // `--id`. That also proves the check runs BEFORE the dirty-tree guard, which
  // would otherwise be the thing that exited 2 here.
  withFixture(
    t,
    { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'fail' },
    (result) => {
      assert.equal(result.status, 2, result.output);
      assert.match(result.output, /unrecognised argument/i);
      assert.match(result.output, /--id/);
      // AND NOTHING RAN. The defect was not the missing message, it was the
      // eleven minutes of full manifest that followed it.
      assert.doesNotMatch(result.output, /KILLED/);
      assert.doesNotMatch(result.output, /mutations killed/);
    },
    ['--allow-dirty', '--id', ENTRY_ID]
  );
});

test('a typo in a recognised flag is unrecognised, not a silently dropped permission', (t) => {
  // `--allow-dirty=yes` reads as the same request to a human and was simply
  // ignored, so the run then died on the dirty-tree guard - a confusing failure
  // about the tree instead of a clear one about the argument.
  withFixture(
    t,
    { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'fail' },
    (result) => {
      assert.equal(result.status, 2, result.output);
      assert.match(result.output, /--allow-dirty=yes/);
    },
    ['--allow-dirty=yes']
  );
});

test('the run states its own margin against the ceiling', (t) => {
  // cto/AdaptaLabs#61. The CI margin had only ever been extrapolated from a
  // developer machine; the cheapest way to have the real number is for every
  // job log to state it. The ceiling is pinned as the LITERAL 300, because a
  // summary that read the constant could not see the constant change.
  withFixture(t, { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'fail' }, (result) => {
    assert.match(result.output, /Slowest runner invocation \d+\.\d+s/);
    assert.match(result.output, /against a 300s ceiling/);
    assert.match(result.output, /\dx margin\./);
    // The elapsed pair sits beside the verdict, so a five-minute kill and a
    // runner that died in three seconds are not the same line.
    assert.match(result.output, new RegExp(`KILLED\\s+${ENTRY_ID} \\(\\d+\\.\\ds \\+ \\d+\\.\\ds\\)`));
  });
});

test('the run states how many entries it is about to run', (t) => {
  // Pinned as the LITERAL 1, for a fixture manifest of one entry. Deriving it
  // from the manifest length would make the assertion true whatever the number.
  withFixture(t, { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'fail' }, (result) => {
    assert.match(result.output, /Running all 1 manifest entries/);
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

/**
 * cto/AdaptaLabs#58, driven through the real `main()` because the two facts the
 * verdict now needs - the suite's own status, and the entry's `needsDatabase` -
 * are both read at the call site, and a fact read nowhere is a guard that is
 * unreachable in production however well its unit test passes. That is the
 * exact defect !266's wiring tests were added for, one call site above.
 */
test('main() hands verdictFor whether the entry needs a database', (t) => {
  // Deleting `needsDatabase: Boolean(entry.needsDatabase)` from the call site
  // makes this KILLED, exit 0 - a green job over a property the dead database
  // never let anything evaluate.
  withFixture(
    t,
    { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'dbdied' },
    (result) => {
      assert.equal(result.verdict, 'ENVIRONMENT_FAILED', result.output);
      assert.equal(result.status, 1);
    },
    undefined,
    { needsDatabase: true }
  );
});

test('the same failure on an entry that needs no database is still a kill', (t) => {
  // THE CONTROL FOR THE GATE. Without it, the test above passes just as well
  // against a check that grades every connection-flavoured failure as
  // environmental - including the three suites here that inject one on purpose
  // and assert the response body does not leak it.
  withFixture(t, { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'dbdied' }, (result) => {
    assert.equal(result.verdict, 'KILLED', result.output);
    assert.equal(result.status, 0);
  });
});

test('main() hands verdictFor whether the baseline suite ran anything at all', (t) => {
  // No database, so the BASELINE suite dies in beforeAll having executed
  // nothing. Deleting `baselineRanNothingAndFailed` from the call site makes
  // this TEST_MISSING, which sends the reader to the manifest to look for a
  // test that is sitting right there in the file.
  withFixture(
    t,
    { FAKE_BASELINE: 'nodatabase' },
    (result) => {
      assert.equal(result.verdict, 'ENVIRONMENT_FAILED', result.output);
      assert.equal(result.status, 1);
    },
    undefined,
    { needsDatabase: true }
  );
});

test('a baseline that simply does not contain the named test is still TEST_MISSING', (t) => {
  // THE CONTROL FOR THE ANTI-ROT GUARD, which is the most valuable check in
  // this harness and the easiest one to disarm by widening the verdict above.
  // A renamed test reports a PASSED suite with nothing selected - measured on
  // vitest 3.2.7 - and must still break the build.
  withFixture(
    t,
    { FAKE_BASELINE: 'notselected' },
    (result) => {
      assert.equal(result.verdict, 'TEST_MISSING', result.output);
      assert.equal(result.status, 1);
    },
    undefined,
    { needsDatabase: true }
  );
});

/**
 * cto/AdaptaLabs#77: sharding, driven through the real `main()`.
 *
 * Sharding is a PARTITION, not the filter #53 refuses: the union of the shards
 * is the whole manifest and CI's gate is all shards green. What these scenarios
 * pin is the machinery that keeps it one - a shard that owns an entry runs it,
 * a shard that owns nothing refuses rather than passing, and half a flag pair
 * is an argument error before anything runs.
 *
 * THE CONTROL comes first: a full run over the two-entry fixture names both
 * entries. Without it, "shard 1 ran only its entry" would pass just as well
 * against a fixture whose second entry never loaded at all.
 */
test('the two-entry fixture really runs two entries unsharded', (t) => {
  withFixture(
    t,
    { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'fail' },
    (result) => {
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Running all 2 manifest entries/);
      assert.match(result.output, new RegExp(`KILLED\\s+${ENTRY_ID}`));
      assert.match(result.output, new RegExp(`KILLED\\s+${SECOND_ENTRY_ID}`));
    },
    undefined,
    undefined,
    { withSecondEntry: true }
  );
});

test('a shard runs its own cell of the partition and nothing else', (t) => {
  // Sorted by id, `another-wiring-fixture` < `wiring-fixture`, so shard 1 of 2
  // owns the second entry and must NOT run the first.
  withFixture(
    t,
    { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'fail' },
    (result) => {
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Shard 1 of 2: running 1 of 2 manifest entries/);
      assert.match(result.output, new RegExp(`KILLED\\s+${SECOND_ENTRY_ID}`));
      assert.doesNotMatch(result.output, new RegExp(`KILLED\\s+${ENTRY_ID}\\b`));
    },
    ['--allow-dirty', '--shard-index=1', '--shard-total=2'],
    undefined,
    { withSecondEntry: true }
  );
});

test('the other shard owns the other entry, so the union is the manifest', (t) => {
  withFixture(
    t,
    { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'fail' },
    (result) => {
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Shard 2 of 2: running 1 of 2 manifest entries/);
      assert.match(result.output, new RegExp(`KILLED\\s+${ENTRY_ID}`));
      assert.doesNotMatch(result.output, new RegExp(`KILLED\\s+${SECOND_ENTRY_ID}`));
    },
    ['--allow-dirty', '--shard-index=2', '--shard-total=2'],
    undefined,
    { withSecondEntry: true }
  );
});

test('a shard that selects nothing refuses rather than passing green', (t) => {
  // An oversized --shard-total quietly deletes coverage otherwise: the empty
  // shard would exit 0 having verified nothing, indistinguishable from a pass.
  withFixture(
    t,
    { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'fail' },
    (result) => {
      assert.equal(result.status, 2, result.output);
      assert.match(result.output, /shard 2 of 2 selects no entries/i);
      assert.doesNotMatch(result.output, /KILLED/);
      assert.doesNotMatch(result.output, /mutations killed/);
    },
    ['--allow-dirty', '--shard-index=2', '--shard-total=2']
  );
});

test('half a shard pair is refused as an argument error, before anything runs', (t) => {
  withFixture(
    t,
    { FAKE_BASELINE: 'pass', FAKE_MUTATED: 'fail' },
    (result) => {
      assert.equal(result.status, 2, result.output);
      assert.match(result.output, /both or neither/);
      assert.doesNotMatch(result.output, /KILLED/);
    },
    ['--shard-index=1']
  );
});
