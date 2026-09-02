/**
 * Survey CSV interrupt probe for cto/AdaptaLabs#11 - does a broken export
 * arrive as a broken download, or as a tidy short file?
 *
 * #11 IS A LAUNCH GATE AND THIS DOES NOT CLOSE IT. The gate needs a real study
 * with real responses behind the real ingress. What this removes is the reason
 * the gate was unrunnable: "the deployed instance has no data, so there is
 * nothing to interrupt". `seed` makes data, `probe` runs the check and prints a
 * verdict, `clean` takes the data away again.
 *
 * WHAT IS BEING PROVED. `writeSurveyCsv` DESTROYS the socket on every failure
 * path rather than ending it - a batch read that throws, a client stalled past
 * SURVEY_CSV_DRAIN_TIMEOUT_MS, the whole-export deadline, retry exhaustion.
 * Once the header row is written the status is 200 and cannot be taken back, so
 * a failure part-way through cannot become a 500; what it must not do is finish
 * tidily, because a short CSV that parses is a researcher computing a mean over
 * part of their data with nothing on the page saying so. The server side of
 * that is settled and tested. What no local test can see is the INGRESS: a
 * buffering proxy that turns a destroyed socket into a complete-looking
 * truncated file defeats the whole refusal design, silently, in production.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW TO RUN IT
 *
 * Locally, from the repository root, with the backend on :5000 and its
 * DATABASE_URL pointing at the same database:
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/adaptalabs_dev \
 *     npx tsx backend/probe/csv-interrupt.ts seed
 *
 *   npx tsx backend/probe/csv-interrupt.ts probe --target http://localhost:5000
 *
 *   DATABASE_URL=... npx tsx backend/probe/csv-interrupt.ts clean
 *
 * `probe` exits 0 only if every arm passed. It needs no database.
 *
 * Against playground, seeding needs a port-forward to that database (the guard
 * below only ever talks to localhost, deliberately - see assertSeedTargetSafe)
 * and the probe needs an admin cookie for an account that owns the seeded
 * opportunity:
 *
 *   npx tsx backend/probe/csv-interrupt.ts probe \
 *     --target https://adaptalabs.kubera-playground.adaptavist.net \
 *     --cookie "__Host-adaptalabs_session=<value from DevTools>"
 *
 * The cookie is NOT `connect.sid`: #11's description names the express-session
 * default, and index.ts renames it.
 *
 * THE NAME DIFFERS BY ENVIRONMENT, and copying the wrong one is an auth
 * failure the operator has to debug rather than a message the probe can give.
 * #97 added the `__Host-` prefix, and only where the cookie is actually
 * `Secure` - express-session refuses that prefix over http, so:
 *
 *   playground / production   `__Host-adaptalabs_session`
 *   local development         `adaptalabs_session`
 *
 * Copy the name DevTools shows you rather than the one written here. Whatever
 * you pass in `--cookie` is sent verbatim; the probe does not rewrite it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE THREE ARMS, and why the first one is the one that matters
 *
 *   control    A complete download, unthrottled. Must exit 0, must parse, and
 *              must hold exactly one row per seeded participant plus a header.
 *
 *              WITHOUT THIS EVERY OTHER ARM IS VACUOUS. "The transfer broke"
 *              passes just as well when the URL is wrong, the cookie has
 *              expired, the opportunity belongs to somebody else or the study
 *              collected nothing - which are the four ways this check actually
 *              goes wrong in practice. The control also supplies the byte count
 *              the other two are compared against, so a "broken" transfer that
 *              in fact delivered every byte is reported as inconclusive rather
 *              than as a pass.
 *
 *   interrupt  #11's own recipe: a throttled read cut off early, which is what
 *              a researcher who hits Cancel or closes the tab does. The client
 *              must report a broken transfer. Exit 0 with a parseable file is
 *              the finding, and the arm prints how many rows that file holds so
 *              the size of the lie is on the page.
 *
 *   stall      The arm that can see an ingress. A socket that reads NOTHING
 *              until well past SURVEY_CSV_DRAIN_TIMEOUT_MS, then reads whatever
 *              is there and looks at how the body ENDED.
 *
 *              A raw socket rather than curl, and the reason is a false finding
 *              this arm produced when it was curl. `--limit-rate 1 --max-time
 *              50` reported exit 28 at its own deadline, which the arm read as
 *              a buffering ingress - on loopback, where nothing sits in front
 *              at all. What actually happened is that a rate-limited curl
 *              CANNOT SEE the destruction promptly: the server stalled and
 *              destroyed the socket on time, and curl still had the ~840KB
 *              already in its own receive buffer to hand out at a byte a
 *              second, so it noticed nothing for another nine days' worth of
 *              trickle. A throttled client is the wrong instrument for a
 *              question about how a transfer ENDED.
 *
 *              What settles it is the TERMINATING 0-CHUNK. The response is
 *              chunked even under `Connection: close`, so a tidy ending has
 *              `0\r\n\r\n` on the end and a destroyed socket does not. Absent
 *              chunk means the destruction reached this client, which is a
 *              pass. Present chunk over a SHORT body is a complete-looking
 *              truncated file, which is the finding this whole gate exists for.
 *              Present chunk over the FULL body means the arm failed to create
 *              a stall and says so as inconclusive, rather than blaming an
 *              ingress for a buffer size.
 *
 *              An ending is only evidence about the SERVER when the connection
 *              itself ended. Our own read deadline expiring is not, and the two
 *              are reported separately - see StallEnding.
 *
 *              PROVEN TO FAIL BY NAME. Changing the `res.destroy()` at the end
 *              of `writeSurveyCsv` to `res.end()` - the one-line defect the
 *              whole design exists to prevent - turned this arm from PASS
 *              ("869122 of 3633701 bytes, no 0-chunk") to FAIL ("869122 of
 *              3633701 bytes, terminated with a 0-chunk"), with the other two
 *              arms unchanged. An absence-assertion nobody has watched fail is
 *              not evidence.
 *
 * NOTHING DOWNLOADED IS KEPT. Each body is counted and then unlinked, and the
 * scratch directory (which holds the session cookie) goes with it. What the
 * export contains is every answer a study collected.
 *
 * Every wait here is bounded, and the raw socket carries two bounds rather than
 * one - its own deadline, and a hard destroy. A probe that hangs fails without
 * a name, which is the one failure nobody can read.
 *
 * The guards are unit-tested in probe/__tests__/csv-interrupt-guards.test.ts,
 * which jest runs: a guard whose only proof is somebody having tried a bad URL
 * once by hand is a guard nobody will notice breaking.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';

import { Pool } from 'pg';

import { findAnswerValidityProblem } from '../../shared/firsthand/survey-answers';
import type { StudyStep } from '../../shared/firsthand/contract';
import { runtimeMutationSchema } from '../src/firsthand/runtime-records';
import { createSession } from '../src/firsthand/session-create';
import { loadParticipantSession } from '../src/firsthand/session-store';
import { applyRuntimeMutation } from '../src/firsthand/runtime-repository';
import { createStudy, getStudyById } from '../src/firsthand/studies-repository';
import { CSV_PARTICIPANT_BATCH } from '../src/firsthand/survey-results-repository';
import { SURVEY_CSV_DRAIN_TIMEOUT_MS } from '../src/firsthand/survey-csv-response';

// ── What the seed creates, all at fixed ids so `clean` can find it and a
// second `seed` does not double it. `csvprobe` is in every id and address so a
// human looking at a shared environment can tell at a glance what this is.

const STUDY_ID = 'study_csvprobe_11';
const OPPORTUNITY_ID = '0cc00011-0000-4000-8000-ffffffffffff';
const PARTICIPANT_ID_PREFIX = '0cc00011-0000-4000-8000-';
const PARTICIPANT_EMAIL_DOMAIN = 'csvprobe.invalid';
const DEFAULT_OWNER_EMAIL = 'admin@test.com';

/**
 * THREE BATCHES PLUS ONE, taken from the constant rather than written down.
 *
 * `CSV_PARTICIPANT_BATCH` decides how many participants `streamParticipants`
 * reads and holds at once, so an export below it never exercises the batch loop
 * at all - no second `readBatch`, no `signal.throwIfAborted()` between batches,
 * none of the machinery #11 is about. The `+ 1` puts a fourth, part-full batch
 * on the end, because an exact multiple cannot tell a loop that stops one batch
 * early from one that does not.
 *
 * NO TEST HERE PINNING THE 100, because one already exists and duplicating it
 * would be a second thing to keep in step:
 * survey-csv-batch-scope-postgres.test.ts asserts the batch shapes as the
 * literals 100 and 50 against a 150-participant fixture, with a note saying
 * why they are literals. If the constant moves, that fails first.
 */
const PARTICIPANT_COUNT = CSV_PARTICIPANT_BATCH * 3 + 1;

/**
 * How many characters each free-text answer carries.
 *
 * Sized against the CLIENT's receive buffer, not against readability. The
 * `stall` arm depends on the server's write actually blocking, and a body that
 * fits in the buffer chain of a client which has stopped reading is flushed
 * anyway - the drain timeout never fires, the socket is never destroyed, and
 * the arm has measured nothing.
 *
 * MEASURED, not guessed: on macOS loopback the write stalled after 839,438
 * bytes, and three of these per participant over PARTICIPANT_COUNT participants
 * is 3,633,701 bytes of CSV - about four times the margin. Any environment with
 * a fatter buffer chain is caught rather than mis-reported, because the arm
 * reports a full tidy body as INCONCLUSIVE and names this constant.
 *
 * Alphanumeric and space only, on purpose: no comma, quote or newline, so the
 * exported file has exactly one physical line per row and the row count both
 * arms compare is a `split('\n')` rather than a CSV parser.
 */
const ANSWER_CHARS = 4_000;

const LONG_ANSWER = 'sample survey answer text '.repeat(
  Math.ceil(ANSWER_CHARS / 26)
).slice(0, ANSWER_CHARS);

const CHOICE_OPTIONS = ['Daily', 'Weekly', 'Monthly', 'Never'];

/**
 * A survey a researcher could plausibly have written, and deliberately one of
 * every answerable shape. The CSV emitter formats a rating, a single choice and
 * free text differently, so a seed of five open_text questions would leave the
 * widest columns in the file untested by the control's row count.
 */
const STEPS: StudyStep[] = [
  { step_id: 'q1', order: 1, type: 'open_text', prompt: 'What were you trying to do?' },
  { step_id: 'q2', order: 2, type: 'open_text', prompt: 'What got in the way?' },
  { step_id: 'q3', order: 3, type: 'open_text', prompt: 'What would you change?' },
  { step_id: 'q4', order: 4, type: 'single_choice', prompt: 'How often do you use it?', options: CHOICE_OPTIONS },
  // `scale_max` and no minimum: `ratingBounds` fixes the floor of a rating at
  // 1, and there is no `scale_min` in stepConfigSchema to state otherwise.
  { step_id: 'q5', order: 5, type: 'rating', prompt: 'How easy was it?', config: { scale_max: 5 } }
];

// ── Bounds. Every one of these is a ceiling on a wait, not a target.

/** Generous: the control must be allowed to finish even on a slow link. */
const CONTROL_MAX_SECONDS = 180;

/** #11's own `--max-time 2`. Short enough to land mid-transfer. */
const INTERRUPT_MAX_SECONDS = 2;

/**
 * Throttle for the `interrupt` arm.
 *
 * INTERRUPT_MAX_SECONDS alone is not an interrupt on a loopback socket: a few
 * megabytes over localhost completes in well under two seconds and the arm
 * measures a successful download. This is the same lever as #11's "throttle to
 * Slow 3G" step, and the arm still refuses to call a completed transfer a pass
 * - see the byte-count comparison against the control.
 */
const INTERRUPT_RATE = '64k';

/**
 * How long the `stall` arm reads nothing at all, comfortably PAST the server's
 * drain timeout.
 *
 * The whole verdict rests on this ordering: read again too early and a healthy
 * server has not yet decided to destroy anything, and the arm reports a tidy
 * ending it created itself. Derived from the constant so it cannot drift.
 */
const STALL_SILENCE_MS = SURVEY_CSV_DRAIN_TIMEOUT_MS + 10_000;

/** How long the `stall` arm then reads for before giving up on an ending. */
const STALL_READ_MS = 20_000;

/** Long enough for the previous arm's socket to close and its results-read permit to come back. */
const ARM_SETTLE_MS = 2_000;

/** Bound on the cookie fetch, the only other thing that waits. */
const LOGIN_MAX_SECONDS = 15;

// ── curl exit codes named, because the verdict turns on which one arrived.
const CURL_OK = 0;
/** transfer closed with outstanding read data remaining - the server hung up mid-body. */
const CURL_PARTIAL_TRANSFER = 18;
/** operation timed out - the CLIENT gave up; nothing had terminated the transfer. */
const CURL_TIMEOUT = 28;
/** failure receiving network data - a destroyed socket can also surface here. */
const CURL_RECV_ERROR = 56;

type Verdict = 'pass' | 'fail' | 'inconclusive';

type ArmResult = {
  name: string;
  verdict: Verdict;
  /**
   * What the client actually observed. A curl exit code for the two curl arms,
   * and whether the body terminated for the raw-socket one - a single number
   * column here would have printed a socket outcome as if it were a curl code.
   */
  signal: string;
  bytes: number;
  rows: number;
  elapsedMs: number;
  note: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Databases this may write to.
 *
 * A seeding script that can be pointed at a real instance full of real
 * participants is a liability, and the shape of a seed script is the shape of a
 * paste into the wrong terminal. Two conditions, both required: the connection
 * must be to loopback, and the database must be named. Naming it is what makes
 * a port-forward safe - a forward to production RDS is also localhost, so the
 * host check alone proves nothing.
 *
 * ponytail: an allowlist of two names plus --confirm-db, not a role or
 * ownership check against the live database
 *   -> if this ever needs to seed something other than a scratch database,
 *      make it read a marker row the environment's own bootstrap writes
 */
export const SEEDABLE_DATABASES = ['adaptalabs_dev', 'firsthand_test'];

/**
 * NO `::1`, DELIBERATELY, and this is a refusal rather than an oversight.
 *
 * An IPv6 literal keeps its brackets everywhere that matters here:
 * `new URL('http://[::1]/').hostname` is `"[::1]"`, and `pg-connection-string`
 * parses `postgres://u:p@[::1]:5432/db` to host `"[::1]"` too. Neither `pg` nor
 * `net.connect` will dial that string - both measured, both `ENOTFOUND [::1]`,
 * which is name resolution failing on a literal rather than a connection being
 * refused.
 *
 * So `::1` was admitted by both guards and worked in neither: `seed` and
 * `clean` passed the guard and then died, and the probe's raw-socket arm would
 * have done the same. A guard that says yes to something that then fails is
 * worse than one that says no, because the operator debugs the wrong thing.
 * `localhost` still reaches IPv6 loopback wherever the resolver prefers it.
 *
 * ponytail: refuse the literal rather than rewrite the caller's connection
 * string to strip the brackets
 *   -> if an IPv6-only environment ever needs to seed, normalise in ONE place
 *      and pass the normalised string to both `new Pool` and the raw socket;
 *      doing it in the guard alone would fix the check and not the command
 */
const LOOPBACK = ['localhost', '127.0.0.1'];

/**
 * Connection-string query parameters that silently redirect the connection.
 *
 * MEASURED against the installed `pg-connection-string`, which is what
 * `pg.Pool({ connectionString })` parses with:
 *
 *   postgres://u:x@localhost:5432/db?host=192.168.1.130  -> host 192.168.1.130
 *   postgres://u:x@localhost:5432/db?port=9999           -> port 9999
 *   postgres://u:x@localhost:5432/db?hostaddr=10.0.0.5   -> hostaddr 10.0.0.5
 *   postgres://u:x@localhost:5432/db?dbname=other        -> database db
 *
 * So the authority half of the URL is ADVISORY and `new URL(...).hostname` is
 * not the address pg will dial. Reading the hostname alone let
 * `...@localhost/adaptalabs_dev?host=192.168.1.130` through this guard and
 * connect to a remote address for real - which is exactly the
 * port-forward-to-production-RDS case the loopback rule exists to stop, and
 * `clean` issues DELETEs through the same guard.
 *
 * `hostaddr` IS LATENT RATHER THAN LIVE, and it is listed anyway. A review gate
 * measured that node-postgres parses it into the config and then never dials
 * it - an unroutable TEST-NET address in `hostaddr` still reached the local
 * container. libpq, whose connection-string syntax this imitates, DOES use it
 * as the address to connect to with `host` kept only for TLS and
 * authentication. So it is one npm release away from being the same bypass as
 * `host`, in a file nobody will re-audit for it. One word here, against a
 * silent hole later.
 *
 * REFUSED OUTRIGHT rather than parsed and re-checked. Nothing here legitimately
 * needs any of them, and refusing an unrecognised shape is the same fail-closed
 * instinct as the rest of this file. That instinct is also what made the guard
 * survive a gate's eleven smuggling shapes, percent-encoded keys included:
 * `?%68ost=` decodes and redirects, and a guard enumerating what the parser
 * accepts would have had to know that. This one refuses on the DECODED key
 * `searchParams` hands it, so its view is a superset of the parser's redirect
 * surface rather than a guess at it.
 *
 * Matched case-insensitively even though only the lowercase spellings override
 * today: a parser that starts folding case is a silent regression, and refusing
 * `?HOST=` costs nothing.
 */
const SMUGGLING_PARAMS = ['host', 'hostaddr', 'port'];

export function assertSeedTargetSafe(databaseUrl: string, confirmDb: string | null): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a URL.');
  }

  for (const [key] of parsed.searchParams) {
    if (SMUGGLING_PARAMS.includes(key.toLowerCase())) {
      throw new Error(
        // Deliberately says "can redirect" rather than "does": `host` and
        // `port` demonstrably override the authority today, `hostaddr` is
        // parsed and currently ignored by node-postgres. One message for a
        // class of parameter, and it must not claim a behaviour one member of
        // that class does not have.
        `Refusing a connection string carrying a "${key}" query parameter. ` +
          "pg's parser reads it out of the query string, so it can redirect " +
          'this connection somewhere the loopback check below cannot see. ' +
          'Put the address in the URL itself.'
      );
    }
  }

  const host = parsed.hostname;
  if (!LOOPBACK.includes(host)) {
    throw new Error(
      `Refusing to seed ${host}. This only ever writes to a loopback address; ` +
        'port-forward the database you mean to seed and point DATABASE_URL at localhost.'
    );
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error('DATABASE_URL names no database.');
  }

  if (/prod/i.test(database) || /prod/i.test(parsed.port)) {
    throw new Error(`Refusing to seed a database called "${database}".`);
  }

  const permitted = confirmDb ? [confirmDb] : SEEDABLE_DATABASES;
  if (!permitted.includes(database)) {
    throw new Error(
      `Refusing to seed "${database}". Expected one of ${SEEDABLE_DATABASES.join(', ')}. ` +
        `If that is genuinely the scratch database you meant, pass --confirm-db ${database}.`
    );
  }

  return database;
}

/**
 * The only non-local deployment this may be pointed at.
 *
 * A SUFFIX, not a substring. `host.includes('kubera-playground')` admitted
 * `kubera-playground.evil.example`, and the probe then sent the operator's
 * session cookie to it - a credential handed to an attacker-chosen host by a
 * guard written to protect data. Named by role rather than by string: the
 * cookie is `__Host-`prefixed against playground and bare locally (#97), and
 * the guard protects it under either name.
 */
const PLAYGROUND_SUFFIX = '.kubera-playground.adaptavist.net';

/**
 * Hosts the probe may download an export from.
 *
 * The probe only reads, but what it reads is every answer a study collected,
 * and it carries a live admin session cookie to do so. Pointing that at a host
 * somebody else controls is both a credential leak and a data incident.
 */
export function assertProbeTargetSafe(target: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`--target is not a URL: ${target}`);
  }

  const host = parsed.hostname;
  const permitted = LOOPBACK.includes(host) || host.endsWith(PLAYGROUND_SUFFIX);

  if (!permitted) {
    throw new Error(
      `Refusing to probe ${host}. Permitted: localhost, or a host under ` +
        `${PLAYGROUND_SUFFIX}. This downloads every answer a study has collected, ` +
        'and sends an admin session cookie to do it.'
    );
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// seed
// ─────────────────────────────────────────────────────────────────────────────

const participantId = (index: number): string =>
  `${PARTICIPANT_ID_PREFIX}${index.toString(16).padStart(12, '0')}`;

/**
 * The two things that are direct SQL, and why.
 *
 * `users` has NO creation route at all: authentication is OIDC, and the
 * demo-login shortcuts are four fixed identities gated on
 * NODE_ENV === 'development'. There is no product path that mints the several
 * hundred distinct accounts a multi-batch export needs, so this is the one
 * place where the seed cannot go through a route the product uses.
 *
 * `opportunities` has a real route, and it needs an authenticated admin
 * cookie - which for the same reason cannot be scripted here. The row is
 * written with the columns the export actually reads: the id it is addressed
 * by, the owner the results gate authorises against, and `firsthand_study_id`.
 *
 * Everything that produces a SESSION or an ANSWER goes through the code the
 * participant API runs - see seedParticipants. That is the half where a
 * wrongly-shaped row would make the export unrepresentative.
 */
async function seedOwnerAndOpportunity(pool: Pool, ownerEmail: string): Promise<string> {
  const owner = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [ownerEmail]
  );

  const ownerId = owner.rows[0]?.id;
  if (!ownerId) {
    throw new Error(
      `No user with email ${ownerEmail}. Pass --owner <email> naming an admin who should own the seeded opportunity.`
    );
  }

  const values: unknown[] = [];
  const rows: string[] = [];
  for (let index = 1; index <= PARTICIPANT_COUNT; index += 1) {
    const base = values.length;
    rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, 'csvprobe', 'Seeded participant', 'employee')`);
    values.push(
      participantId(index),
      `csvprobe-${index.toString().padStart(4, '0')}@${PARTICIPANT_EMAIL_DOMAIN}`,
      `CSV Probe Participant ${index}`
    );
  }

  await pool.query(
    `INSERT INTO users (id, email, name, business_unit, role_title, role)
     VALUES ${rows.join(', ')}
     ON CONFLICT (id) DO NOTHING`,
    values
  );

  await pool.query(
    `INSERT INTO opportunities
       (id, type, title, purpose_one_liner, default_duration_minutes, status,
        owner_user_id, participant_type_required, firsthand_study_id, delivery_mode)
     VALUES ($1, 'survey', 'csvprobe - CSV interrupt probe (#11)',
             'Seeded by backend/probe/csv-interrupt.ts. Safe to delete.',
             5, 'published', $2, 'internal', $3, 'native')
     ON CONFLICT (id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id,
                                    firsthand_study_id = EXCLUDED.firsthand_study_id`,
    [OPPORTUNITY_ID, ownerId, STUDY_ID]
  );

  return ownerId;
}

async function seedStudy(ownerId: string): Promise<void> {
  if (await getStudyById(STUDY_ID)) return;

  await createStudy({
    id: STUDY_ID,
    title: 'csvprobe - CSV interrupt probe (#11)',
    intro_text: 'Seeded by backend/probe/csv-interrupt.ts. Safe to delete.',
    consent_text: 'Seeded data. No real participant answered any of this.',
    kind: 'survey',
    status: 'launched',
    owner_user_id: ownerId,
    steps: STEPS
  });
}

const answerFor = (step: StudyStep, index: number) => {
  switch (step.type) {
    case 'single_choice':
      return { selectedOption: CHOICE_OPTIONS[index % CHOICE_OPTIONS.length] };
    case 'rating':
      return { rating: (index % 5) + 1 };
    default:
      return { text: `${LONG_ANSWER} p${index}` };
  }
};

/**
 * One session and one answer per question, per participant, through the code
 * the participant runtime route runs.
 *
 * `createSession` is what `POST /api/opportunities/:id/survey-session` calls.
 * `loadParticipantSession` is what `bindParticipantSession` calls.
 * `runtimeMutationSchema` and `findAnswerValidityProblem` are the two checks
 * `POST /api/firsthand/session/:token/runtime` runs before saving, in that
 * order. `applyRuntimeMutation` is the save.
 *
 * What is skipped is `requireAuth` and the token-to-user binding, because there
 * is no way to hold several hundred authenticated express sessions without an
 * identity provider - the session store is in-process memory, so a cookie
 * cannot be forged from outside either. Nothing that decides the SHAPE of a
 * stored answer is skipped: an answer this seed can write is an answer the
 * participant UI could have submitted, and one it cannot write would 422 on
 * the real route too.
 *
 * SEQUENTIAL. Concurrency here would queue on the 5-connection runtime pool's
 * admission gate and turn a slow seed into a flaky one, and the seed is not
 * the thing being measured.
 *
 * ponytail: distinct savedAt per participant, one millisecond apart
 *   -> the export orders participants by MIN(saved_at), and ties there make the
 *      row ORDER non-deterministic between runs; if this ever needs to seed
 *      more participants than there are milliseconds to spare, order by id
 */
async function seedParticipants(pool: Pool): Promise<number> {
  // Asked, not assumed. Resuming from a count would work only while the
  // existing participants happen to be indices 1..N: delete one from the
  // middle of an interrupted seed and a count-based resume mints a SECOND
  // session for a participant who already has one, which the real mint route
  // refuses outright and which would double that respondent in the export.
  const existing = await pool.query<{ participant_id: string }>(
    'SELECT participant_id FROM firsthand.runtime_sessions WHERE opportunity_id = $1',
    [OPPORTUNITY_ID]
  );
  const seeded = new Set(existing.rows.map((row) => row.participant_id));

  const startedAt = Date.now() - PARTICIPANT_COUNT * STEPS.length;
  let created = 0;

  for (let index = 1; index <= PARTICIPANT_COUNT; index += 1) {
    if (seeded.has(participantId(index))) continue;

    const created_session = await createSession({
      studyId: STUDY_ID,
      participant: {
        participant_id: participantId(index),
        display_name: `CSV Probe Participant ${index}`,
        email: `csvprobe-${index.toString().padStart(4, '0')}@${PARTICIPANT_EMAIL_DOMAIN}`
      },
      opportunityId: OPPORTUNITY_ID,
      returnUrl: 'http://localhost:3000/'
    });

    if (!created_session.ok) {
      throw new Error(`createSession refused participant ${index}: ${created_session.error}`);
    }

    const loaded = await loadParticipantSession(created_session.session.session_token);
    if (loaded.kind !== 'ok') {
      throw new Error(`loadParticipantSession refused participant ${index}: ${loaded.kind}`);
    }

    for (const [stepIndex, step] of STEPS.entries()) {
      const mutation = runtimeMutationSchema.parse({
        type: 'response',
        stepId: step.step_id,
        stepType: step.type,
        responsePayload: answerFor(step, index),
        savedAt: new Date(startedAt + index * STEPS.length + stepIndex).toISOString()
      });

      if (mutation.type !== 'response') {
        throw new Error('the seed built a mutation that is not a response');
      }

      const problem = findAnswerValidityProblem(step, mutation.responsePayload);
      if (problem) {
        throw new Error(
          `the seed built an answer the participant API would refuse: ${problem.code}`
        );
      }

      await applyRuntimeMutation(loaded.payload, mutation);
    }

    created += 1;
    if (created % 50 === 0) {
      process.stdout.write(`  seeded ${created} of ${PARTICIPANT_COUNT - seeded.size}\n`);
    }
  }

  return created;
}

/** MEASURED, by asking the database, not derived from the loop bound. */
async function countSeeded(pool: Pool): Promise<{ participants: number; answers: number }> {
  const result = await pool.query<{ participants: string; answers: string }>(
    `SELECT COUNT(DISTINCT r.session_id) AS participants, COUNT(*) AS answers
       FROM firsthand.participant_responses AS r
       JOIN firsthand.runtime_sessions AS s ON s.session_id = r.session_id
      WHERE s.opportunity_id = $1`,
    [OPPORTUNITY_ID]
  );

  return {
    participants: Number(result.rows[0]?.participants ?? 0),
    answers: Number(result.rows[0]?.answers ?? 0)
  };
}

async function runSeed(databaseUrl: string, ownerEmail: string, confirmDb: string | null) {
  const database = assertSeedTargetSafe(databaseUrl, confirmDb);
  console.log(`seed: database ${database}, ${PARTICIPANT_COUNT} participants ` +
    `(${CSV_PARTICIPANT_BATCH} per export batch, so ${Math.ceil(PARTICIPANT_COUNT / CSV_PARTICIPANT_BATCH)} batches)`);

  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });

  try {
    const before = await countSeeded(pool);
    if (before.participants >= PARTICIPANT_COUNT) {
      console.log(`seed: already ${before.participants} participants and ${before.answers} answers; nothing to do`);
      console.log(`seed: opportunity ${OPPORTUNITY_ID}`);
      return;
    }

    const ownerId = await seedOwnerAndOpportunity(pool, ownerEmail);
    await seedStudy(ownerId);
    const created = await seedParticipants(pool);
    const after = await countSeeded(pool);

    console.log(`seed: created ${created} sessions this run`);
    console.log(`seed: counted ${after.participants} participants and ${after.answers} answers in the database`);
    console.log(`seed: opportunity ${OPPORTUNITY_ID}, owner ${ownerEmail}`);
    console.log('seed: remove it all with `clean`');
  } finally {
    await pool.end();
  }
}

async function runClean(databaseUrl: string, confirmDb: string | null) {
  const database = assertSeedTargetSafe(databaseUrl, confirmDb);
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });

  try {
    const before = await countSeeded(pool);

    // Answers and events hang off sessions, sessions off the opportunity id as
    // plain TEXT with no foreign key, so those three come first and in that
    // order. `opportunities` then cascades to opportunity_clicks and
    // opportunity_session_events, and `users` to the gamification rows. Every
    // statement is scoped by a fixed id or the csvprobe address domain, so
    // nothing here can reach a row this script did not write.
    await pool.query(
      `DELETE FROM firsthand.participant_responses
        WHERE session_id IN (SELECT session_id FROM firsthand.runtime_sessions WHERE opportunity_id = $1)`,
      [OPPORTUNITY_ID]
    );
    await pool.query(
      `DELETE FROM firsthand.runtime_events
        WHERE session_id IN (SELECT session_id FROM firsthand.runtime_sessions WHERE opportunity_id = $1)`,
      [OPPORTUNITY_ID]
    );
    await pool.query('DELETE FROM firsthand.runtime_sessions WHERE opportunity_id = $1', [OPPORTUNITY_ID]);
    await pool.query('DELETE FROM opportunities WHERE id = $1', [OPPORTUNITY_ID]);
    await pool.query('DELETE FROM firsthand.study_steps WHERE study_id = $1', [STUDY_ID]);
    await pool.query('DELETE FROM firsthand.studies WHERE id = $1', [STUDY_ID]);
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`csvprobe-%@${PARTICIPANT_EMAIL_DOMAIN}`]);

    const after = await countSeeded(pool);
    console.log(`clean: database ${database}; ${before.participants} participants and ${before.answers} answers before, ${after.participants} and ${after.answers} after`);

    if (after.participants !== 0 || after.answers !== 0) {
      throw new Error('clean left rows behind');
    }
  } finally {
    await pool.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// probe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches an admin cookie from a demo-login route.
 *
 * Local convenience only, and it is why the local run needs no --cookie. These
 * routes exist only when NODE_ENV is development, so against playground this
 * fails and the operator supplies --cookie from DevTools instead.
 */
function fetchLocalAdminCookie(target: URL, jar: string): string | null {
  const result = spawnSync(
    'curl',
    [
      '--silent', '--show-error', '--output', '/dev/null',
      '--max-time', String(LOGIN_MAX_SECONDS),
      '--cookie-jar', jar,
      new URL('/api/auth/admin-login', target).toString()
    ],
    { encoding: 'utf8', timeout: (LOGIN_MAX_SECONDS + 5) * 1_000 }
  );

  if (result.status !== 0) return null;

  try {
    // Netscape cookie jar: domain, includeSubdomains, path, secure, expires,
    // name, value, tab separated. Read out as a header value rather than
    // handed to curl as a jar, because the `stall` arm is a raw socket and
    // needs the same credential in the same form.
    //
    // THE BARE NAME IS CORRECT HERE, and #105 asked for the opposite. This
    // parser reads a jar minted by `/api/auth/admin-login` immediately above -
    // a route that exists only when NODE_ENV is development, which is exactly
    // the environment where #97 does NOT apply the `__Host-` prefix, because
    // express-session refuses `Secure` over http. Against playground this
    // function is not even reached: `probeArms` resolves the credential as
    // `cookie ?? fetchLocalAdminCookie(...)`, so an operator who passed
    // `--cookie` never gets here.
    //
    // Accepting `__Host-adaptalabs_session` as well would therefore be a
    // branch nothing can execute. The environment difference is real and it
    // lives in the `--cookie` usage text at the top of this file, which is
    // where the operator meets it.
    for (const line of readFileSync(jar, 'utf8').split('\n')) {
      const fields = line.split('\t');
      if (fields.length >= 7 && fields[5] === 'adaptalabs_session') {
        return `adaptalabs_session=${fields[6]}`;
      }
    }
  } catch {
    return null;
  }

  return null;
}

type ArmSpec = {
  extra: string[];
  maxSeconds: number;
};

function runCurl(url: string, cookieArgs: string[], out: string, arm: ArmSpec) {
  const startedAt = Date.now();
  const result = spawnSync(
    'curl',
    [
      '--silent', '--show-error',
      '--output', out,
      '--write-out', '%{http_code}',
      '--max-time', String(arm.maxSeconds),
      ...arm.extra,
      ...cookieArgs,
      url
    ],
    {
      encoding: 'utf8',
      // The outer bound. `--max-time` is curl's promise and this is the one
      // that holds if curl ignores it: without it a wedged child turns the
      // whole probe into a CI job timeout with no named failing arm.
      timeout: (arm.maxSeconds + 15) * 1_000
    }
  );

  let bytes = 0;
  let rows = 0;
  try {
    bytes = statSync(out).size;
    if (bytes > 0) {
      const lines = readFileSync(out, 'utf8').split('\n');
      // Trailing newline produces an empty last element. Every answer this
      // seed writes is free of newlines, quotes and commas, so a physical line
      // is a row - see ANSWER_CHARS.
      rows = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    }
  } catch {
    bytes = 0;
  } finally {
    // DELETED AS SOON AS IT IS COUNTED. The body is every answer the study
    // collected, and against playground those are real people's. An earlier
    // version left it on disk "as evidence", which is the exact outcome
    // assertProbeTargetSafe's own docblock calls a data incident. The
    // measurements below ARE the evidence; the bytes are not.
    rmSync(out, { force: true });
  }

  return {
    exitCode: result.status ?? -1,
    httpCode: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    elapsedMs: Date.now() - startedAt,
    bytes,
    rows
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * WHY THIS IS NOT A BOOLEAN. An earlier version collapsed "the connection
 * ended" and "our own read deadline expired" into one `terminated: false`, and
 * reported both as a pass whose note said "the drain timeout destroyed the
 * socket and the destruction reached this client". Against a server that sent
 * headers and then went silent forever, nothing was destroyed and nothing
 * reached anybody - the arm asserted a mechanism it had not observed. Only
 * `connection` is evidence about the server.
 */
type StallEnding = 'connection' | 'read-deadline' | 'connect-deadline';

type StallOutcome = {
  status: string;
  /** Bytes of CSV, with the chunk framing removed. */
  bodyBytes: number;
  /** Whether the body ended with the terminating 0-chunk. */
  terminated: boolean;
  endedBy: StallEnding;
  elapsedMs: number;
  error: string;
};

/**
 * Sums the chunk sizes of a chunked body and says whether it terminated.
 *
 * Only the sizes are needed - the verdict turns on how many CSV bytes arrived
 * and on whether the final zero-length chunk is there - so the payload is
 * skipped rather than concatenated. A body that runs out mid-chunk is exactly
 * the destroyed case and returns `terminated: false`.
 *
 * ponytail: no trailer parsing, no extension parsing
 *   -> writeSurveyCsv sends neither; if a proxy ever adds one, the size line
 *      split on ';' below is where to start
 */
function measureChunkedBody(body: Buffer): { bytes: number; terminated: boolean } {
  let cursor = 0;
  let bytes = 0;

  while (cursor < body.length) {
    const lineEnd = body.indexOf('\r\n', cursor);
    if (lineEnd === -1) return { bytes, terminated: false };

    const sizeLine = body.subarray(cursor, lineEnd).toString('ascii').split(';')[0]!.trim();
    const size = Number.parseInt(sizeLine, 16);
    if (!Number.isFinite(size)) return { bytes, terminated: false };

    if (size === 0) return { bytes, terminated: true };

    // +2 for the CRLF that closes the chunk. Short of that and the transfer
    // was cut off inside this chunk.
    const next = lineEnd + 2 + size + 2;
    if (next > body.length) return { bytes: bytes + (body.length - lineEnd - 2), terminated: false };

    bytes += size;
    cursor = next;
  }

  return { bytes, terminated: false };
}

/**
 * A client that reads NOTHING until the server's drain timeout has had time to
 * fire, then reads whatever is there.
 *
 * A socket with no reader is what stalls the server's write: its receive buffer
 * fills, the TCP window closes, and `res.write` stops draining. `pause()` is
 * explicit rather than relied upon - a socket with no 'data' listener is paused
 * anyway, and a later reader adding one for debugging would silently end the
 * stall.
 */
function stallRequest(target: URL, path: string, cookieHeader: string): Promise<StallOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const chunks: Buffer[] = [];
    let settled = false;
    let resumeTimer: NodeJS.Timeout | undefined;
    let readTimer: NodeJS.Timeout | undefined;

    const socket: Socket =
      target.protocol === 'https:'
        ? tlsConnect({ host: target.hostname, port, servername: target.hostname })
        : netConnect({ host: target.hostname, port });

    const finish = (endedBy: StallEnding, error: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(resumeTimer);
      clearTimeout(readTimer);
      socket.destroy();

      const raw = Buffer.concat(chunks);
      const headerEnd = raw.indexOf('\r\n\r\n');
      const status = headerEnd === -1
        ? ''
        : (raw.subarray(0, raw.indexOf('\r\n')).toString('ascii').split(' ')[1] ?? '');
      const measured = headerEnd === -1
        ? { bytes: 0, terminated: false }
        : measureChunkedBody(raw.subarray(headerEnd + 4));

      resolve({
        status,
        bodyBytes: measured.bytes,
        terminated: measured.terminated,
        endedBy,
        elapsedMs: Date.now() - startedAt,
        error
      });
    };

    // A reset from the far end is the connection ending, not a deadline of
    // ours - it is evidence about the server exactly as a clean FIN is.
    socket.on('error', (error: Error) => finish('connection', error.message));
    socket.on('end', () => finish('connection', 'socket ended'));
    socket.on('close', () => finish('connection', 'socket closed'));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.pause();

    socket.on(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${target.host}\r\n` +
          `Cookie: ${cookieHeader}\r\n` +
          'Accept-Encoding: identity\r\n' +
          'Connection: close\r\n\r\n'
      );

      // The silence. Nothing is read while this runs, which is what makes the
      // server's write stall.
      resumeTimer = setTimeout(() => {
        socket.resume();
        // The second bound. Without it a server that neither ends nor closes
        // leaves this promise unsettled and the probe hangs with no named arm.
        readTimer = setTimeout(
          () => finish('read-deadline', `no ending within ${STALL_READ_MS}ms of reading`),
          STALL_READ_MS
        );
      }, STALL_SILENCE_MS);
    });

    // The outer bound, in case 'connect' never fires at all.
    setTimeout(
      () => finish('connect-deadline', 'connect deadline reached'),
      STALL_SILENCE_MS + STALL_READ_MS + 15_000
    ).unref();
  });
}

/**
 * Wrapper for the one job of taking the scratch directory away again.
 *
 * `runCurl` unlinks each downloaded body as soon as it has counted it, so the
 * only thing left in here is the cookie jar - an admin session credential
 * sitting in a world-readable temp directory. `finally`, so a throw takes it
 * with it too.
 */
async function runProbe(target: URL, cookie: string | null, expectedRows: number) {
  const workDir = mkdtempSync(join(tmpdir(), 'csvprobe-'));
  try {
    return await probeArms(target, cookie, expectedRows, workDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function probeArms(
  target: URL,
  cookie: string | null,
  expectedRows: number,
  workDir: string
) {
  const cookieJar = join(workDir, 'cookies.txt');

  const cookieHeader = cookie ?? fetchLocalAdminCookie(target, cookieJar);
  if (!cookieHeader) {
    throw new Error(
      'No admin session. Pass --cookie "<name>=<value>" taken from DevTools for an ' +
        'account that owns the seeded opportunity. The name is ' +
        '__Host-adaptalabs_session against playground and adaptalabs_session locally.'
    );
  }
  if (!cookie) {
    console.log('probe: signed in via /api/auth/admin-login (development only)');
  }
  const cookieArgs = ['--cookie', cookieHeader];

  const path = `/api/opportunities/${OPPORTUNITY_ID}/survey-results.csv`;
  const url = new URL(path, target).toString();

  console.log(`probe: ${url}`);
  console.log(`probe: expecting ${expectedRows} rows (1 header + ${expectedRows - 1} participants)`);

  const results: ArmResult[] = [];

  // ── control. Runs FIRST because the other two are compared against it.
  const control = runCurl(url, cookieArgs, join(workDir, 'control.csv'), {
    extra: [],
    maxSeconds: CONTROL_MAX_SECONDS
  });

  const controlOk =
    control.exitCode === CURL_OK &&
    control.httpCode === '200' &&
    control.rows === expectedRows;

  results.push({
    name: 'control  complete download',
    verdict: controlOk ? 'pass' : 'fail',
    signal: `curl ${control.exitCode}`,
    bytes: control.bytes,
    rows: control.rows,
    elapsedMs: control.elapsedMs,
    note: controlOk
      ? `HTTP 200, parsed, ${control.rows} rows as expected`
      : `HTTP ${control.httpCode || '-'}, ${control.rows} rows, expected ${expectedRows}. ` +
        `${control.stderr || 'The URL, the cookie, the owner or the seed is wrong; the other arms mean nothing until this passes.'}`
  });

  if (!controlOk) {
    report(results);
    return 1;
  }

  await sleep(ARM_SETTLE_MS);

  // ── interrupt. #11's own check.
  const interrupt = runCurl(url, cookieArgs, join(workDir, 'interrupt.csv'), {
    extra: ['--limit-rate', INTERRUPT_RATE],
    maxSeconds: INTERRUPT_MAX_SECONDS
  });

  let interruptVerdict: Verdict;
  let interruptNote: string;
  if (interrupt.bytes >= control.bytes) {
    // NOT a pass. A nonzero exit over a body that arrived in full is the client
    // complaining about its own deadline after the fact, and it would report
    // "the transfer broke" on an export too small to interrupt at all.
    interruptVerdict = 'inconclusive';
    interruptNote =
      `the export completed within ${INTERRUPT_MAX_SECONDS}s at ${INTERRUPT_RATE} ` +
      `(${interrupt.bytes} of ${control.bytes} bytes); nothing was interrupted`;
  } else if (interrupt.exitCode === CURL_OK) {
    interruptVerdict = 'fail';
    interruptNote =
      `THE FINDING. curl exited 0 on a truncated body: ${interrupt.bytes} of ` +
      `${control.bytes} bytes, ${interrupt.rows} of ${control.rows} rows, and it parsed. ` +
      'A researcher would compute a mean over part of their data with nothing saying so.';
  } else {
    interruptVerdict = 'pass';
    interruptNote =
      `curl ${interrupt.exitCode} (${curlName(interrupt.exitCode)}) on ${interrupt.bytes} of ` +
      `${control.bytes} bytes: the client knows the download is broken. The file it wrote held ` +
      `${interrupt.rows} of ${control.rows} rows and would have parsed, which is why the exit code ` +
      'is the whole guarantee. (Counted, then deleted - see runCurl.)';
  }

  results.push({
    name: 'interrupt  cancelled mid-transfer',
    verdict: interruptVerdict,
    signal: `curl ${interrupt.exitCode}`,
    bytes: interrupt.bytes,
    rows: interrupt.rows,
    elapsedMs: interrupt.elapsedMs,
    note: interruptNote
  });

  await sleep(ARM_SETTLE_MS);

  // ── stall. The arm that can see a buffering ingress.
  console.log(`probe: stalling for ${STALL_SILENCE_MS}ms, past the ${SURVEY_CSV_DRAIN_TIMEOUT_MS}ms drain timeout`);
  const stall = await stallRequest(target, path, cookieHeader);

  let stallVerdict: Verdict;
  let stallNote: string;
  if (stall.status !== '200') {
    stallVerdict = 'inconclusive';
    stallNote =
      `the server answered ${stall.status || 'nothing'} rather than 200 ` +
      `(${stall.error || 'no error'}), so no transfer was stalled. A 503 here is the ` +
      "previous arm's results-read permit not yet returned: raise ARM_SETTLE_MS.";
  } else if (!stall.terminated && stall.endedBy === 'connection') {
    stallVerdict = 'pass';
    stallNote =
      `${stall.bodyBytes} of ${control.bytes} bytes arrived, then the CONNECTION ENDED after ` +
      `${stall.elapsedMs}ms (${stall.error}) with no terminating 0-chunk. The drain timeout ` +
      'destroyed the socket and the destruction reached this client, which is what any HTTP ' +
      'client turns into a broken download.';
  } else if (!stall.terminated) {
    // NOT a pass, and this branch is why `endedBy` exists. Nothing ended: the
    // connection was still open and simply silent when our own deadline
    // expired. Calling that "the drain timeout destroyed the socket" - which an
    // earlier version did - asserts a mechanism this arm did not observe.
    stallVerdict = 'inconclusive';
    stallNote =
      `${stall.bodyBytes} of ${control.bytes} bytes arrived and then nothing: no terminating ` +
      `0-chunk AND no end of connection, ${stall.error}. Nothing was observed to destroy ` +
      'anything, so this says nothing either way about the refusal reaching a client. A server ' +
      'holding the socket open past its own drain timeout is itself worth a look.';
  } else if (stall.bodyBytes >= control.bytes) {
    // NOT a finding. The server had nothing to refuse: the whole body fitted in
    // the buffer chain between here and there, so no write ever stalled. This
    // is the case that made the curl version of this arm report an ingress
    // defect on loopback, where nothing sits in front at all.
    stallVerdict = 'inconclusive';
    stallNote =
      `the whole ${stall.bodyBytes}-byte body arrived and terminated tidily, so the server's ` +
      'write never stalled and the drain timeout was never reached. The body fits in the socket ' +
      'buffers between here and the server. Raise ANSWER_CHARS and re-seed; this arm needs a ' +
      'body bigger than that buffer chain to mean anything.';
  } else {
    stallVerdict = 'fail';
    stallNote =
      `THE FINDING. A tidy ending over a SHORT body: ${stall.bodyBytes} of ${control.bytes} ` +
      'bytes, terminated with a 0-chunk. A researcher gets a CSV that parses and holds part of ' +
      "their data with nothing saying so, which is the one outcome the export's refusal design " +
      'exists to prevent. Two causes look identical from here and the server log tells them ' +
      'apart: a `writeSurveyCsv` log line reading `reason: drain_timeout` means the application ' +
      'destroyed the socket and something at the INGRESS re-tidied it, so fix the ingress and ' +
      'stop it buffering; no such line means the application itself ended tidily, and the fix is ' +
      'the `res.destroy()` at the end of writeSurveyCsv. Either way, say so to anyone relying on ' +
      'the export until it is fixed.';
  }

  results.push({
    name: 'stall  read past the drain timeout',
    verdict: stallVerdict,
    signal: `${stall.terminated ? '0-chunk' : 'no 0-chunk'}, ${stall.endedBy}`,
    bytes: stall.bodyBytes,
    rows: 0,
    elapsedMs: stall.elapsedMs,
    note: stallNote
  });

  report(results);
  return results.every((arm) => arm.verdict === 'pass') ? 0 : 1;
}

function curlName(code: number): string {
  switch (code) {
    case CURL_OK: return 'success';
    case CURL_PARTIAL_TRANSFER: return 'transfer closed with outstanding read data remaining';
    case CURL_TIMEOUT: return 'operation timed out';
    case CURL_RECV_ERROR: return 'failure receiving network data';
    default: return 'see curl(1) EXIT CODES';
  }
}

function report(results: ArmResult[]) {
  console.log('\n| arm | verdict | client saw | bytes | rows | elapsed |');
  console.log('|---|---|---|---|---|---|');
  for (const arm of results) {
    console.log(
      `| ${arm.name} | ${arm.verdict.toUpperCase()} | ${arm.signal} | ${arm.bytes} | ${arm.rows} | ${arm.elapsedMs}ms |`
    );
  }

  console.log('');
  for (const arm of results) {
    console.log(`${arm.verdict.toUpperCase()}  ${arm.name}\n  ${arm.note}\n`);
  }

  const failed = results.filter((arm) => arm.verdict !== 'pass');
  console.log(
    failed.length === 0
      ? 'VERDICT: PASS. An interrupted export reaches this client as a broken transfer.'
      : `VERDICT: NOT PASS. ${failed.map((arm) => arm.name.split(' ')[0]).join(', ')}.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1] ?? null;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const confirmDb = flag(argv, 'confirm-db');

  if (command === 'seed' || command === 'clean') {
    const databaseUrl =
      flag(argv, 'database-url') ??
      process.env.DATABASE_URL ??
      process.env.FIRSTHAND_TEST_DATABASE_URL ??
      '';

    if (!databaseUrl) {
      throw new Error('Set DATABASE_URL, or pass --database-url.');
    }

    // The repository code reads process.env for its own pool, and there is one
    // database here by construction - the guard above only permits loopback.
    process.env.DATABASE_URL = databaseUrl;

    if (command === 'seed') {
      await runSeed(databaseUrl, flag(argv, 'owner') ?? DEFAULT_OWNER_EMAIL, confirmDb);
    } else {
      await runClean(databaseUrl, confirmDb);
    }
    return 0;
  }

  if (command === 'probe') {
    const target = assertProbeTargetSafe(flag(argv, 'target') ?? 'http://localhost:5000');
    return runProbe(
      target,
      flag(argv, 'cookie') ?? process.env.ADAPTALABS_ADMIN_COOKIE ?? null,
      PARTICIPANT_COUNT + 1
    );
  }

  console.log(
    'usage: npx tsx backend/probe/csv-interrupt.ts <seed|probe|clean> [options]\n' +
      '\n' +
      '  seed   --owner <email> --database-url <url> --confirm-db <name>\n' +
      '  probe  --target <url> --cookie "__Host-adaptalabs_session=..."\n' +
      '         (that name against playground; adaptalabs_session locally)\n' +
      '  clean  --database-url <url> --confirm-db <name>\n' +
      '\n' +
      'See the docblock at the top of this file, and the "Survey CSV interrupt probe"\n' +
      'section of TESTING_GUIDE.md.'
  );
  return 2;
}

// GUARDED, so the guard tests can import this module without the CLI running -
// an unguarded `main()` here would seed a database on `import`. Same predicate
// src/db/migrate.ts uses, and it holds under both tsx and ts-jest.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
