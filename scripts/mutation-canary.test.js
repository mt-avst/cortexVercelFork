const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * THE CANARY'S OWN CONTROLS.
 *
 * A harness that decides whether other tests can fail is exactly the thing
 * that must be able to fail itself. Its pure functions are unit-tested here so
 * every branch is reachable without starting a test runner - including the
 * branches that are supposed to be unreachable, which is where a wrong verdict
 * would hide.
 *
 * `node --test`, run from the repo root by `npm run test:scripts`, so this
 * runs on the same gate as everything else rather than only when somebody
 * remembers.
 */

const load = () => import('./mutation-canary.mjs');

const MANIFEST = path.join(__dirname, 'mutation-canary.manifest.json');

const entry = (over = {}) => ({
  id: 'an-id',
  why: 'because',
  file: 'backend/src/x.ts',
  anchor: 'a',
  mutation: 'b',
  runner: 'jest',
  spec: 'src/x.test.ts',
  test: 'a test name',
  ...over
});

test('the real manifest is valid', async () => {
  const { validateManifest } = await load();
  const entries = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  assert.deepEqual(validateManifest(entries), []);
  // The control: an empty manifest is the shape that makes this job green by
  // having nothing to check, and it must be rejected rather than passed.
  assert.ok(entries.length > 0);
  assert.equal(validateManifest([]).length, 1);
});

test('validation rejects the shapes that would silently do nothing', async () => {
  const { validateManifest } = await load();

  // A mutation identical to its anchor changes nothing, so the named test
  // passes and the entry reports SURVIVED for ever.
  assert.match(
    validateManifest([entry({ anchor: 'same', mutation: 'same' })]).join(),
    /mutates nothing/
  );

  // Both runners treat `-t` as a regex, so a name containing metacharacters
  // silently becomes a pattern matching something else - or nothing, which
  // reports as TEST_MISSING and sends the reader to look for a test that is
  // right there.
  assert.match(validateManifest([entry({ test: 'refuses (correctly)' })]).join(), /regex/);

  assert.match(validateManifest([entry({ runner: 'mocha' })]).join(), /runner must be/);
  assert.match(
    validateManifest([entry(), entry()]).join(),
    /duplicate id/
  );
  assert.match(validateManifest([entry({ why: '' })]).join(), /why is missing/);

  // A DELETION is a legitimate mutation and the most valuable kind there is -
  // a whole guard, a cleanup, a predicate. Requiring a non-empty replacement
  // would quietly exclude the entire class.
  assert.deepEqual(validateManifest([entry({ mutation: '' })]), []);
});

test('an anchor must match exactly once', async () => {
  const { locateAnchor, anchorVerdict, ANCHOR_MISSING, ANCHOR_AMBIGUOUS } = await load();

  assert.equal(locateAnchor('a b a', 'a'), 2);
  assert.equal(locateAnchor('a b a', 'z'), 0);
  assert.equal(locateAnchor('a b a', 'b'), 1);

  // Overlapping occurrences count as two, which is the safe direction: a
  // refactor that duplicated the line must fail rather than mutate an
  // arbitrary one of them.
  assert.equal(locateAnchor('aaa', 'aa'), 2);

  assert.equal(anchorVerdict(0), ANCHOR_MISSING);
  assert.equal(anchorVerdict(2), ANCHOR_AMBIGUOUS);
  assert.equal(anchorVerdict(1), null);
});

/** One assertion result, as both runners report it. */
const ran = (fullName, status, failure = '') => ({ fullName, status, failure });
const NAMED = 'holds the ceiling at the number that was decided';
const FULL = `results read concurrency ${NAMED}`;

test('the verdict is decided on WHICH test failed, never on a count', async () => {
  const { verdictFor, KILLED, SURVIVED, TEST_MISSING, BASELINE_RED, MUTATION_DID_NOT_BUILD } =
    await load();

  const verdict = (baseline, mutated) =>
    verdictFor({ baselineAssertions: baseline, mutatedAssertions: mutated, testName: NAMED });

  // THE HIGH A REVIEW GATE FOUND, AS A UNIT TEST. `-t` is an unanchored
  // substring match on both runners, so a second test whose name CONTAINS the
  // manifest's name is selected too. The first version credited any failure in
  // the filtered run, so when the named test PASSED under the mutation and its
  // longer-named neighbour failed, the entry reported KILLED having proved
  // nothing - this harness's own subject, inside the harness.
  //
  // SURVIVED is the right answer and not merely a non-zero one: the NAMED test
  // passed under the mutation, so it is decorative, and that is what the
  // reader needs to be told. The neighbour's failure is not evidence about it.
  const neighbour = ran(`${FULL}, checked elsewhere`, 'failed');
  assert.equal(verdict([ran(FULL, 'passed'), neighbour], [ran(FULL, 'passed'), neighbour]), SURVIVED);

  // THE ANTI-ROT GUARD. Renamed or deleted, the build breaks.
  assert.equal(verdict([ran('some other test', 'passed')], []), TEST_MISSING);
  assert.equal(verdict([], []), TEST_MISSING);

  // A test already failing proves nothing by failing again.
  assert.equal(verdict([ran(FULL, 'failed')], [ran(FULL, 'failed')]), BASELINE_RED);

  // A mutation that does not compile fails the build in the right direction,
  // but calling it SURVIVED would tell the reader their test is decorative
  // when the truth is that nothing ran.
  assert.equal(verdict([ran(FULL, 'passed')], []), MUTATION_DID_NOT_BUILD);

  assert.equal(verdict([ran(FULL, 'passed')], [ran(FULL, 'failed')]), KILLED);
  assert.equal(verdict([ran(FULL, 'passed')], [ran(FULL, 'passed')]), SURVIVED);
});

test('the named test is matched on the end of the full name, not anywhere in it', async () => {
  const { selectNamedTest } = await load();

  // `fullName` is the describe chain plus the `it` title, so the manifest's
  // name is a SUFFIX. `includes` would re-admit the substring collision above.
  assert.equal(selectNamedTest([ran(FULL, 'passed')], NAMED).matched.length, 1);
  assert.equal(
    selectNamedTest([ran(`${FULL}, checked elsewhere`, 'passed')], NAMED).matched.length,
    0
  );
  assert.equal(selectNamedTest([ran(FULL, 'passed'), ran('another', 'passed')], NAMED).total, 2);
});

test('only an all-killed run exits zero', async () => {
  const { exitCodeFor, KILLED, SURVIVED, TEST_MISSING } = await load();

  assert.equal(exitCodeFor([{ verdict: KILLED }, { verdict: KILLED }]), 0);
  assert.equal(exitCodeFor([{ verdict: KILLED }, { verdict: SURVIVED }]), 1);
  assert.equal(exitCodeFor([{ verdict: TEST_MISSING }]), 1);

  // AN EMPTY RUN IS A FAILURE. `[].every(...)` is true, so the obvious
  // implementation reports success for a run that checked nothing - which is
  // the exact failure this whole harness exists to catch.
  assert.equal(exitCodeFor([]), 1);
});

test('a database entry with no database is an error, never a skip', async () => {
  const { databaseEntriesWithoutADatabase } = await load();

  const entries = [entry({ id: 'plain' }), entry({ id: 'needs-db', needsDatabase: true })];

  // Named, so the caller can fail saying WHICH. A boolean would let a caller
  // decide to carry on, and a skipped entry reads exactly like a passing one
  // in a green job.
  assert.deepEqual(databaseEntriesWithoutADatabase(entries, {}), ['needs-db']);
  assert.deepEqual(
    databaseEntriesWithoutADatabase(entries, { FIRSTHAND_TEST_DATABASE_URL: 'postgres://x' }),
    []
  );
});

test('an unreadable or empty runner report reads as nothing having run', async () => {
  const { readAssertions, verdictFor, TEST_MISSING } = await load();

  // Anything that could be mistaken for a kill is the wrong direction to fail
  // in, so a report this cannot understand yields no assertions at all.
  assert.deepEqual(readAssertions({}), []);
  assert.deepEqual(readAssertions(null), []);
  assert.deepEqual(readAssertions({ testResults: 'not an array' }), []);
  assert.deepEqual(readAssertions({ testResults: [{ assertionResults: null }] }), []);

  // A filtered-out test is not evidence of anything, and counting it would
  // make every entry look ambiguous.
  assert.deepEqual(
    readAssertions({
      testResults: [
        { assertionResults: [{ fullName: 'a', status: 'pending' }, { fullName: 'b', status: 'passed' }] }
      ]
    }),
    [{ fullName: 'b', status: 'passed', failure: '' }]
  );

  assert.equal(
    verdictFor({ baselineAssertions: readAssertions({}), mutatedAssertions: [], testName: 'x' }),
    TEST_MISSING
  );
});

test('ambiguity is about the match, not how many tests the filter selected', async () => {
  const { verdictFor, KILLED, TEST_AMBIGUOUS } = await load();

  const verdict = (baseline, mutated) =>
    verdictFor({ baselineAssertions: baseline, mutatedAssertions: mutated, testName: NAMED });

  // A NEIGHBOUR THAT DOES NOT ANSWER TO THE NAME MUST NOT BLOCK THE MERGE.
  // This was gated on the size of the filtered run first, and a gate showed it
  // failing red on innocent input: an always-passing `...that was decided, and
  // is documented` beside a pinning test reported TEST_AMBIGUOUS when KILLED
  // was available and correct. Four of the seventy-six backend spec files
  // already hold a title that is a strict superstring of another in the same
  // file, and every `it.each` is structurally in that position.
  const neighbour = (status) => ran(`${FULL}, and is documented`, status);
  assert.equal(
    verdict([ran(FULL, 'passed'), neighbour('passed')], [ran(FULL, 'failed'), neighbour('passed')]),
    KILLED
  );

  // And the genuinely ambiguous case still refuses: TWO assertions ending with
  // the name, so a failure cannot be attributed to either.
  const twin = (status) => ran(`elsewhere ${NAMED}`, status);
  assert.equal(
    verdict([ran(FULL, 'passed'), twin('passed')], [ran(FULL, 'failed'), twin('passed')]),
    TEST_AMBIGUOUS
  );
});

test('a mutation carrying $ tokens is spliced literally', async () => {
  const { applyMutation } = await load();

  // `String.prototype.replace` substitutes `$$`, `$&`, backtick-$ and `$'` in
  // the REPLACEMENT even for a plain-string pattern, so the mutation would
  // splice the matched text and the surrounding source back into the file.
  // This manifest is full of SQL, where `$$` is Postgres dollar-quoting and
  // `$1` is a bind parameter, so this is a live shape rather than a curiosity.
  const spliced = applyMutation('before MARK after', 'MARK', "$& $$ $' $` $1");

  assert.equal(spliced, "before $& $$ $' $` $1 after");
  // The control: the naive form really does corrupt it, so this test is not
  // asserting something that was never at risk.
  assert.notEqual('before MARK after'.replace('MARK', "$& $$ $' $` $1"), spliced);
});

test('git failing at all is a refusal, not a clean tree', async () => {
  const { porcelainFrom, Refusal } = await load();

  // FAILS CLOSED. Returning `(stdout ?? '').trim()` gave '' when git could not
  // run, so the dirty check and the did-it-restore check both silently
  // reported clean - and the CI image has no git, so both guards were inert in
  // the one place a run is unattended.
  // `status: null` is what real `spawnSync` reports alongside `error` on
  // ENOENT - measured. The fixture omitted it, so `undefined !== 0` carried
  // the throw on its own and deleting the `run.error` arm survived: the one
  // test in this file that named an arm it could not see.
  assert.throws(() => porcelainFrom({ status: null, error: new Error('spawnSync git ENOENT') }), {
    name: 'Refusal',
    message: /ENOENT/
  });
  assert.throws(() => porcelainFrom({ status: 128, stderr: 'fatal: dubious ownership' }), Refusal);
  // The control for the arm above: without `run.error` this one still refuses,
  // so the two arms are separately load-bearing.
  assert.throws(() => porcelainFrom({ status: null, stderr: '' }), Refusal);

  // stderr is carried into the message, because a refusal that does not name
  // itself sends the reader to the wrong place - and `fatal: detected dubious
  // ownership` is the likeliest non-ENOENT cause in an unattended job.
  assert.throws(() => porcelainFrom({ status: 128, stderr: 'fatal: dubious ownership' }), {
    message: /dubious ownership/
  });

  // And a working git still returns its output.
  assert.equal(porcelainFrom({ status: 0, stdout: ' M a.ts\n' }), 'M a.ts');
  assert.equal(porcelainFrom({ status: 0, stdout: '' }), '');
});

test('an empty SESSION_SECRET is replaced, not kept', async () => {
  const { sessionSecretFor, CANARY_SESSION_SECRET } = await load();

  // `??` would keep '', and this repository deliberately sets environment
  // variables to '' in .test-base. An empty secret fails the >=32-character
  // check exactly as an absent one does, and four backend suites then fail to
  // LOAD while the runner still reports a pass.
  assert.equal(sessionSecretFor({}), CANARY_SESSION_SECRET);
  assert.equal(sessionSecretFor({ SESSION_SECRET: '' }), CANARY_SESSION_SECRET);
  assert.ok(CANARY_SESSION_SECRET.length >= 32);

  // The control: a real one is passed through untouched.
  assert.equal(sessionSecretFor({ SESSION_SECRET: 'x'.repeat(48) }), 'x'.repeat(48));
});

test('the reported detail names the failure rather than the footer', async () => {
  const { mostTellingLine } = await load();

  // On MUTATION_DID_NOT_BUILD the reader was handed jest's `Time: 1.337 s`
  // while `Test suite failed to run` sat at line two of the same stderr.
  assert.match(
    mostTellingLine('FAIL src/x.test.ts\n  Test suite failed to run\n\nTime: 1.337 s\n'),
    /failed to run/
  );

  // The tail stays the default when nothing looks like a cause.
  assert.equal(mostTellingLine('a\nb\nc\nd'), 'b c d');
  assert.equal(mostTellingLine(''), '');
  assert.equal(mostTellingLine(undefined), '');
});

test('a filtered-out test is dropped whichever word the runner uses for it', async () => {
  const { readAssertions } = await load();

  // jest says `pending`, vitest says `skipped`, both say `todo`. Counting any
  // of them would make an entry look ambiguous for a test that did not run.
  const report = {
    testResults: [
      {
        assertionResults: [
          { fullName: 'jest filtered', status: 'pending' },
          { fullName: 'vitest filtered', status: 'skipped' },
          { fullName: 'either', status: 'todo' },
          { fullName: 'the one that ran', status: 'passed' }
        ]
      }
    ]
  };

  // `failure: ''` rather than absent: a passing assertion carries no failure
  // text, and the malformed-mutation check must see an empty string rather
  // than `undefined` so it cannot accidentally match on a missing key.
  assert.deepEqual(readAssertions(report), [
    { fullName: 'the one that ran', status: 'passed', failure: '' }
  ]);
});

test('two tests answering to the name under mutation cannot be graded either', async () => {
  const { verdictFor, KILLED, TEST_AMBIGUOUS } = await load();

  const verdict = (baseline, mutated) =>
    verdictFor({ baselineAssertions: baseline, mutatedAssertions: mutated, testName: NAMED });

  // ROUND ONE'S DEFECT, HALF CLOSED. The ambiguity guard was applied to the
  // baseline only, and the mutated side then took `matched[0]` POSITIONALLY -
  // so with two matches the verdict was decided by the runner's report order.
  // A gate got exit 0 and `1/1 mutations killed` out of a named test asserting
  // `expect(true).toBe(true)`, with the failure belonging to its neighbour.
  //
  // Reachable when a suffix-matching test is SKIPPED at baseline and runs
  // under the mutation: a runtime-conditional skip, or an `it.each` table
  // sized from the constant being mutated.
  const twin = (status) => ran(`elsewhere ${NAMED}`, status);

  assert.equal(verdict([ran(FULL, 'passed')], [twin('failed'), ran(FULL, 'passed')]), TEST_AMBIGUOUS);
  // Order must not decide it, which is the whole point.
  assert.equal(verdict([ran(FULL, 'passed')], [ran(FULL, 'passed'), twin('failed')]), TEST_AMBIGUOUS);

  // The control: one match under mutation still grades normally.
  assert.equal(verdict([ran(FULL, 'passed')], [ran(FULL, 'failed')]), KILLED);
});

/**
 * THE FALSE KILL THIS HARNESS SHIPPED, and the control that proves the fix is
 * not simply refusing everything.
 *
 * An entry in this repository's own manifest dropped `ss.study_id = $3` from a
 * CTE. `$3` was referenced only there, so the mutated query orphaned its bind
 * parameter and Postgres answered 42P18 at RUNTIME. The suite loaded, the named
 * test went red, and the harness said KILLED - for an entry that never
 * evaluated the property it named. Found by a review gate, not by this file.
 */
test('a mutation that broke the statement is not counted as a kill', async () => {
  const { verdictFor, MUTATION_IS_MALFORMED } = await load();

  assert.equal(
    verdictFor({
      baselineAssertions: [ran(FULL, 'passed')],
      mutatedAssertions: [
        ran(FULL, 'failed', 'error: could not determine data type of parameter $3')
      ],
      testName: NAMED
    }),
    MUTATION_IS_MALFORMED
  );
});

test('an ordinary assertion failure is still a kill', async () => {
  const { verdictFor, KILLED } = await load();

  // THE CONTROL. Without it the test above passes just as well against a
  // predicate that returns true for everything, which would report every entry
  // in the manifest as malformed and turn the whole canary off.
  assert.equal(
    verdictFor({
      baselineAssertions: [ran(FULL, 'passed')],
      mutatedAssertions: [
        ran(FULL, 'failed', 'AssertionError: expected null to equal "study_other"')
      ],
      testName: NAMED
    }),
    KILLED
  );
});

test('a mutated run with no failure text at all is still a kill', async () => {
  const { verdictFor, KILLED } = await load();

  // The runners are not required to give us `failureMessages`, and an absent
  // one must not be read as evidence of anything. Fails OPEN to KILLED, which
  // is the pre-existing behaviour: this check only ever DEMOTES a verdict on
  // positive evidence.
  assert.equal(
    verdictFor({
      baselineAssertions: [ran(FULL, 'passed')],
      mutatedAssertions: [{ fullName: FULL, status: 'failed' }],
      testName: NAMED
    }),
    KILLED
  );
});

test('the malformed-mutation signatures are matched, and ordinary ones are not', async () => {
  const { mutationIsMalformed } = await load();

  for (const failure of [
    'error: could not determine data type of parameter $3',
    'syntax error at or near ")"',
    'bind message supplies 4 parameters, but prepared statement requires 5',
    'ERROR: COULD NOT DETERMINE DATA TYPE OF PARAMETER $1'
  ]) {
    assert.equal(mutationIsMalformed(failure), true, failure);
  }

  for (const failure of [
    'AssertionError: expected 2 to equal 1',
    'expected "study_other" to be null',
    // A TEST'S OWN POLL EXPIRING IS A REAL DETECTION and must stay a kill.
    // This is the message `results-read-close-listener-is-registered-before-
    // the-wait` fails with, and demoting it would switch off the entry that
    // pins the worst defect this middleware has had.
    'Timed out waiting for: the abandoned waiter to leave the queue',
    '',
    undefined
  ]) {
    assert.equal(mutationIsMalformed(failure), false, String(failure));
  }
});

/**
 * THE RUNNER GIVING UP IS THE SAME CATEGORY as a broken statement: the property
 * was never evaluated. A second false kill of this shape shipped in the
 * manifest - widening a retry budget pushed the backoff past vitest's test
 * budget, so the named test died before reaching the literal it pinned.
 *
 * VITEST DISCARDS ITS OWN WORDING, which is the part that is easy to get wrong.
 * `failureMessages` carries `Error: STACK_TRACE_ERROR`, a stack carrier
 * @vitest/runner constructs; the readable "Test timed out in 5000ms" is
 * substituted at print time and never appears in the JSON. Matching only the
 * readable wordings would have left this entire class invisible on the runner
 * that most of the manifest uses.
 */
test('a runner timeout is not counted as a kill, but a test-owned poll still is', async () => {
  const { mutationIsMalformed } = await load();

  for (const failure of [
    'Error: STACK_TRACE_ERROR\n    at task (@vitest/runner/dist/chunk-hooks.js:638)',
    'Error: thrown: "Exceeded timeout of 300 ms for a test.',
    'Test timed out in 5000ms'
  ]) {
    assert.equal(mutationIsMalformed(failure), true, failure);
  }

  // THE CONTROL, and it is the whole reason this signature is narrow. A test
  // that polls and reports its own expiry by name HAS detected the mutation.
  // Widening the pattern to `/timed out/i` would swallow it and silently
  // disarm a real entry.
  assert.equal(
    mutationIsMalformed('Timed out waiting for: the abandoned waiter to leave the queue'),
    false
  );
});

test('the failure text survives readAssertions, or the check above sees nothing', async () => {
  const { readAssertions } = await load();

  // The predicate is only as good as the text reaching it. Threading
  // `failureMessages` through is the half of this feature that is easy to drop
  // in a refactor, and dropping it fails OPEN - every verdict silently reverts
  // to KILLED and nothing goes red.
  const [assertion] = readAssertions({
    testResults: [
      {
        assertionResults: [
          {
            fullName: FULL,
            status: 'failed',
            failureMessages: ['error: could not determine data type of parameter $3', 'at foo()']
          }
        ]
      }
    ]
  });

  assert.match(assertion.failure, /could not determine data type/);
});

test('the cause is reported for the runner that writes no stderr', async () => {
  const { firstSuiteMessage, mostTellingLine } = await load();

  // VITEST WRITES NOTHING TO STDERR on a suite that fails to load - measured at
  // 0 bytes against jest's 690 - and most of the manifest is vitest entries. So
  // the detail line existed for the jest ones and was blank for all the rest,
  // which reads as "no information" rather than as "not collected".
  const vitestReport = {
    testResults: [
      {
        message:
          'Transform failed with 1 error:\n' +
          '/repo/backend/src/x.ts:88:17: ERROR: Expected identifier but found "{"',
        assertionResults: []
      }
    ]
  };
  assert.match(firstSuiteMessage(vitestReport), /ERROR: Expected identifier/);

  // jest's shape too. The CAUSE wins over the HEADER: `Test suite failed to
  // run` says only that something did, and the line under it says what.
  assert.match(
    firstSuiteMessage({ testResults: [{ message: '  ● Test suite failed to run\n\n  SyntaxError: x' }] }),
    /SyntaxError: x/
  );
  // The header is still the answer when nothing more specific is there.
  assert.match(
    firstSuiteMessage({ testResults: [{ message: 'FAIL x\n  Test suite failed to run\n\nTime: 1s' }] }),
    /failed to run/
  );
  assert.equal(firstSuiteMessage({}), '');
  assert.equal(firstSuiteMessage(null), '');
  assert.equal(firstSuiteMessage({ testResults: [{ message: '' }] }), '');

  // The blank-line filter, which had no control: without it the tail is three
  // empty lines and the reader gets nothing.
  assert.equal(mostTellingLine('a\n\n\n\nb'), 'a b');
});

/**
 * THE TWO WAYS THE HARNESS ITSELF MANUFACTURES A VERDICT. cto/AdaptaLabs#50.
 *
 * `SURVIVED` is emitted on one fact: the named test PASSED while the mutation
 * was supposed to be in the file. Everything upstream of that fact was
 * unchecked - whether the runner reached the end at all, and whether the
 * mutation was still on disk when it stopped - so both failures arrived as a
 * verdict about somebody's test rather than as a verdict about this harness.
 */
test('a runner that never finished is not graded', async () => {
  const { verdictFor, runnerFinished, RUNNER_DID_NOT_FINISH, KILLED, RUNNER_TIMEOUT_MS } =
    await load();

  const ran = (status) => [{ fullName: 'x a test name', status, failure: '' }];

  // Killed at the ceiling, or never spawned: `spawnSync` writes no report, and
  // no report is an empty assertion list. Ungated, an unfinished BASELINE reads
  // as TEST_MISSING - the manifest naming a test that is right there.
  assert.equal(
    verdictFor({
      baselineAssertions: [],
      mutatedAssertions: [],
      testName: 'a test name',
      baselineFinished: false
    }),
    RUNNER_DID_NOT_FINISH
  );

  // And an unfinished MUTATED run read as MUTATION_DID_NOT_BUILD, sending the
  // reader to look for a syntax error in a mutation that is fine.
  assert.equal(
    verdictFor({
      baselineAssertions: ran('passed'),
      mutatedAssertions: [],
      testName: 'a test name',
      mutatedFinished: false
    }),
    RUNNER_DID_NOT_FINISH
  );

  // THE CONTROL. The same inputs with both runs finishing still grade normally,
  // so a guard wired to fire always would fail here rather than pass silently.
  assert.equal(
    verdictFor({
      baselineAssertions: ran('passed'),
      mutatedAssertions: ran('failed'),
      testName: 'a test name'
    }),
    KILLED
  );

  // The three shapes `spawnSync` reports a disaster in, and the one it does not.
  assert.equal(runnerFinished({ status: 1 }), true);
  assert.equal(runnerFinished({ error: new Error('spawnSync npx ETIMEDOUT') }), false);
  assert.equal(runnerFinished({ error: new Error('spawnSync npx ENOENT') }), false);
  assert.equal(runnerFinished({ signal: 'SIGKILL' }), false);

  // PINNED AS A LITERAL, not derived from the constant, because a test that
  // reads the constant cannot see the constant change. Five minutes is roughly
  // forty times the slowest entry measured on a loaded developer machine, and
  // the run now prints that margin for whatever machine it is on -
  // cto/AdaptaLabs#61. Moving this number is a deliberate act, which is the
  // whole point of writing it out here.
  assert.equal(RUNNER_TIMEOUT_MS, 300000);
});

test('a mutation that was gone from disk is not a survivor', async () => {
  const { verdictFor, MUTATION_WAS_LOST, SURVIVED, KILLED } = await load();

  const ran = (status) => [{ fullName: 'x a test name', status, failure: '' }];

  // The exact inputs that report SURVIVED - the named test passed under
  // mutation - with the one extra fact that the mutation was not in the file
  // the runner read. A pass then says nothing about the test.
  assert.equal(
    verdictFor({
      baselineAssertions: ran('passed'),
      mutatedAssertions: ran('passed'),
      testName: 'a test name',
      mutationHeld: false
    }),
    MUTATION_WAS_LOST
  );

  // A KILL is worth no more than a survivor once the mutation is gone: the test
  // went red for some other reason entirely, which is the false-KILLED family
  // MUTATION_IS_MALFORMED already covers from the other side.
  assert.equal(
    verdictFor({
      baselineAssertions: ran('passed'),
      mutatedAssertions: ran('failed'),
      testName: 'a test name',
      mutationHeld: false
    }),
    MUTATION_WAS_LOST
  );

  // THE CONTROLS. Held, the same two inputs grade exactly as before - so this
  // guard cannot be swallowing real verdicts, and SURVIVED is still reachable.
  assert.equal(
    verdictFor({
      baselineAssertions: ran('passed'),
      mutatedAssertions: ran('passed'),
      testName: 'a test name',
      mutationHeld: true
    }),
    SURVIVED
  );
  assert.equal(
    verdictFor({
      baselineAssertions: ran('passed'),
      mutatedAssertions: ran('failed'),
      testName: 'a test name',
      mutationHeld: true
    }),
    KILLED
  );

  // A BASELINE problem still outranks it. The mutation being lost is only
  // interesting once the named test was known to exist and pass, and reporting
  // it over TEST_MISSING would send the reader to the wrong file.
  assert.equal(
    verdictFor({
      baselineAssertions: [],
      mutatedAssertions: ran('passed'),
      testName: 'a test name',
      mutationHeld: false
    }),
    'TEST_MISSING'
  );
});

test('only KILLED still exits zero once the new verdicts exist', async () => {
  const { exitCodeFor, KILLED, RUNNER_DID_NOT_FINISH, MUTATION_WAS_LOST } = await load();

  // Both are harness failures rather than coverage failures, and both must
  // block: a verdict nobody has to act on is a verdict nobody reads.
  assert.equal(exitCodeFor([{ verdict: KILLED }, { verdict: RUNNER_DID_NOT_FINISH }]), 1);
  assert.equal(exitCodeFor([{ verdict: KILLED }, { verdict: MUTATION_WAS_LOST }]), 1);
});

test('an unrecognised argument is not silently ignored', async () => {
  const { unrecognisedArgs, ACCEPTED_ARGS } = await load();

  // THE ACCEPTED SET, PINNED AS A LITERAL. Deriving the expectation from
  // ACCEPTED_ARGS would make this assertion true of any set at all, including
  // an empty one - which would refuse every run - and of a set that had grown a
  // filter flag, which cto/AdaptaLabs#53 says deliberately must not exist.
  assert.deepEqual([...ACCEPTED_ARGS], ['--allow-dirty']);

  // THE CONTROL. A parser that refused everything would satisfy every
  // assertion below just as well as a correct one.
  assert.deepEqual(unrecognisedArgs([]), []);
  assert.deepEqual(unrecognisedArgs(['--allow-dirty']), []);

  // The argument the gate on !263 actually typed, which ran all 119 entries and
  // exited 0.
  assert.deepEqual(unrecognisedArgs(['--id', 'some-entry']), ['--id', 'some-entry']);

  // A typo in a real flag, which used to drop the permission silently and then
  // fail on the dirty tree instead.
  assert.deepEqual(unrecognisedArgs(['--allow-dirty=yes']), ['--allow-dirty=yes']);
  assert.deepEqual(unrecognisedArgs(['--alow-dirty']), ['--alow-dirty']);

  // Recognised and unrecognised together: only the unrecognised one is named,
  // so the message points at the argument to fix.
  assert.deepEqual(unrecognisedArgs(['--allow-dirty', '--only', 'x']), ['--only', 'x']);
});

test('the database going away under the test is not a kill', async () => {
  const { verdictFor, environmentFailed, ENVIRONMENT_FAILED, KILLED, MUTATION_IS_MALFORMED } =
    await load();

  const passingBaseline = [{ fullName: 'x a test name', status: 'passed', failure: '' }];
  const failedWith = (failure) => [{ fullName: 'x a test name', status: 'failed', failure }];

  // The four shapes measured on cto/AdaptaLabs#58, every one of which
  // `mutationIsMalformed` returns false for and the harness therefore graded
  // KILLED, exit 0.
  for (const failure of [
    'Error: Connection terminated unexpectedly',
    'error: too many clients already',
    'error: terminating connection due to administrator command',
    'Error: connect ECONNREFUSED 127.0.0.1:5432'
  ]) {
    assert.equal(environmentFailed(failure), true, failure);
    assert.equal(
      verdictFor({
        baselineAssertions: passingBaseline,
        mutatedAssertions: failedWith(failure),
        testName: 'a test name',
        needsDatabase: true
      }),
      ENVIRONMENT_FAILED,
      failure
    );
  }

  // THE CONTROL THAT MATTERS MOST. An ordinary assertion failure on the very
  // same database entry is still a kill, so this is not a guard that has
  // disarmed the harness.
  assert.equal(
    verdictFor({
      baselineAssertions: passingBaseline,
      mutatedAssertions: failedWith('AssertionError: expected 1 to be 2'),
      testName: 'a test name',
      needsDatabase: true
    }),
    KILLED
  );

  // THE SECOND CONTROL, and the reason the check is gated on needsDatabase at
  // all. Three suites in this repository inject a connection error ON PURPOSE
  // and assert the response body does not leak it - admin.dashboard-and-request
  // -read-live-role, health-endpoint and opportunities.test.ts. All three run
  // against a MOCKED pool, so a mutation breaking that redaction produces a
  // failure quoting the connection error, and ungated this check would grade
  // that genuine kill as an environmental failure.
  assert.equal(
    verdictFor({
      baselineAssertions: passingBaseline,
      mutatedAssertions: failedWith(
        'expected body not to contain "connect ECONNREFUSED cortex-db.internal:5432"'
      ),
      testName: 'a test name',
      needsDatabase: false
    }),
    KILLED
  );

  // A STATEMENT THE MUTATION BROKE is still MUTATION_IS_MALFORMED on a database
  // entry, so the new check has not displaced the one before it.
  assert.equal(
    verdictFor({
      baselineAssertions: passingBaseline,
      mutatedAssertions: failedWith('syntax error at or near "FROM"'),
      testName: 'a test name',
      needsDatabase: true
    }),
    MUTATION_IS_MALFORMED
  );
});

test('a suite that failed before running a test is the environment, not a missing test', async () => {
  const { verdictFor, suiteFailedWithoutRunningATest, ENVIRONMENT_FAILED, TEST_MISSING } =
    await load();

  // MEASURED ON VITEST 3.2.7 against gamification-postgres.test.ts, the two
  // shapes minutes apart. There is no TEXT to tell them apart: stderr was 0
  // bytes and `message` empty in both, so the discriminator has to be the
  // suite's own status.
  const noDatabase = {
    testResults: [
      {
        status: 'failed',
        message: '',
        assertionResults: [
          { fullName: 'x a test name', status: 'skipped', failureMessages: [] },
          { fullName: 'x another test', status: 'skipped', failureMessages: [] }
        ]
      }
    ]
  };
  const nameDoesNotMatch = {
    testResults: [
      {
        status: 'passed',
        message: '',
        assertionResults: [
          { fullName: 'x some other test', status: 'skipped', failureMessages: [] }
        ]
      }
    ]
  };

  assert.equal(suiteFailedWithoutRunningATest(noDatabase), true);
  // THE CONTROL. A filter that genuinely selects nothing looks identical in the
  // assertion list, and must stay TEST_MISSING - a guard that fired on both
  // would merely relabel the anti-rot check.
  assert.equal(suiteFailedWithoutRunningATest(nameDoesNotMatch), false);

  // A suite that failed while some OTHER test still ran is not this shape
  // either: the named test is genuinely missing and the manifest is stale.
  assert.equal(
    suiteFailedWithoutRunningATest({
      testResults: [
        {
          status: 'failed',
          message: '',
          assertionResults: [
            { fullName: 'x another test', status: 'failed', failureMessages: ['boom'] }
          ]
        }
      ]
    }),
    false
  );

  assert.equal(
    verdictFor({
      baselineAssertions: [],
      mutatedAssertions: [],
      testName: 'a test name',
      baselineRanNothingAndFailed: true
    }),
    ENVIRONMENT_FAILED
  );
  assert.equal(
    verdictFor({
      baselineAssertions: [],
      mutatedAssertions: [],
      testName: 'a test name',
      baselineRanNothingAndFailed: false
    }),
    TEST_MISSING
  );
});

test('an environmental failure blocks the merge like every other non-kill', async () => {
  const { exitCodeFor, KILLED, ENVIRONMENT_FAILED } = await load();
  assert.equal(exitCodeFor([{ verdict: KILLED }, { verdict: ENVIRONMENT_FAILED }]), 1);
});

test('the run can say which single invocation came closest to the ceiling', async () => {
  const { slowestRun } = await load();

  // ONE INVOCATION, NOT ONE ENTRY. The ceiling is given to each `spawnSync`
  // separately and an entry makes two of them, so summing the pair would
  // overstate how close the ceiling came to firing - the wrong direction for
  // this particular number. cto/AdaptaLabs#61.
  assert.deepEqual(
    slowestRun([
      { id: 'a', phase: 'baseline', ms: 3_100 },
      { id: 'a', phase: 'mutated', ms: 3_400 },
      { id: 'b', phase: 'baseline', ms: 7_260 },
      { id: 'b', phase: 'mutated', ms: 2_000 }
    ]),
    { id: 'b', phase: 'baseline', ms: 7_260 }
  );

  // A run that graded nothing has no slowest invocation, and must not divide by
  // zero on the way to saying so.
  assert.deepEqual(slowestRun([]), { id: 'nothing ran', phase: '-', ms: 0 });

  // THE CONTROL. A reducer that always returned its seed would satisfy the
  // empty case above just as well.
  assert.equal(slowestRun([{ id: 'only', phase: 'mutated', ms: 1 }]).id, 'only');
});

/**
 * THE PROJECT A SPEC RUNS IN.
 *
 * `runNamedTest` hardcoded `REPO_ROOT/backend` as its cwd, which made the
 * whole frontend unreachable: every one of the 197 entries was backend or
 * shared, and that read as a coverage gap when half of it was a structural
 * boundary. `project` lifts the boundary. It is optional and defaults to
 * `backend`, so no existing entry changes meaning.
 */
test('projectDirFor defaults to backend and honours an explicit project', async () => {
  const { projectDirFor } = await load();

  // The default is the load-bearing half: 197 entries omit the field and must
  // keep running exactly where they ran before.
  assert.equal(projectDirFor(entry()), 'backend');
  assert.equal(projectDirFor(entry({ project: 'backend' })), 'backend');
  assert.equal(projectDirFor(entry({ project: 'frontend' })), 'frontend');
  // The fallback, which nothing distinguished from a trusting `?? 'backend'`
  // until these two lines: it is a path segment handed to path.join, so the
  // sink must not trust a value validation would have refused.
  assert.equal(projectDirFor(entry({ project: 'shared' })), 'backend');
  assert.equal(projectDirFor(entry({ project: '../../etc' })), 'backend');
});

test('validation refuses a project this repo does not have', async () => {
  const { validateManifest } = await load();

  assert.match(
    validateManifest([entry({ project: 'shared' })]).join(),
    /project must be one of/
  );
  assert.match(
    validateManifest([entry({ project: '' })]).join(),
    /project must be one of/
  );
  // The control: the two real projects, and an absent field, all pass - or the
  // assertions above would be satisfied by a rule that rejects everything.
  assert.deepEqual(validateManifest([entry({ project: 'backend' })]), []);
  // vitest, because the default runner in `entry()` is jest and a frontend
  // entry may not name jest - see the runner-pairing test below.
  assert.deepEqual(validateManifest([entry({ project: 'frontend', runner: 'vitest' })]), []);
  assert.deepEqual(validateManifest([entry()]), []);
});

test('validation refuses a frontend entry that claims to need a database', async () => {
  const { validateManifest } = await load();

  // Nothing in frontend/ reaches Postgres, so this combination is a mistake
  // rather than a configuration. It matters because `needsDatabase` suppresses
  // a red into ENVIRONMENT_FAILED: an entry that wrongly claims it would
  // convert its own genuine failure into a shrug.
  assert.match(
    validateManifest([
      entry({ project: 'frontend', runner: 'vitest', needsDatabase: true })
    ]).join(),
    /frontend entry cannot need a database/
  );
  // The controls: the same claim is fine on the backend, and a frontend entry
  // that makes no such claim is fine too.
  assert.deepEqual(validateManifest([entry({ project: 'backend', needsDatabase: true })]), []);
  assert.deepEqual(
    validateManifest([entry({ project: 'frontend', runner: 'vitest', needsDatabase: false })]),
    []
  );
});

/**
 * A FRONTEND ENTRY IS NOT RUNNABLE UNTIL CI CAN RUN IT.
 *
 * `project: 'frontend'` makes the runner able to spawn in `frontend/`. It does
 * not make the JOB able to: the canary installs root and `backend` deps only,
 * and its path gate excludes `frontend/**`, so a frontend entry would reach
 * an `npx vitest` with no node_modules, and a frontend-only MR would skip the
 * whole job while changing the very file the entry mutates.
 *
 * That second half is the one ADR-0004 forbids by name - a run that is
 * structurally blind to a diff it should have caught. Both halves are deferred
 * DELIBERATELY, because paying for them buys nothing while no frontend entry
 * exists, and this test is what stops the deferral from being forgotten: add
 * the first frontend entry and it fails by name until CI is fixed with it.
 */
test('.gitlab-ci.yml parses strictly, with no duplicated mapping keys', async () => {
  // Its own test, because the guard below ALSO parses this file and would
  // otherwise report a duplicate key under a name about frontend deps, sending
  // the reader to the wrong subject entirely. js-yaml 4 throws on a duplicate;
  // 3 does not, which is why the version is pinned in devDependencies.
  const yaml = require('js-yaml');
  const raw = fs.readFileSync(path.join(__dirname, '..', '.gitlab-ci.yml'), 'utf8');

  assert.doesNotThrow(() => yaml.load(raw), 'the pipeline config does not parse strictly');
  // The control: the parser really does refuse a duplicate, so a green above is
  // evidence about the file rather than about a lenient parser.
  assert.throws(() => yaml.load('a:\n  k: 1\n  k: 2\n'), /duplicated mapping key/);
});

test('validation refuses a frontend entry that names the jest runner', async () => {
  const { validateManifest } = await load();

  // frontend/ has no jest installed. A bare `npx jest` there DOWNLOADS a
  // different jest major from the registry mid-run instead of failing, and the
  // resulting mess reports as MUTATION_DID_NOT_BUILD - a harness fault blamed
  // for a manifest fault.
  assert.match(
    validateManifest([entry({ project: 'frontend', runner: 'jest' })]).join(),
    /frontend entry cannot use the jest runner/
  );
  // The controls: vitest on the frontend is the supported pairing, and jest on
  // the backend is what 156 existing entries already do.
  assert.deepEqual(validateManifest([entry({ project: 'frontend', runner: 'vitest' })]), []);
  assert.deepEqual(validateManifest([entry({ project: 'backend', runner: 'jest' })]), []);
});

test('a frontend entry requires the canary job to install frontend deps and watch frontend paths', async (t) => {
  const yaml = require('js-yaml');
  let ci;
  try {
    ci = yaml.load(fs.readFileSync(path.join(__dirname, '..', '.gitlab-ci.yml'), 'utf8'));
  } catch {
    // SKIP, not a silent return: a bare `return` reports as a pass, and this
    // guard is then disarmed by anything that makes the file unparseable - a
    // duplicate key, or a `!reference` tag, which is ordinary GitLab and which
    // js-yaml refuses. Safe only because the strict-parse test above sits on
    // the same gate and reddens; if that test ever moves, this becomes a hole.
    t.skip('.gitlab-ci.yml does not parse - see the strict-parse test');
    return;
  }
  const job = ci['mutation-canary'];
  assert.ok(job, 'the mutation-canary job is gone, so this guard is asserting nothing');

  // TAKES THE JOB'S SHAPE AS AN ARGUMENT rather than closing over the real one.
  // An earlier version closed over it, which made the control below assert that
  // the REAL job is still unfixed - so the control failed the moment CI was
  // fixed correctly, in every order of operations, and its only obvious remedy
  // was deletion. A tripwire whose fix is to remove it protects nothing.
  const requires = (entries, job) => {
    // Keyed on the FILE as well as the declared project: the path-gate half of
    // this is about which files get mutated, and an entry with a frontend file
    // and no `project` would otherwise slip both limbs.
    const hasFrontend = entries.some(
      (e) => e.project === 'frontend' || e.file.startsWith('frontend/')
    );
    if (!hasFrontend) return [];
    const missing = [];
    if (!job.installs) missing.push('the job does not npm ci in frontend/');
    if (!job.watches) missing.push('the path gate does not include frontend/');
    return missing;
  };

  // THE DETECTOR, lifted out and named so it can have controls of its own.
  // Inline, it was the only code reading the real job's shape and NOTHING
  // exercised it: the real manifest has no frontend entry, so `requires`
  // short-circuits before touching it. Setting both limbs true survived 36/0.
  const detect = (job) => {
    const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    // JOINED, not tested command by command. GitLab runs before_script and
    // script in ONE shell, so a bare `cd frontend` on its own list item still
    // governs a later `npm ci` - and requiring both in a single command
    // rejected the most natural way to write the fix. `script` may also be a
    // plain scalar, which spreading a string would shred into characters.
    // No `.map(String)`: `join` coerces already, so a nested-array command (legal
    // GitLab) flattens on its own - a control below pins that, and an explicit
    // map was an equivalent mutant, which is dead code wearing a guard's coat.
    const script = [...asList(job.before_script), ...asList(job.script)].join('\n');
    // `.find`, not `[0]`: the real job's first rule is `if: $CI_COMMIT_TAG,
    // when: never`, so the `changes` rule is never at index 0 there.
    const paths = job.rules?.find((rule) => rule.changes)?.changes?.paths ?? [];

    return {
      // Must TARGET the frontend, not merely mention it. The real job already
      // runs a root `npm ci` and `cd backend && npm ci`, so a check for an
      // install alone reads true against a job that installs nothing here -
      // measured, it survived every control.
      installs:
        /(cd|--prefix)\s+\S*frontend/.test(script) &&
        /\bnpm\b[^\n]*\b(ci|install)\b/.test(script),
      // A WILDCARD over the whole frontend tree, not merely a path under it.
      // `frontend/package.json` starts with `frontend/` and would still let a
      // change to frontend/src skip the entire canary - the silent direction,
      // and the one ADR-0004 forbids by name.
      watches: paths.some((p) => p.startsWith('frontend/**'))
    };
  };

  // THE DETECTOR'S OWN CONTROLS, against synthetic jobs so they stay valid once
  // the real job is fixed. Each pins one clause in both directions.
  const y = (text) => detect(yaml.load(text));

  // Accepted: the sanctioned forms, including the two-list-item and scalar
  // shapes a person is most likely to write.
  assert.deepEqual(
    y('script:\n  - cd frontend && npm ci\nrules:\n  - changes:\n      paths: ["frontend/**/*"]\n'),
    { installs: true, watches: true }
  );
  assert.equal(
    y('script:\n  - cd frontend\n  - npm ci\n').installs,
    true,
    'two list items run in one shell and are a valid fix'
  );
  assert.equal(y('script: cd frontend && npm ci\n').installs, true, 'a scalar script');
  assert.equal(y('script:\n  - npm --prefix frontend ci\n').installs, true, '--prefix form');
  assert.equal(
    y('script:\n  - [cd frontend, npm ci]\n').installs,
    true,
    'a nested-array command, which is legal GitLab'
  );
  assert.equal(
    y('before_script:\n  - cd frontend && npm ci\n').installs,
    true,
    'before_script is not being scanned'
  );

  // Refused: the shapes that look like a fix and are not.
  assert.equal(
    y('script:\n  - npm ci\n  - cd backend && npm ci\n').installs,
    false,
    'a root npm ci is not a frontend install - this is the REAL job today'
  );
  assert.equal(
    y('script:\n  - echo "the frontend needs no deps here" && npm ci\n').installs,
    false,
    'mentioning the frontend beside a root install is not a fix'
  );
  assert.equal(
    y('script:\n  - cd frontend && echo hi\n').installs,
    false,
    'entering the directory without installing is not a fix'
  );
  assert.equal(
    y('rules:\n  - changes:\n      paths: ["frontend/package.json"]\n').watches,
    false,
    'gating on one frontend file still lets frontend/src skip the job'
  );
  assert.equal(y('rules:\n  - changes:\n      paths: ["frontend/**"]\n').watches, true);
  // Pins `.find`: the changes rule sits behind a `when: never`, as it does in
  // the real job.
  assert.equal(
    y('rules:\n  - if: $CI_COMMIT_TAG\n    when: never\n  - changes:\n      paths: ["frontend/**/*"]\n').watches,
    true,
    'the changes rule is not always first'
  );
  assert.deepEqual(y('before_script:\n  - apk add git\nrules: []\n'), {
    installs: false,
    watches: false
  });

  const real = detect(job);

  const entries = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.deepEqual(
    requires(entries, real),
    [],
    'a frontend entry has been added - fix .gitlab-ci.yml in the same change'
  );

  // THE CONTROLS, against SYNTHETIC unfixed jobs so they stay valid after the
  // real job is fixed. One per limb, because a single "length > 0" is satisfied
  // by whichever detector still works - and the dangerous direction is
  // `watches`: a false positive there ships a frontend entry while a
  // frontend-only MR skips the whole canary, which is silent. A false
  // `installs` is loud by comparison - vitest with no node_modules.
  const frontendEntry = entry({ project: 'frontend' });
  assert.deepEqual(requires([frontendEntry], { installs: false, watches: true }), [
    'the job does not npm ci in frontend/'
  ]);
  assert.deepEqual(requires([frontendEntry], { installs: true, watches: false }), [
    'the path gate does not include frontend/'
  ]);
  // And the file-keyed limb, which no `project` field would catch.
  assert.deepEqual(
    requires([entry({ file: 'frontend/src/App.tsx' })], { installs: false, watches: false }).length,
    2
  );
  // The negative control: a fully fixed job requires nothing, so the assertion
  // above cannot be passing because `requires` always returns a non-empty list.
  assert.deepEqual(requires([frontendEntry], { installs: true, watches: true }), []);
});
