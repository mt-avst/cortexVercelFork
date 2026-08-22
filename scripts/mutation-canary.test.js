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
const ran = (fullName, status) => ({ fullName, status });
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
    [{ fullName: 'b', status: 'passed' }]
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

  assert.deepEqual(readAssertions(report), [{ fullName: 'the one that ran', status: 'passed' }]);
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

test('the cause is reported for the runner that writes no stderr', async () => {
  const { firstSuiteMessage, mostTellingLine } = await load();

  // VITEST WRITES NOTHING TO STDERR on a suite that fails to load - measured at
  // 0 bytes against jest's 690 - and eleven of the fifteen entries are vitest
  // ones. So the detail line existed for four entries and was blank for the
  // other eleven, which reads as "no information" rather than "not collected".
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
