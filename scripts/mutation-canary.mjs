#!/usr/bin/env node
/**
 * THE CURATED MUTATION CANARY.
 *
 * A manifest of load-bearing lines, each paired with the ONE test that must
 * fail when that line changes. This runner applies each mutation, runs the
 * named test, asserts it fails, restores, and reports.
 *
 * WHY IT EXISTS. The most expensive recurring defect in this repository is not
 * wrong code. It is a test that CANNOT FAIL - where the fixture's natural
 * shape already satisfies the property under test, so the assertion is
 * decorative. On !210 alone that happened five times, and the fifth was inside
 * the fix for the fourth. Every one was found by hand, late, by an expensive
 * review gate. None of them is findable by reading:
 *
 *   `continue` -> `break` in the CSV writer      survived 825 jest, 590 vitest
 *   `LIMIT MAX + 1` -> `LIMIT MAX`               survived 824 jest, 602 vitest
 *   opportunity scope collapsed to study-wide    survived 588 tests in CI
 *   batch predicate deleted with its parameter   survived all 26 in its file
 *   `res.write`'s return value ignored           survived 602 vitest
 *
 * Not a full Stryker run. Stryker over this codebase is hours, and hours is a
 * job nobody blocks a merge on. This is a few minutes, so it can block one.
 *
 * WHAT STOPS THE MANIFEST ROTTING - the one design decision, and the reason
 * this comment is longer than the loop below. A list of "lines that must stay
 * load-bearing" is exactly the artefact that goes stale silently, and a stale
 * canary is another green check that proves nothing: the same failure it
 * exists to catch.
 *
 * Five guards, and every one FAILS THE BUILD rather than skipping an entry:
 *
 *  1. THE ANCHOR MUST MATCH EXACTLY ONCE. Not "at least once" - a refactor
 *     duplicating the line would otherwise mutate an arbitrary one of them,
 *     and a refactor deleting it would silently drop the entry. Anchored on a
 *     matched string, never a line number: any edit above a line number moves
 *     the mutation somewhere else without saying so.
 *  2. A TEST WHOSE TITLE ENDS WITH THE NAMED ONE MUST EXIST AND PASS
 *     UNMUTATED. Renaming or deleting it breaks the build, so coverage cannot
 *     be removed quietly. It is also what makes "fails after the mutation"
 *     mean anything - a test already failing proves nothing by failing again.
 *
 *     SAID AS "ENDS WITH" RATHER THAN "IS", because that is what it checks and
 *     an earlier version of this line overclaimed. Deleting `it('X')` and
 *     leaving `it('and it X')` asserting the same thing satisfies this guard -
 *     measured. The verdict stays correct, because the impostor does detect
 *     the mutation, so no coverage is actually lost; what would be lost is the
 *     ability to find the entry by its name. Matching the full describe chain
 *     instead would break on any describe rename, which is a worse trade.
 *  3. NOTHING IS EVER SKIPPED. An entry needing a database with no database
 *     configured is an error naming the entries, not a quiet pass. Skip and
 *     stop are the same result to a reader of a green job.
 *  4. THE TREE MUST BE CLEAN BEFORE AND AFTER. A harness that dies mid-run
 *     leaves a mutation applied, and the next reader inherits a defect wearing
 *     this file's name.
 *  5. A MUTATION THAT BROKE THE STATEMENT IS NOT A KILL. Added last, and added
 *     because this harness reported one: a mutation that orphaned a bind
 *     parameter turned the named test red at RUNTIME without ever evaluating
 *     the property, and every guard above was satisfied. See MALFORMED_MUTATION.
 *
 * RUN IT IN A DEDICATED WORKTREE. Two harnesses backing up and restoring one
 * checkout clobber each other silently.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const MANIFEST = path.join(HERE, 'mutation-canary.manifest.json');

/** Verdicts. Only KILLED is a pass. */
export const KILLED = 'KILLED';
export const SURVIVED = 'SURVIVED';
export const ANCHOR_MISSING = 'ANCHOR_MISSING';
export const ANCHOR_AMBIGUOUS = 'ANCHOR_AMBIGUOUS';
export const TEST_MISSING = 'TEST_MISSING';
export const TEST_AMBIGUOUS = 'TEST_AMBIGUOUS';
export const BASELINE_RED = 'BASELINE_RED';
export const MUTATION_DID_NOT_BUILD = 'MUTATION_DID_NOT_BUILD';
export const MUTATION_IS_MALFORMED = 'MUTATION_IS_MALFORMED';

const RUNNERS = new Set(['jest', 'vitest']);

/**
 * A DELIBERATE REFUSAL, as distinct from this harness falling over.
 *
 * The top-level handler printed `Refusing to run: ${error.message}` for any
 * throw, so a genuine crash - a typo reaching `undefinedHelper is not defined`
 * - was reported as a guard firing, exit 2, with the stack discarded. In a CI
 * log that is indistinguishable from git being absent, and the one thing that
 * would locate the bug is gone.
 */
export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'Refusal';
  }
}

/** The fallback secret. >=32 characters, or four backend suites fail to LOAD. */
export const CANARY_SESSION_SECRET = 'mutation-canary-test-constant-not-a-real-secret';

/**
 * `||`, not `??`, and it is not a style choice.
 *
 * This repository deliberately sets environment variables to '' in
 * `.test-base` - DATABASE_URL and three others - so an empty SESSION_SECRET is
 * a real shape here, and it fails the >=32-character check exactly as an
 * absent one does. `??` would have kept it.
 */
export function sessionSecretFor(env) {
  return env.SESSION_SECRET || CANARY_SESSION_SECRET;
}

/**
 * The mutated source, spliced without giving `$` tokens special meaning.
 *
 * `String.prototype.replace` substitutes `$$`, `$&`, `` $` `` and `$'` in the
 * REPLACEMENT even when the pattern is a plain string, so a mutation
 * containing them would splice the matched text and the surrounding source
 * back into the file. This manifest is full of SQL, where `$$` is Postgres
 * dollar-quoting and `$1` is a bind parameter. A function replacement is
 * literal by definition.
 */
export function applyMutation(source, anchor, mutation) {
  return source.replace(anchor, () => mutation);
}

/**
 * `git status --porcelain`'s output, or a refusal.
 *
 * FAILS CLOSED, and it did not before: returning `(stdout ?? '').trim()` gave
 * '' when git could not run AT ALL, so both the pre-run dirty check and the
 * post-run did-it-restore check silently reported a clean tree. A gate proved
 * it with git off PATH and two visibly modified files on disk - no refusal, no
 * warning.
 *
 * That mattered specifically in CI, where the node alpine image has no git, a
 * fact this repository's CI file already states twice. Both guards were inert
 * in the one place a run is unattended.
 *
 * stderr is carried into the message: `fatal: detected dubious ownership` is
 * the likeliest non-ENOENT cause in an unattended job, and a refusal that does
 * not name itself sends the reader to the wrong place.
 */
export function porcelainFrom(run) {
  if (run.error || run.status !== 0) {
    const why = run.error?.message ?? `exit ${run.status}`;
    const said = (run.stderr ?? '').trim();
    throw new Refusal(
      `git status could not run (${why}${said ? `: ${said}` : ''}), so the clean-tree ` +
        'guards cannot be trusted. This harness edits source files in place; refusing ' +
        'to run without a working git.'
    );
  }

  return (run.stdout ?? '').trim();
}

/**
 * Both runners treat `-t` as a REGULAR EXPRESSION.
 *
 * A test named `refuses (correctly)` would silently become a pattern matching
 * something else, or nothing - and "nothing" reports as TEST_MISSING, sending
 * the next reader to look for a test that is right there. Rejected at
 * validation rather than escaped, because a manifest that cannot express a
 * name is a smaller problem than one that expresses it wrongly.
 */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/;

export function validateManifest(entries) {
  const problems = [];

  if (!Array.isArray(entries) || entries.length === 0) {
    return ['the manifest is empty, which would make this job green by having nothing to check'];
  }

  const seen = new Set();

  entries.forEach((entry, index) => {
    const where = `entry ${index}${entry?.id ? ` (${entry.id})` : ''}`;

    for (const field of ['id', 'why', 'file', 'anchor', 'runner', 'spec', 'test']) {
      if (typeof entry?.[field] !== 'string' || entry[field].length === 0) {
        problems.push(`${where}: ${field} is missing or not a non-empty string`);
      }
    }

    // `mutation` MAY be empty, and that is not an oversight: deleting a line
    // is one of the most valuable mutations there is - the three `res.off`
    // cleanups, a whole guard - and requiring a non-empty replacement would
    // quietly exclude the entire class.
    if (typeof entry?.mutation !== 'string') {
      problems.push(`${where}: mutation is missing or not a string`);
    }

    if (seen.has(entry?.id)) problems.push(`${where}: duplicate id`);
    seen.add(entry?.id);

    if (!RUNNERS.has(entry?.runner)) {
      problems.push(`${where}: runner must be one of ${[...RUNNERS].join(', ')}`);
    }

    // A mutation identical to its anchor changes nothing, so the named test
    // passes, so the entry reports SURVIVED for ever - or worse, somebody
    // "fixes" it by deleting the entry.
    if (entry?.anchor === entry?.mutation) {
      problems.push(`${where}: the mutation is identical to the anchor, so it mutates nothing`);
    }

    if (typeof entry?.test === 'string' && REGEX_METACHARACTERS.test(entry.test)) {
      problems.push(
        `${where}: the test name contains a regex metacharacter, and both runners treat -t as a regex`
      );
    }
  });

  return problems;
}

/**
 * The anchor's occurrence count, over the WHOLE file.
 */
export function locateAnchor(source, anchor) {
  let count = 0;
  let at = source.indexOf(anchor);
  while (at !== -1) {
    count += 1;
    at = source.indexOf(anchor, at + 1);
  }
  return count;
}

export function anchorVerdict(count) {
  if (count === 0) return ANCHOR_MISSING;
  if (count > 1) return ANCHOR_AMBIGUOUS;
  return null;
}

/**
 * A MUTATION THE TEST NEVER GOT TO JUDGE, as distinct from one it caught.
 *
 * The false kill this closes was shipped in this repository's own manifest and
 * found by a review gate. An entry dropped `ss.study_id = $3` from a CTE to
 * prove the scope predicate was load-bearing - but `$3` was referenced ONLY
 * there, so the mutated query orphaned its bind parameter and Postgres answered
 * `42P18 could not determine data type of parameter $3` at RUNTIME. The named
 * test went red, the suite had loaded fine, and the harness reported KILLED.
 *
 * The entry proved nothing: any edit dropping `$3` kills that test, including
 * edits that leave the scope perfectly intact. A green canary asserting a
 * property it never evaluated is precisely this harness's own subject.
 *
 * MUTATION_DID_NOT_BUILD cannot see it - that fires when the suite fails to
 * LOAD, and this suite loaded. So the mutated run's failure text is checked for
 * the signatures that mean "this statement is not a statement" rather than "the
 * assertion disagreed".
 *
 * NOT THE WHOLE CLASS, and saying so because this docblock would otherwise
 * read as though it were. A mutation that breaks a FIXTURE is the same family
 * and is not caught: a `beforeEach` that throws surfaces as an ordinary error
 * on both runners, so the named test goes red without the property ever being
 * evaluated and the verdict is KILLED. Probed on both runners; no entry in the
 * manifest exhibits it today, and catching it needs more than a text signature.
 * What is closed is the two shapes that had actually shipped here.
 *
 * DELIBERATELY LOUD RATHER THAN CLEVER. If this ever fires on a mutation that
 * was genuinely caught - a test asserting on one of these strings, say - the
 * job goes red naming the entry, and somebody rewrites the mutation to be
 * type-valid. That is a visible, fixable, five-minute annoyance. A silent false
 * kill is a canary entry that lies for as long as it exists.
 */
const MALFORMED_MUTATION = new RegExp(
  [
    // Postgres could not type a bind parameter the mutation orphaned.
    'could not determine data type of parameter',
    // The mutation left the statement unparseable.
    'syntax error at or near',
    // The mutation changed the placeholder count without changing the values.
    'bind message supplies \\d+ parameters',
    // THE RUNNER GAVE UP, which is the same category: the property was never
    // evaluated. A second false kill of exactly this shape was shipped in this
    // manifest - widening a retry budget from 3 to 6 pushed the backoff past
    // vitest's 5s test budget, so the named test died before reaching the
    // literal it was pinning, and any change merely making that path slower
    // killed the entry equally.
    'Exceeded timeout of \\d+\\s*ms for a test',
    'Test timed out in \\d+\\s*ms',
    // VITEST DISCARDS ITS OWN TIMEOUT WORDING. `failureMessages` carries
    // `Error: STACK_TRACE_ERROR` - a stack carrier @vitest/runner constructs -
    // and the human-readable "Test timed out in 5000ms" is substituted only at
    // print time, so neither wording above matches a real vitest report. A gate
    // tested this signature against all forty-two mutated reports: it matched
    // the one entry that was genuinely timing out and nothing else. It also
    // does NOT match a test's own poll expiring, such as
    // `Timed out waiting for: the abandoned waiter to leave the queue`, which
    // is a real detection and must stay a kill.
    'STACK_TRACE_ERROR'
  ].join('|'),
  'i'
);

export function mutationIsMalformed(failure) {
  return MALFORMED_MUTATION.test(String(failure ?? ''));
}

/**
 * The verdict, from the two runs.
 *
 * Pure, so its own unit tests can reach every branch without starting a test
 * runner - including the branches that are meant to be unreachable.
 *
 * ORDERED DELIBERATELY, because these failures send the reader to different
 * files and conflating them wastes the trip: a manifest naming a test that no
 * longer exists is not a broken test, a broken test is not an uncovered line,
 * and a mutation that does not compile is not a decorative assertion.
 */
export function verdictFor({ baselineAssertions, mutatedAssertions, testName }) {
  const baseline = selectNamedTest(baselineAssertions, testName);

  // THE ANTI-ROT GUARD: renamed or deleted, the build breaks.
  if (baseline.matched.length === 0) return TEST_MISSING;

  // MORE THAN ONE TEST ANSWERS TO THE NAME, so a failure cannot be attributed
  // to it. Gated on the MATCH rather than on how many tests `-t` selected -
  // and it was gated on the run size first, which a gate showed fails red on
  // innocent input: adding an always-passing `...that was decided, and is
  // documented` beside a pinning test blocked the merge with TEST_AMBIGUOUS
  // when KILLED was available and correct. Four of the seventy-six backend
  // spec files already hold a title that is a strict superstring of another
  // in the same file, and every `it.each` is structurally in this position.
  //
  // Refusing to grade the ambiguous case is right; refusing to grade an
  // unambiguous one because a neighbour happened to be selected is the same
  // shape as the defect this replaced, failing red instead of green.
  if (baseline.matched.length !== 1) return TEST_AMBIGUOUS;

  // A test already failing proves nothing by failing again.
  if (baseline.matched[0].status !== 'passed') return BASELINE_RED;

  const mutated = selectNamedTest(mutatedAssertions, testName);

  // The suite did not load - a mutation that is a syntax error, or a file the
  // runner could not parse. It fails the build either way, but calling it
  // SURVIVED would tell the reader their test is decorative when the truth is
  // that nothing ran.
  if (mutated.matched.length === 0) return MUTATION_DID_NOT_BUILD;

  // THE SAME GUARD ON THE MUTATED SIDE, and it was missing - which left the
  // original false KILLED only half closed. Guarding the baseline alone still
  // took `mutated.matched[0]` POSITIONALLY, so with two matches the verdict
  // was decided by the runner's report order: a gate got exit 0 and
  // `1/1 mutations killed` out of a named test asserting `expect(true)`,
  //
  //     failed | ...and it canary probe holds the line
  //     passed | ...canary probe holds the line
  //
  // which is the very evidence shape `readAssertions` quotes as closed. The
  // route in is a suffix-matching test that is SKIPPED at baseline and runs
  // under the mutation - a runtime-conditional skip, or an `it.each` table
  // sized from the mutated constant.
  if (mutated.matched.length > 1) return TEST_AMBIGUOUS;

  if (mutated.matched[0].status !== 'failed') return SURVIVED;

  // Red for the WRONG REASON is not a kill. See MALFORMED_MUTATION above.
  return mutationIsMalformed(mutated.matched[0].failure) ? MUTATION_IS_MALFORMED : KILLED;
}

export function exitCodeFor(results) {
  return results.length > 0 && results.every((result) => result.verdict === KILLED) ? 0 : 1;
}

/**
 * Entries needing a real database, and whether one is configured.
 *
 * Returns the entries that CANNOT run, so the caller can fail naming them. A
 * boolean here would let the caller decide to carry on.
 */
export function databaseEntriesWithoutADatabase(entries, env) {
  if (env.FIRSTHAND_TEST_DATABASE_URL) return [];
  return entries.filter((entry) => entry.needsDatabase).map((entry) => entry.id);
}

/**
 * EVERY TEST THE RUN ACTUALLY EXECUTED, by name and status.
 *
 * The first version read `numFailedTests` and called any failure a kill. A
 * gate broke it in the way that matters most: `-t` is an UNANCHORED SUBSTRING
 * match on both runners, so a second test whose name merely contains the
 * manifest's name is selected too - and if that one fails while the named one
 * passes, the entry reports KILLED having proved nothing. It demonstrated
 * exactly that, with jest's own report showing
 *
 *     passed | ...holds the ceiling at the number that was decided
 *     failed | ...holds the ceiling at the number that was decided, checked elsewhere
 *
 * and the canary saying KILLED, exit 0. That is this harness's own subject - a
 * check that cannot fail - inside the harness.
 *
 * So the verdict is decided on WHICH test failed, never on a count. Both
 * runners emit jest-shaped `testResults[].assertionResults[]` (verified on
 * jest 29.7.0 and vitest 3.2.7).
 *
 * Pending, skipped and todo are dropped: a filtered-out test is not evidence
 * of anything, and counting it would make every entry look ambiguous.
 */
export function readAssertions(parsed) {
  const assertions = [];

  for (const suite of Array.isArray(parsed?.testResults) ? parsed.testResults : []) {
    for (const a of Array.isArray(suite?.assertionResults) ? suite.assertionResults : []) {
      const status = String(a?.status ?? '');
      if (status === 'pending' || status === 'skipped' || status === 'todo') continue;
      // `failureMessages` comes through so a verdict can tell a mutation the
      // test CAUGHT from one that broke the statement out from under it. Both
      // runners emit it; an absent or empty array flattens to ''.
      assertions.push({
        fullName: String(a?.fullName ?? ''),
        status,
        failure: (Array.isArray(a?.failureMessages) ? a.failureMessages : []).join('\n')
      });
    }
  }

  return assertions;
}

/**
 * The named test among everything the run executed.
 *
 * `endsWith`, because a runner's `fullName` is the describe chain plus the
 * `it` title and the manifest names the title. `includes` would re-admit the
 * substring collision this exists to close.
 */
export function selectNamedTest(assertions, testName) {
  return {
    total: assertions.length,
    matched: assertions.filter((a) => a.fullName.endsWith(testName))
  };
}

/** Runs one named test and reports whether it passed and how many ran. */
function runNamedTest(entry, reportDir, suffix) {
  const outputFile = path.join(reportDir, `${entry.id}.${suffix}.json`);
  const cwd = path.join(REPO_ROOT, 'backend');

  const argv =
    entry.runner === 'jest'
      ? ['jest', entry.spec, '-t', entry.test, '--json', `--outputFile=${outputFile}`]
      : ['vitest', 'run', entry.spec, '-t', entry.test, '--reporter=json', `--outputFile=${outputFile}`];

  const run = spawnSync('npx', argv, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      // >=32 characters, or four suites fail to LOAD while the runner still
      // reports a pass - which would read as TEST_MISSING on every jest entry.
      SESSION_SECRET: sessionSecretFor(process.env),
      FIRSTHAND_SKIP_S3_TESTS: '1'
    }
  });

  // THE EXIT CODE IS NOT THE ANSWER, and this is the trap the file is written
  // around. A `-t` matching nothing exits 0 on BOTH runners with 0/0 in the
  // report - measured on jest 29.7.0 and vitest 3.2.7, correcting an earlier
  // version of this comment which claimed vitest exited 1. So the verdict is
  // read from the named assertion and the exit code is not consulted at all.
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(outputFile, 'utf8'));
  } catch {
    // No report at all: the runner did not get far enough to write one. An
    // empty list reports TEST_MISSING or MUTATION_DID_NOT_BUILD - correct, and
    // loud - rather than anything that could be mistaken for a kill.
  }

  return {
    assertions: readAssertions(parsed),
    // stderr first because it is where jest puts the cause; the report's own
    // message second because vitest writes no stderr at all.
    detail: mostTellingLine(run.stderr) || firstSuiteMessage(parsed)
  };
}

/**
 * The line worth showing, rather than the last three.
 *
 * On MUTATION_DID_NOT_BUILD the reader was handed jest's `Time: 1.337 s`
 * footer while `Test suite failed to run` sat at line two of the same stderr.
 * The tail is the right default and the wrong answer for the case that needs
 * it most.
 */
/** What actually went wrong. */
const CAUSE = /ERROR:|SyntaxError|TypeError|ReferenceError|Cannot find|is not defined/;

/** That something went wrong, without saying what. */
const HEADER = /failed to run|Transform failed/;

export function mostTellingLine(text) {
  const lines = (text ?? '').trim().split('\n').filter((line) => line.trim().length > 0);

  // THE CAUSE BEFORE THE HEADER, and in that order because the headers come
  // first in the output. `Transform failed with 1 error:` is line one and the
  // file, line and message are on line two, so searching one flat pattern
  // returned the announcement and dropped the answer.
  const telling = lines.find((line) => CAUSE.test(line)) ?? lines.find((line) => HEADER.test(line));

  return (telling ?? lines.slice(-3).join(' ')).trim();
}

/**
 * The cause, from the report, for the runner that writes no stderr at all.
 *
 * VITEST WRITES NOTHING TO STDERR on a suite that fails to load - measured at
 * 0 bytes against jest's 690 - and most of the manifest is vitest entries. So
 * the detail line this file added for MUTATION_DID_NOT_BUILD existed for the
 * jest ones and was blank for all the rest, which is a diagnosis that reads as
 * "no information" rather than as "not collected".
 *
 * Both runners do carry it, in the JSON the harness already parses:
 * `testResults[].message`.
 */
export function firstSuiteMessage(parsed) {
  for (const suite of Array.isArray(parsed?.testResults) ? parsed.testResults : []) {
    const message = mostTellingLine(String(suite?.message ?? ''));
    if (message) return message;
  }

  return '';
}

/** See porcelainFrom. */
function gitPorcelain() {
  return porcelainFrom(
    spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
  );
}

async function main() {
  const allowDirty = process.argv.includes('--allow-dirty');

  const dirtyBefore = gitPorcelain();
  if (dirtyBefore && !allowDirty) {
    console.error(
      'Refusing to run: the working tree is dirty.\n' +
        'This harness edits source files in place and restores them afterwards, so a\n' +
        'run that dies would lose uncommitted work. Use a dedicated worktree - two\n' +
        'harnesses restoring one checkout clobber each other silently. Pass\n' +
        '--allow-dirty if you accept that.\n\n' +
        dirtyBefore
    );
    process.exit(2);
  }

  const entries = JSON.parse(readFileSync(MANIFEST, 'utf8'));

  const problems = validateManifest(entries);
  if (problems.length > 0) {
    console.error('The manifest is not valid:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(2);
  }

  const unrunnable = databaseEntriesWithoutADatabase(entries, process.env);
  if (unrunnable.length > 0) {
    console.error(
      'Refusing to run: these entries need a real database and FIRSTHAND_TEST_DATABASE_URL\n' +
        'is not set. They are NOT skipped, because a skipped entry and a passing entry\n' +
        'read identically in a green job:\n' +
        unrunnable.map((id) => `  - ${id}`).join('\n')
    );
    process.exit(2);
  }

  const reportDir = mkdtempSync(path.join(tmpdir(), 'mutation-canary-'));
  const originals = new Map();
  const restoreAll = () => {
    for (const [file, source] of originals) writeFileSync(file, source);
  };

  // A harness that dies with a mutation applied hands the next reader a defect
  // wearing this file's name.
  //
  // THE `await` IN THE LOOP IS WHAT FIXED THIS, not these handlers, and an
  // earlier version of this comment claimed otherwise - in the file whose
  // subject is comments that misattribute. The handlers existed before and
  // were inert: every test run is a blocking `spawnSync` and the loop had no
  // `await`, so libuv never got a turn and a queued SIGINT was delivered
  // nowhere. Ctrl-C ran the entire manifest and exited 0. Measured, and
  // measured again after: deleting the yield reproduces it exactly.
  //
  // Reproduce with:
  //   node scripts/mutation-canary.mjs --allow-dirty & sleep 6; kill -INT %1
  // Expect exit 130, fewer than all entries run, and `git status` clean.
  //
  // `exit` is kept as well - synchronous, and it also covers `process.exit()`
  // - but a gate measured it redundant on every path this harness actually
  // takes, so it is described as belt-and-braces rather than as the fix.
  //
  // SIGKILL cannot be caught, and then the tree IS left mutated. The next run
  // refuses on the dirty check, which is the recovery.
  process.on('exit', restoreAll);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      restoreAll();
      rmSync(reportDir, { recursive: true, force: true });
      process.exit(130);
    });
  }

  const results = [];

  try {
    for (const entry of entries) {
      // Yields to the event loop so a queued signal can actually be delivered.
      // Without it every iteration is blocking `spawnSync` and the handlers
      // above never run.
      await new Promise((resolve) => setImmediate(resolve));

      const file = path.join(REPO_ROOT, entry.file);
      let source;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        results.push({ id: entry.id, verdict: ANCHOR_MISSING, detail: `${entry.file} does not exist` });
        console.log(`${ANCHOR_MISSING.padEnd(22)} ${entry.id} - ${entry.file} does not exist`);
        continue;
      }
      originals.set(file, source);

      const count = locateAnchor(source, entry.anchor);
      const anchorProblem = anchorVerdict(count);
      if (anchorProblem) {
        results.push({ id: entry.id, verdict: anchorProblem, detail: `anchor matched ${count} times` });
        console.log(`${anchorProblem.padEnd(22)} ${entry.id} - anchor matched ${count} times`);
        continue;
      }

      const baseline = runNamedTest(entry, reportDir, 'baseline');

      // The mutated run is only worth paying for once the baseline says the
      // named test exists, ran alone, and passed. Reaching
      // MUTATION_DID_NOT_BUILD here means exactly that, because the mutated
      // list is empty by construction.
      const baselineVerdict = verdictFor({
        baselineAssertions: baseline.assertions,
        mutatedAssertions: [],
        testName: entry.test
      });

      if (baselineVerdict !== MUTATION_DID_NOT_BUILD) {
        // THE GATE'S OWN NUMBER. This reported how many tests `-t` selected,
        // which stopped being the reason the moment the gate moved to
        // `matched.length` - so a run refused for two same-named assertions
        // pointed the reader at four tests, three of them innocent, and the
        // obvious remedy of renaming the neighbours would not have cleared it.
        const detail =
          baselineVerdict === TEST_AMBIGUOUS
            ? `${selectNamedTest(baseline.assertions, entry.test).matched.length} assertions end with this name`
            : baseline.detail;
        results.push({ id: entry.id, verdict: baselineVerdict, detail });
        console.log(
          `${baselineVerdict.padEnd(22)} ${entry.id} - "${entry.test}" in ${entry.spec}`
        );
        continue;
      }

      writeFileSync(file, applyMutation(source, entry.anchor, entry.mutation));
      const mutated = runNamedTest(entry, reportDir, 'mutated');
      writeFileSync(file, source);

      const verdict = verdictFor({
        baselineAssertions: baseline.assertions,
        mutatedAssertions: mutated.assertions,
        testName: entry.test
      });
      results.push({ id: entry.id, verdict, detail: mutated.detail });
      console.log(`${verdict.padEnd(22)} ${entry.id}`);
    }
  } finally {
    restoreAll();
    rmSync(reportDir, { recursive: true, force: true });
  }

  const dirtyAfter = gitPorcelain();
  if (dirtyAfter !== dirtyBefore) {
    console.error('The harness did not restore the tree it mutated:\n' + dirtyAfter);
    process.exit(2);
  }

  const failed = results.filter((result) => result.verdict !== KILLED);
  console.log(`\n${results.length - failed.length}/${results.length} mutations killed.`);

  if (failed.length > 0) {
    console.error('\nEntries that did not report KILLED:');
    for (const result of failed) {
      const entry = entries.find((candidate) => candidate.id === result.id);
      console.error(`\n  ${result.id}: ${result.verdict}`);
      console.error(`    why the line matters: ${entry.why}`);
      console.error(`    ${entry.file}  ->  ${entry.spec}  "${entry.test}"`);
      if (result.detail) console.error(`    ${result.detail}`);
    }
  }

  process.exit(exitCodeFor(results));
}

// Importable by its unit tests without running anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    // ONLY A `Refusal` IS REPORTED AS ONE. Catching everything here printed
    // `Refusing to run: undefinedHelper is not defined` for a genuine crash -
    // indistinguishable in a CI log from the git guard firing, with the stack
    // that would locate the bug discarded. Anything else is rethrown and gets
    // the trace it deserves.
    if (!(error instanceof Refusal)) throw error;

    console.error(`Refusing to run: ${error.message}`);
    process.exit(2);
  }
}
