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
 *  6. A RUN THAT NEVER FINISHED IS NOT A VERDICT. `spawnSync` had no ceiling,
 *     so a wedged runner stopped this blocking job producing output until CI
 *     killed the whole thing - a red with no entry name attached to it. See
 *     RUNNER_TIMEOUT_MS and RUNNER_DID_NOT_FINISH.
 *  7. THE MUTATION HAS TO STILL BE ON DISK WHEN THE RUNNER STOPS. Nothing
 *     checked, so anything that put the original bytes back mid-run - the
 *     second harness this header warns about, an editor, a `git restore` -
 *     produced a passing test and was graded SURVIVED, which reads as "your
 *     test is decorative" about a test that is fine. cto/AdaptaLabs#50. See
 *     MUTATION_WAS_LOST.
 *
 *     Reproduce with a one-entry manifest and a saboteur that reverts the
 *     target file the moment the mutation appears in it:
 *       while grep -q "$ANCHOR" "$FILE"; do sleep 0.05; done; cp "$PRISTINE" "$FILE"
 *     Measured, interleaved, three rounds each: the harness before this guard
 *     said SURVIVED 3/3, after it says MUTATION_WAS_LOST 3/3, and with the
 *     saboteur off both say KILLED 3/3.
 *  8. THE ENVIRONMENT BREAKING UNDER THE TEST IS NOT A KILL EITHER, and it is
 *     the direction that matters most because it produces a GREEN job over a
 *     property nothing evaluated. A database that goes away mid-test turns the
 *     named test red without the mutation ever being judged; a database that
 *     was never there kills the whole suite before a test runs, and that used
 *     to report TEST_MISSING - the manifest blamed for naming a test that is
 *     sitting right there. cto/AdaptaLabs#58. See ENVIRONMENT_FAILURE and
 *     suiteFailedWithoutRunningATest.
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
export const RUNNER_DID_NOT_FINISH = 'RUNNER_DID_NOT_FINISH';
export const MUTATION_WAS_LOST = 'MUTATION_WAS_LOST';
export const ENVIRONMENT_FAILED = 'ENVIRONMENT_FAILED';

const RUNNERS = new Set(['jest', 'vitest']);

/**
 * The workspaces a spec can be run from.
 *
 * `runNamedTest` hardcoded `REPO_ROOT/backend`, which made the frontend
 * STRUCTURALLY unreachable rather than merely uncovered - and the two read
 * identically from the manifest, where every entry is backend or shared (grep
 * the manifest rather than trusting a count here).
 * That is the shape this harness exists to refuse everywhere else: an absence
 * that looks like a decision.
 */
const PROJECTS = new Set(['backend', 'frontend']);

/**
 * Which workspace an entry's spec runs in.
 *
 * Optional, and DEFAULTS TO BACKEND, so every entry written before this field
 * existed keeps running exactly where it ran. That default is the load-bearing
 * half: getting it wrong relocates every existing entry at once, which is why it
 * has its own control in the wiring suite rather than only a unit test.
 */
export function projectDirFor(entry) {
  // Falls back rather than trusting the field: `validateManifest` runs first and
  // refuses anything else, but this is a path segment handed to `path.join`, and
  // a sink that trusts its input is the shape this harness exists to refuse.
  return PROJECTS.has(entry?.project) ? entry.project : 'backend';
}

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
 * Restore every mutated file, attempting ALL of them even when one write fails,
 * and report by path the ones it could not (cto/AdaptaLabs#73).
 *
 * The old form was a bare `for … writeFileSync` loop, and a bare loop throws on
 * the FIRST failing write and abandons the rest - leaving more live mutations
 * in the tree than the single one that failed. Worse, it threw from inside the
 * `exit`/`SIGINT`/`SIGTERM` handlers and the run's `finally`, so the post-run
 * dirty check that would otherwise catch it never ran. Observed live when a
 * machine hit `ENOSPC` mid-run and a `MAX_TIME_SLOTS_PER_REQUEST * 1000`
 * mutation was left sitting in a checkout.
 *
 * DOES NOT THROW. The whole value of this call is putting the tree back, so it
 * makes every attempt it can and RETURNS what it could not restore rather than
 * aborting - every caller is a handler or a `finally`, and the downstream
 * dirty check still fails the run if anything is left behind. The report is
 * loud and names each file, because "a file silently not restored" is exactly
 * the harness corrupting the thing it exists to protect.
 *
 * `log` is injectable so the failure path can be asserted without stubbing a
 * global; it defaults to the real stderr sink.
 */
export function restoreFiles(originals, log = console.error) {
  const failed = [];
  for (const [file, source] of originals) {
    try {
      writeFileSync(file, source);
    } catch (error) {
      failed.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failed.length > 0) {
    log(
      `\nFAILED TO RESTORE ${failed.length} mutated file(s) - a LIVE MUTATION remains in ` +
        'the working tree. Restore each by hand before committing (git checkout -- <file>):\n' +
        failed.map(({ file, message }) => `  ${file}: ${message}`).join('\n')
    );
  }
  return failed;
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

    // Absent is fine and means backend; present and unknown is a typo that
    // would otherwise spawn in a directory that does not exist, and an ENOENT
    // from spawnSync reports RUNNER_DID_NOT_FINISH - a harness fault, for what
    // is really a manifest fault.
    if (entry?.project !== undefined && !PROJECTS.has(entry.project)) {
      problems.push(`${where}: project must be one of ${[...PROJECTS].join(', ')}`);
    }

    // Nothing under frontend/ reaches Postgres, so this pairing is a mistake
    // rather than a configuration - and an expensive one to leave standing,
    // because `needsDatabase` DOWNGRADES a red to ENVIRONMENT_FAILED. An entry
    // wrongly claiming it would convert its own genuine failure into a shrug,
    // which is the one direction this harness must never fail in.
    if (entry?.project === 'frontend' && entry?.needsDatabase) {
      problems.push(`${where}: a frontend entry cannot need a database`);
    }

    // frontend/ has no jest. The harness spawns a bare `npx jest`, which would
    // DOWNLOAD a different jest major from the registry mid-run rather than
    // fail, and report the wreckage as MUTATION_DID_NOT_BUILD or TEST_MISSING -
    // a harness fault for what is a manifest fault, which is the same argument
    // as the unknown-project refusal above.
    if (entry?.project === 'frontend' && entry?.runner === 'jest') {
      problems.push(`${where}: a frontend entry cannot use the jest runner`);
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

// The removal ledger sits beside the manifest. cto/AdaptaLabs#29.
export const REMOVED_LEDGER = path.join(HERE, 'mutation-canary.removed.json');
const MANIFEST_REL = 'scripts/mutation-canary.manifest.json';
const LEDGER_REL = 'scripts/mutation-canary.removed.json';

/** The ids of a parsed manifest or ledger, in order, skipping malformed rows. */
export function idsOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => entry?.id)
    .filter((id) => typeof id === 'string');
}

/**
 * The ids a change DROPPED WITHOUT SAYING SO: present in the base manifest, gone
 * from the current one, and not listed in the removal ledger. cto/AdaptaLabs#29.
 *
 * `scripts/mutation-canary.manifest.json` is a JSON array every branch appends
 * to, so two branches in flight conflict on it routinely. The conflict is not
 * the danger - a SILENT RESOLUTION is. A merge that takes one side of the append
 * loses entries, and nothing notices: `validateManifest` checks shape and
 * duplicate ids, NOT counts, so the canary then reports e.g. `70/70 killed`,
 * exit 0, over a manifest that quietly lost seven. A green canary over a
 * shrunken manifest is worse than a red one - it reads as "everything is still
 * pinned".
 *
 * This is the DURABLE form, not the merge-time form. "Zero deletions vs the
 * base" would red-gate a legitimate removal - an entry whose anchor genuinely
 * went away - and the first time a gate blocks something legitimate, somebody
 * disables it, and a gate that gets disabled protects nothing. Here a deliberate
 * removal is STATED in the ledger and passes; only an unstated loss fails.
 */
export function unstatedRemovals(baseEntries, currentEntries, removedLedger) {
  const current = new Set(idsOf(currentEntries));
  const stated = new Set(idsOf(removedLedger));
  return idsOf(baseEntries).filter((id) => !current.has(id) && !stated.has(id));
}

/**
 * The ledger's own integrity. It must be a JSON array of `{id, reason}`, with no
 * duplicate ids and - the load-bearing one - NO id that is back in the manifest.
 * A stale ledger entry for a since-restored id would silently excuse a future
 * real loss of it, which is the exact failure this whole check exists to catch.
 */
export function validateRemovedLedger(ledger, currentEntries) {
  if (!Array.isArray(ledger)) {
    return ['the removed-entries ledger must be a JSON array'];
  }

  const problems = [];
  const current = new Set(idsOf(currentEntries));
  const seen = new Set();

  ledger.forEach((entry, index) => {
    const where = `removed entry ${index}${entry?.id ? ` (${entry.id})` : ''}`;

    for (const field of ['id', 'reason']) {
      if (typeof entry?.[field] !== 'string' || entry[field].length === 0) {
        problems.push(`${where}: ${field} is missing or not a non-empty string`);
      }
    }

    if (seen.has(entry?.id)) problems.push(`${where}: duplicate id`);
    seen.add(entry?.id);

    if (current.has(entry?.id)) {
      problems.push(
        `${where}: this id is present in the manifest again, so it must be removed from the ledger`
      );
    }
  });

  return problems;
}

/**
 * Run git, failing CLOSED. A check that cannot read the base must refuse, not
 * pass - the same disposition as `porcelainFrom`. Returns stdout on success.
 */
function runGit(args, cwd) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.error || run.status !== 0) {
    const detail = (run.stderr || run.error?.message || `exit ${run.status}`).trim();
    throw new Refusal(`git ${args.join(' ')} failed: ${detail}`);
  }
  return run.stdout;
}

/** The merge-base of HEAD and the base branch. Refusal if it cannot resolve. */
export function baseRefFor(baseBranch, cwd = REPO_ROOT) {
  return runGit(['merge-base', 'HEAD', baseBranch], cwd).trim();
}

/**
 * The unstated removals of the current working manifest against the manifest as
 * committed at `baseRef`. Reads the base manifest through `git show`, so it needs
 * that commit present - a shallow clone without the merge-base refuses here
 * rather than passing. cto/AdaptaLabs#29.
 */
export function unstatedRemovalsAgainst(
  baseRef,
  { cwd = REPO_ROOT, manifestRel = MANIFEST_REL, ledgerRel = LEDGER_REL } = {}
) {
  const base = JSON.parse(runGit(['show', `${baseRef}:${manifestRel}`], cwd));
  // Fail CLOSED on a base that is not a non-empty array. `idsOf` would return
  // `[]` for `null`/`{}`/a number, and an empty base reports zero losses - a
  // fail-open in the one place this whole check exists to prevent.
  if (!Array.isArray(base) || base.length === 0) {
    throw new Refusal(`the manifest at ${baseRef} is not a non-empty array, so the base cannot be trusted`);
  }
  const current = JSON.parse(readFileSync(path.join(cwd, manifestRel), 'utf8'));
  const ledger = JSON.parse(readFileSync(path.join(cwd, ledgerRel), 'utf8'));
  return unstatedRemovals(base, current, ledger);
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
 * THE SAME FAMILY FROM THE KILLED SIDE. cto/AdaptaLabs#58.
 *
 * `MALFORMED_MUTATION` covers a mutation that broke the STATEMENT. It does not
 * cover a test that went red because the DATABASE went away under it, and
 * measured against `mutationIsMalformed` every one of these returns false:
 *
 *   Error: Connection terminated unexpectedly
 *   error: too many clients already
 *   error: terminating connection due to administrator command
 *   Error: connect ECONNREFUSED 127.0.0.1:5432
 *
 * Each turns the named test red without the property under test ever being
 * evaluated, and the harness graded all four KILLED, exit 0 - a green canary
 * asserting a property it never evaluated, which is this harness's own subject.
 *
 * GATED ON `needsDatabase`, and the gate is the load-bearing half rather than
 * the pattern. A text signature on the mutated side can swallow a REAL kill,
 * and this repository already contains the counterexample: three suites inject
 * `connect ECONNREFUSED cortex-db.internal:5432` on purpose and assert the
 * response body does not leak it - `admin.dashboard-and-request-read-live-role`,
 * `health-endpoint` and `opportunities.test.ts`. Break that redaction and the
 * failure text quotes the received body, ECONNREFUSED and all. Every one of
 * those runs against a MOCKED pool, so `needsDatabase` is absent on any entry
 * that could name them, and the check cannot reach them. There is a control for
 * exactly this in mutation-canary.test.js.
 *
 * WHAT IS MEASURED AND WHAT IS NOT, stated plainly because #58 was careful to.
 * The predicate results above are measured. A real mid-test connection death
 * producing a false KILLED end to end is NOT: the window is roughly 200ms and
 * two attempts to kill a container inside it both landed after the assertion.
 * So the inference is from the predicate and from the wiring test, not from a
 * reproduction.
 *
 * NOT THE WHOLE CLASS. An environmental death that takes the whole suite down
 * on the MUTATED side still reports MUTATION_DID_NOT_BUILD, because there the
 * mutation is the one thing that changed and blaming it first is right.
 */
const ENVIRONMENT_FAILURE = new RegExp(
  [
    // The server closed the socket mid-query, or the pool client was destroyed.
    'Connection terminated',
    // The server is up and out of connection slots. Nothing about the property.
    'too many clients already',
    // `pg_terminate_backend`, a restart, a `docker stop` on the container.
    'terminating connection due to',
    // No server at the other end at all.
    'ECONNREFUSED'
  ].join('|'),
  'i'
);

export function environmentFailed(failure) {
  return ENVIRONMENT_FAILURE.test(String(failure ?? ''));
}

/**
 * A SUITE THAT REPORTED FAILED HAVING EXECUTED NOTHING, which is what a
 * `beforeAll` dying looks like in both runners' JSON.
 *
 * The second, smaller half of cto/AdaptaLabs#58, and the issue's own account of
 * it does not reproduce. With `FIRSTHAND_TEST_DATABASE_URL` pointed at a dead
 * port, the verdict from `main()` is TEST_MISSING, not MUTATION_DID_NOT_BUILD:
 * `startTestPostgres` throws in `beforeAll` on the BASELINE run, so the empty
 * matched list is read on the baseline side and never reaches the mutated one.
 * TEST_MISSING is the worse of the two names - it sends the reader to the
 * manifest to look for a test that is sitting right there.
 *
 * NO TEXT TO MATCH, measured: vitest 3.2.7 wrote 0 bytes to stderr, an empty
 * `testResults[].message`, and all eleven assertions as `skipped`. So the
 * signature above cannot see this case and the discriminator has to be
 * structural. It is, and it separates cleanly:
 *
 *   genuinely missing test name, database up  ->  suite passed, 0 executed
 *   no database at all                        ->  suite FAILED, 0 executed
 *
 * Both measured on the same spec, on vitest 3.2.7, minutes apart.
 */
export function suiteFailedWithoutRunningATest(parsed) {
  const suites = Array.isArray(parsed?.testResults) ? parsed.testResults : [];
  return (
    suites.some((suite) => String(suite?.status ?? '') === 'failed') &&
    readAssertions(parsed).length === 0
  );
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
export function verdictFor({
  baselineAssertions,
  mutatedAssertions,
  testName,
  // DEFAULTED TRUE, so the baseline-only call below - which passes an empty
  // mutated list on purpose to reach MUTATION_DID_NOT_BUILD - keeps behaving
  // exactly as it did. Only the loop, which has the evidence, passes them.
  baselineFinished = true,
  mutatedFinished = true,
  mutationHeld = true,
  // cto/AdaptaLabs#58. Both default to the shape that changes nothing, so the
  // baseline-only call below keeps behaving exactly as it did.
  baselineRanNothingAndFailed = false,
  needsDatabase = false
}) {
  // A RUN THAT NEVER FINISHED HAS NOTHING TO GRADE, and it used to be graded
  // anyway. Killed, timed out or never spawned, `spawnSync` wrote no report,
  // and no report is an empty assertion list - which reads as TEST_MISSING on
  // the baseline and MUTATION_DID_NOT_BUILD on the mutated side. Both send the
  // reader to the manifest or to the mutation, and neither is the problem.
  if (!baselineFinished) return RUNNER_DID_NOT_FINISH;

  const baseline = selectNamedTest(baselineAssertions, testName);

  // THE ANTI-ROT GUARD: renamed or deleted, the build breaks.
  //
  // Unless the suite never got to run a test at all, in which case blaming the
  // manifest is the wrong trip entirely: the test is right there and the
  // environment is what failed. See suiteFailedWithoutRunningATest.
  if (baseline.matched.length === 0) {
    return baselineRanNothingAndFailed ? ENVIRONMENT_FAILED : TEST_MISSING;
  }

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

  if (!mutatedFinished) return RUNNER_DID_NOT_FINISH;

  // THE MUTATION HAS TO STILL BE ON DISK WHEN THE RUNNER STOPS, and nothing
  // checked. This is the hole cto/AdaptaLabs#50 is about: SURVIVED is emitted
  // on the strength of the named test PASSING under mutation, and a mutation
  // that was never in the file the runner read produces exactly that - a pass,
  // graded as "your test is decorative". The two are indistinguishable in the
  // job log, and they send the reader to opposite ends of the repository.
  //
  // It is not a hypothetical route. This file's own header says it: "two
  // harnesses backing up and restoring one checkout clobber each other
  // silently". Anything that puts the original bytes back while the runner is
  // still working - a second harness, an editor, a `git restore`, a formatter
  // on save - lands here, and every one of them used to land as SURVIVED.
  //
  // Checked on the bytes rather than on the anchor, because a mutation is
  // sometimes a DELETION and "the anchor is back" and "the mutation is gone"
  // are then the same string.
  if (!mutationHeld) return MUTATION_WAS_LOST;

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

  // Red for the WRONG REASON is not a kill. See MALFORMED_MUTATION above, and
  // ENVIRONMENT_FAILURE for the same thing done to the test by the database
  // rather than by the mutation - which only a database entry can suffer.
  if (needsDatabase && environmentFailed(mutated.matched[0].failure)) return ENVIRONMENT_FAILED;

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

/**
 * THE CEILING ON ONE RUNNER INVOCATION, and the reason there is one at all.
 *
 * `spawnSync` with no `timeout` waits for ever, and "for ever" is not
 * hypothetical here: the entries that set `needsDatabase` reach a real Postgres
 * through a pool, where a lock never granted or a server that accepts the socket
 * and never answers hangs the runner rather than failing it. #40 was the same
 * observation from the other end - the pool set no `statement_timeout`, so a
 * slow statement waited instead of failing by name. That half is now closed:
 * the backend pool carries a server-side 120s statement bound and a 125s
 * client-side one (config/index.ts), so a wedged statement on one of those
 * entries fails by name well inside this ceiling. This ceiling still covers
 * everything a statement bound cannot.
 *
 * The rest hang more rarely and not never: a runner can wedge on a timer, an
 * open handle or a machine out of process slots.
 *
 * COUNTS ARE DELIBERATELY NOT WRITTEN DOWN HERE. This paragraph used to say
 * "EIGHT of the manifest's 132 entries", and by the time the refute gate on
 * !272 checked it the real figures were TEN of 146 - a note nobody re-measures
 * becomes a note that lies, and the manifest is appended to by nearly every
 * branch. `node -e` over the manifest answers both questions in a second, which
 * is cheaper than a number that has to be maintained.
 *
 * Unbounded, any of those stops this BLOCKING job producing output until GitLab
 * kills the whole thing, and that failure has no NAME - no entry, no verdict,
 * no line saying which mutation was in flight. Bounded, the same event is one
 * line naming the entry.
 *
 * ponytail: one flat ceiling for every entry, not a per-entry budget.
 *   -> cto/AdaptaLabs#61. The upgrade path is a `timeoutMs` on the manifest
 *   entry, defaulted to this, and it is not taken because the margin does not
 *   need it. What #61 asked for first was a MEASUREMENT rather than a budget,
 *   and the run now takes its own: every invocation is timed and the closing
 *   summary names the slowest one against this ceiling, so a CI job log states
 *   the margin instead of a developer extrapolating one. The number that
 *   mattered had never been measured, only estimated at roughly 27x.
 *
 * Read the summary line of a real job log for the margin rather than trusting a
 * number written down in this comment; every count this file has carried has
 * gone stale within a fortnight.
 */
export const RUNNER_TIMEOUT_MS = 5 * 60_000;

/**
 * The slowest single runner invocation of a run, for the closing summary.
 *
 * ONE INVOCATION, not one entry, because that is what the ceiling actually
 * bounds: `spawnSync` is given RUNNER_TIMEOUT_MS per call and an entry makes two
 * of them. Reporting a per-entry total would overstate the margin by about half
 * - the wrong direction for a number whose job is to say how close the ceiling
 * is to firing on innocent input.
 */
export function slowestRun(timings) {
  return timings.reduce(
    (slowest, timing) => (timing.ms > slowest.ms ? timing : slowest),
    { id: 'nothing ran', phase: '-', ms: 0 }
  );
}

/**
 * Whether the runner got to the end under its own steam.
 *
 * `spawnSync` reports three different disasters in two places and NEITHER was
 * consulted before: `error` carries a failure to spawn at all (ENOENT on npx,
 * EAGAIN when the machine is out of process slots) and the ETIMEDOUT kill, and
 * `signal` carries any other death by signal - an OOM kill, an operator's
 * Ctrl-C reaching the child. All three used to arrive here as "there is no
 * report", which is reported as MUTATION_DID_NOT_BUILD: a verdict that sends
 * the reader to look for a syntax error in a mutation that is fine.
 */
export function runnerFinished(run) {
  return !run?.error && !run?.signal;
}

/** Runs one named test and reports whether it passed and how many ran. */
function runNamedTest(entry, reportDir, suffix) {
  const outputFile = path.join(reportDir, `${entry.id}.${suffix}.json`);
  const cwd = path.join(REPO_ROOT, projectDirFor(entry));

  const argv =
    entry.runner === 'jest'
      ? ['jest', entry.spec, '-t', entry.test, '--json', `--outputFile=${outputFile}`]
      : ['vitest', 'run', entry.spec, '-t', entry.test, '--reporter=json', `--outputFile=${outputFile}`];

  const startedAt = Date.now();
  const run = spawnSync('npx', argv, {
    cwd,
    encoding: 'utf8',
    timeout: RUNNER_TIMEOUT_MS,
    // SIGTERM leaves a wedged runner's own children behind; the point of the
    // ceiling is that the harness gets its turn back.
    //
    // ponytail: kills `npx`, not the process group, so a wedged vitest worker
    //   can outlive it as an orphan. `spawnSync` cannot signal a group. It
    //   costs nothing that matters - every spec here gets its own database, and
    //   the job is failing by then anyway - but if orphans ever become a
    //   nuisance, this call has to become an async spawn with `detached: true`
    //   and a `process.kill(-pid)`.
    killSignal: 'SIGKILL',
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
    finished: runnerFinished(run),
    // cto/AdaptaLabs#61: what the ceiling is actually measured against.
    elapsedMs: Date.now() - startedAt,
    // cto/AdaptaLabs#58: a `beforeAll` that died, as distinct from a `-t` that
    // selected nothing. Both produce an empty assertion list.
    ranNothingAndFailed: suiteFailedWithoutRunningATest(parsed),
    // stderr first because it is where jest puts the cause; the report's own
    // message second because vitest writes no stderr at all.
    detail: runnerFinished(run)
      ? mostTellingLine(run.stderr) || firstSuiteMessage(parsed)
      : `the runner did not finish: ${run.error?.message ?? `killed by ${run.signal}`}`
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

/**
 * EVERY BARE ARGUMENT THIS SCRIPT ACCEPTS. There is exactly one, and the
 * shortness of this set is the point rather than an oversight - see
 * `unrecognisedArgs`.
 */
export const ACCEPTED_ARGS = new Set(['--allow-dirty']);

/**
 * EVERY VALUE-TAKING ARGUMENT, all in `--flag=value` form. These two exist for
 * CI sharding (cto/AdaptaLabs#77) and their values are checked in
 * `parseShardArgs` - digit-only, 1-based, both-or-neither - because an operator
 * interface that accepts a typo without comment is how a scoped verification
 * becomes no verification.
 *
 * SHARDING IS NOT THE FILTER #53 REFUSES. A filter selects a subset and lets
 * that run's verdict stand for the whole; a shard is one cell of a
 * deterministic partition whose union is the whole manifest, and the CI gate
 * is ALL shards green. Every entry still runs exactly once per pipeline.
 */
export const ACCEPTED_VALUE_ARGS = new Set(['--shard-index', '--shard-total']);

/**
 * The arguments this script does not understand, so it can refuse them.
 *
 * IT USED TO IGNORE THEM. `process.argv.includes('--allow-dirty')` was the whole
 * parser, so anything else fell through in silence and exit 0. cto/AdaptaLabs#53
 * caught it the way these things are always caught: a review gate ran
 * `node scripts/mutation-canary.mjs --id <one-entry>` meaning to check a single
 * entry, got the whole manifest, and read the resulting `119/119 killed` as a
 * verdict about its one entry. It happened to be right, so the habit survived.
 *
 * THERE IS NO FILTER FLAG, and that is deliberate rather than missing. A
 * filtered run is structurally blind to a pre-existing entry the same diff
 * broke: !267's author ran the canary against a manifest cut down to their own
 * new entries and reddened main. So the answer to "which flag scopes this to one
 * entry" is that none does, and an argument asking for one now says so instead
 * of quietly running everything.
 *
 * Fails CLOSED, like every other guard in this file: an operator interface that
 * accepts a typo without comment is how a scoped verification becomes no
 * verification. The two value-taking flags have their VALUES checked in
 * `parseShardArgs`; `--allow-dirty` takes no value, so a mistyped
 * `--allow-dirty=yes` is simply unrecognised.
 *
 * A bare `--shard-index` (no `=`) is deliberately RECOGNISED here and refused
 * by `parseShardArgs` instead, so the message names the missing value rather
 * than disowning a flag that plainly exists.
 */
export function unrecognisedArgs(argv) {
  return argv.filter((arg) => {
    if (ACCEPTED_ARGS.has(arg)) return false;
    if (ACCEPTED_VALUE_ARGS.has(arg)) return false;
    const eq = arg.indexOf('=');
    if (eq !== -1 && ACCEPTED_VALUE_ARGS.has(arg.slice(0, eq))) return false;
    return true;
  });
}

/**
 * The shard request, or null for the full run - which stays the default and
 * the only local shape. Refusals, not fallbacks, for everything else:
 *
 * - both-or-neither: one flag alone is a half-configured partition, and half a
 *   partition run as a whole is exactly the filtered run #53 exists to refuse;
 * - digit-only values: `Number()` reads `1e1`, `0x2` and `-1` happily, and in
 *   this position every one of them is a typo (the PORT lesson from #59);
 * - 1-based and bounded, matching GitLab's own `CI_NODE_INDEX`, which is where
 *   the values come from in CI (`parallel:` sets both, so a mismatched pair
 *   cannot be typed into one job there - this guard is for every other caller).
 */
export function parseShardArgs(argv) {
  const values = new Map();
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!ACCEPTED_VALUE_ARGS.has(name)) continue;
    if (eq === -1) throw new Refusal(`${name} needs a value: ${name}=<n>`);
    if (values.has(name)) throw new Refusal(`${name} was given twice`);
    values.set(name, arg.slice(eq + 1));
  }
  if (values.size === 0) return null;
  if (!values.has('--shard-index') || !values.has('--shard-total')) {
    throw new Refusal(
      '--shard-index and --shard-total come as a pair - both or neither. One alone is ' +
        'half a partition, and running half a partition as though it were the whole ' +
        'manifest is the filtered run this harness refuses on principle.'
    );
  }
  for (const [name, raw] of values) {
    if (!/^[0-9]+$/.test(raw)) {
      throw new Refusal(`${name}=${raw} is not a plain integer (digits only, no sign, no exponent)`);
    }
  }
  const shardIndex = Number(values.get('--shard-index'));
  const shardTotal = Number(values.get('--shard-total'));
  if (shardTotal < 1) throw new Refusal('--shard-total must be at least 1');
  if (shardIndex < 1 || shardIndex > shardTotal) {
    throw new Refusal(
      `--shard-index is 1-based and at most the total: got index ${shardIndex} of ${shardTotal}`
    );
  }
  return { shardIndex, shardTotal };
}

/**
 * One cell of the partition: entries sorted by id, entry i (0-based) belongs to
 * shard `(i % total) + 1`. Sorted by ID rather than taken in manifest order so
 * the cell an entry lands in depends on nothing but the ids - a reordering
 * diff cannot shuffle the partition. Same manifest + same total in every job
 * means the union is the whole manifest by construction.
 */
export function shardSlice(entries, shardIndex, shardTotal) {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.filter((_, index) => index % shardTotal === shardIndex - 1);
}

async function main() {
  const args = process.argv.slice(2);

  const unrecognised = unrecognisedArgs(args);
  if (unrecognised.length > 0) {
    console.error(
      `Refusing to run: unrecognised argument${unrecognised.length > 1 ? 's' : ''} ` +
        `${unrecognised.join(' ')}\n` +
        `The accepted arguments are ${[...ACCEPTED_ARGS].join(' ')} and the CI sharding pair ` +
        `${[...ACCEPTED_VALUE_ARGS].map((flag) => `${flag}=<n>`).join(' ')}.\n` +
        'There is NO filter flag: this runner always runs the whole manifest, because a\n' +
        'run scoped to the entries a diff added cannot see a pre-existing entry the same\n' +
        'diff broke. Ignoring this argument would have run all of them anyway, silently,\n' +
        'and reported a full run as though it were the scoped one you asked for.'
    );
    process.exit(2);
  }

  const allowDirty = args.includes('--allow-dirty');

  // Before the dirty-tree guard for the same reason the unrecognised check is:
  // a malformed argument gets a message about the argument, not about the tree.
  // Throws Refusal, which the entry point reports as `Refusing to run:` exit 2.
  const shard = parseShardArgs(args);

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

  // The whole manifest is validated above whatever the shard, so a broken
  // entry fails every shard rather than only the one that owns it. The slice
  // decides what RUNS, never what is checked.
  const selected = shard ? shardSlice(entries, shard.shardIndex, shard.shardTotal) : entries;
  if (shard && selected.length === 0) {
    console.error(
      `Refusing to run: shard ${shard.shardIndex} of ${shard.shardTotal} selects no entries ` +
        `from a ${entries.length}-entry manifest.\n` +
        'A shard that runs nothing reads exactly like a shard that passed, so an oversized\n' +
        '--shard-total quietly deletes coverage. Lower the total or fix the wiring.'
    );
    process.exit(2);
  }

  const unrunnable = databaseEntriesWithoutADatabase(selected, process.env);
  if (unrunnable.length > 0) {
    console.error(
      'Refusing to run: these entries need a real database and FIRSTHAND_TEST_DATABASE_URL\n' +
        'is not set. They are NOT skipped, because a skipped entry and a passing entry\n' +
        'read identically in a green job:\n' +
        unrunnable.map((id) => `  - ${id}`).join('\n')
    );
    process.exit(2);
  }

  // SAY HOW MANY ENTRIES ARE ABOUT TO RUN. The cheaper half of cto/AdaptaLabs#53:
  // whatever the argument parser does, a run that states its own size makes both
  // "I meant to scope this" and "the manifest lost entries" visible in line one
  // rather than in a wall clock nobody was watching. A shard states its cell of
  // the partition the same way, so the slice lines across a pipeline's jobs sum
  // to the manifest - checkable from the logs alone.
  if (shard) {
    console.log(
      `Shard ${shard.shardIndex} of ${shard.shardTotal}: running ${selected.length} of ` +
        `${entries.length} manifest entries. The union of all ${shard.shardTotal} shards is ` +
        'the whole manifest; there is no filter.'
    );
  } else {
    console.log(`Running all ${entries.length} manifest entries; there is no filter.`);
  }

  const reportDir = mkdtempSync(path.join(tmpdir(), 'mutation-canary-'));
  const originals = new Map();
  // Attempts every file and reports (never throws) - see restoreFiles (#73). A
  // throw here would abort the exit/signal handlers and the finally below,
  // which is the failure that left a live mutation in the tree.
  const restoreAll = () => restoreFiles(originals);

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
  // cto/AdaptaLabs#61: every runner invocation, so the run can state its own
  // margin against RUNNER_TIMEOUT_MS rather than leaving it to be extrapolated.
  const timings = [];

  try {
    for (const entry of selected) {
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
      timings.push({ id: entry.id, phase: 'baseline', ms: baseline.elapsedMs });

      // The mutated run is only worth paying for once the baseline says the
      // named test exists, ran alone, and passed. Reaching
      // MUTATION_DID_NOT_BUILD here means exactly that, because the mutated
      // list is empty by construction.
      const baselineVerdict = verdictFor({
        baselineAssertions: baseline.assertions,
        mutatedAssertions: [],
        testName: entry.test,
        baselineFinished: baseline.finished,
        baselineRanNothingAndFailed: baseline.ranNothingAndFailed
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
            : baselineVerdict === ENVIRONMENT_FAILED
              ? `${entry.spec} reported a FAILED suite having executed no test at all, with no ` +
                'mutation applied. Nothing about this entry was measured. The likeliest cause is ' +
                'a setup hook that died - for a needsDatabase entry, no reachable database.' +
                (baseline.detail ? ` ${baseline.detail}` : ' The runner said nothing further.')
              : baseline.detail;
        results.push({ id: entry.id, verdict: baselineVerdict, detail });
        console.log(
          `${baselineVerdict.padEnd(22)} ${entry.id} - "${entry.test}" in ${entry.spec}`
        );
        continue;
      }

      const mutatedSource = applyMutation(source, entry.anchor, entry.mutation);
      writeFileSync(file, mutatedSource);
      const mutated = runNamedTest(entry, reportDir, 'mutated');
      timings.push({ id: entry.id, phase: 'mutated', ms: mutated.elapsedMs });
      // READ BACK BEFORE RESTORING, or the check is against this harness's own
      // restore and can never fail.
      let mutationHeld = false;
      try {
        mutationHeld = readFileSync(file, 'utf8') === mutatedSource;
      } catch {
        // The file went away under the run. Not held, and not a crash: the
        // verdict says so and the restore below puts it back.
      }
      writeFileSync(file, source);

      const verdict = verdictFor({
        baselineAssertions: baseline.assertions,
        mutatedAssertions: mutated.assertions,
        testName: entry.test,
        // NO `baselineFinished` HERE, and its absence is deliberate. The
        // baseline-only call above short-circuits every unfinished baseline
        // with `continue`, so it would be `true` at this line always - a line
        // that cannot fail, in the file whose whole subject is checks that
        // cannot fail. Measured: with it present, deleting it broke nothing
        // (165 pass, 0 fail), while deleting the one above it fails
        // `main() hands verdictFor whether the BASELINE runner finished`.
        mutatedFinished: mutated.finished,
        mutationHeld,
        // cto/AdaptaLabs#58. Only an entry that reaches a real database can go
        // red because the database went away, and confining the check to those
        // is what stops it swallowing the kills of the three suites that inject
        // a connection error ON PURPOSE against a mocked pool.
        needsDatabase: Boolean(entry.needsDatabase)
      });
      results.push({
        id: entry.id,
        verdict,
        detail:
          verdict === MUTATION_WAS_LOST
            ? `${entry.file} no longer held the mutation when the runner stopped, so nothing about ` +
              'this entry was measured. Something else wrote to the tree during the run.'
            : mutated.detail
      });
      // THE ELAPSED TIME BESIDE THE VERDICT. cto/AdaptaLabs#61: a
      // RUNNER_DID_NOT_FINISH at five minutes and one three seconds in are the
      // same line otherwise, and they mean opposite things - a ceiling that
      // fired on a slow entry, or a runner that died. Both invocations, because
      // the ceiling bounds each of them separately.
      const elapsed = `${(baseline.elapsedMs / 1000).toFixed(1)}s + ${(mutated.elapsedMs / 1000).toFixed(1)}s`;
      console.log(`${verdict.padEnd(22)} ${entry.id} (${elapsed})`);
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

  // THE RUN MEASURES ITS OWN MARGIN. cto/AdaptaLabs#61 asked for the CI figure,
  // which had only ever been an extrapolation from a developer machine, and the
  // cheapest way to have it is for every job log to state it. Printed whatever
  // the verdicts were: a red run is exactly when somebody wants to know whether
  // five minutes was enough.
  const slowest = slowestRun(timings);
  console.log(
    `Slowest runner invocation ${(slowest.ms / 1000).toFixed(1)}s ` +
      `(${slowest.id}, ${slowest.phase}), against a ${RUNNER_TIMEOUT_MS / 1000}s ceiling: ` +
      `${slowest.ms > 0 ? (RUNNER_TIMEOUT_MS / slowest.ms).toFixed(0) : 'no'}x margin.`
  );

  if (failed.length > 0) {
    console.error('\nEntries that did not report KILLED:');
    for (const result of failed) {
      const entry = entries.find((candidate) => candidate.id === result.id);
      console.error(`\n  ${result.id}: ${result.verdict}`);
      console.error(`    why the line matters: ${entry.why}`);
      // The project too: with two of them, a bare `src/x.test.ts` no longer says
      // which workspace it lives in.
      console.error(
        `    ${entry.file}  ->  ${projectDirFor(entry)}/${entry.spec}  "${entry.test}"`
      );
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
