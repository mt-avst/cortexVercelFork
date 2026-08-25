/**
 * Occupancy probe for cto/AdaptaLabs#9 - can one admin refuse another's results
 * reads indefinitely, inside the rate limits?
 *
 * WHAT IT MEASURES. One attacker firing at a fixed rate and never reading its
 * responses, against one victim polling a cheap results read every 2s. The
 * victim's 200-vs-refused ratio is the whole answer: a results route that
 * answers 503 RESULTS_READ_QUEUE_FULL to the superadmin because another admin
 * is holding the only permit is an outage, whatever the attacker was entitled
 * to see.
 *
 * WHAT IT IS AND IS NOT. Real HTTP over a real socket, the real
 * `boundResultsRead`, the real `writeSurveyCsv` with its real drain timeout.
 * NOT the real routes: those need Postgres, a session and a study with
 * participants, and the property under test lives in middleware that cannot
 * tell the difference. The handlers below reproduce the two SHAPES the four
 * routes have - a streamed CSV, and a buffered aggregate - and nothing else.
 * Read the numbers as measurements of the gate, not of the routes' auth.
 *
 * HOW THE ARMS ARE SWITCHED, because this is what makes a before/after here
 * honest. Two independent variables, both selected per request, so every arm
 * runs the same binary and arms can be INTERLEAVED rather than batched:
 *
 *   release  close | early | late
 *     `close` is what `main` does - the permit goes back when the response
 *     closes. `early` calls `releaseResultsReadPermit` at the preflight-to-
 *     stream boundary, which is the change. `late` calls the SAME function
 *     after the response has finished, which should be inert: it is the null
 *     control, and if it reproduces `early`'s improvement then the mechanism
 *     is the new code path rather than the timing and the fix is wrong.
 *
 *   slots  0 | 1 | 2 | ...
 *     How many results reads ONE CALLER may have in flight, as the arm wants
 *     it to be - not as the shipped constant happens to be. Simulated by
 *     MULTIPLEXING CALLER IDS, because the limit is a per-id counter: a caller
 *     spread over `n` ids holds `n x MAX_IN_FLIGHT_RESULTS_READS_PER_USER`
 *     slots, exactly and by construction. So `slots: 0` is a fresh id per
 *     request, which is what "no limit at all" means and reproduces `main`;
 *     `slots: 2` under a shipped limit of 1 is two ids.
 *
 *     THE VICTIM IS MULTIPLEXED TOO, and it must be. A starved victim polling
 *     every 2s has several polls in flight at once, so the limit applies to
 *     THEM as well - measuring the attacker's limit while leaving the victim
 *     on a different one would compare two changes at once.
 *
 *     `slotsToIds` refuses rather than rounding when the arm cannot be built
 *     from the shipped constant. An arm asking for fewer slots than one caller
 *     already gets is not measurable this way, and quietly measuring the
 *     nearest achievable thing is how a table stops meaning what its header
 *     says.
 *
 * Interleaving is not optional here. This repository has already produced one
 * confident wrong conclusion from batched arms - 0 failures in 25 runs against
 * 6 in 10 an hour later, which read as a 60% regression and was the machine's
 * socket state drifting; interleaved, both arms were identical. So the runner
 * below alternates every arm run by run and reports each pair.
 *
 * THE CONTROL ARM RUNS EVERY PAIR. Without it, a change that simply breaks the
 * victim's requests reads as a success, and "the victim was not starved" passes
 * just as well when the probe issued no requests at all.
 *
 * Run:  npx tsx backend/probe/occupancy.ts --pairs 3 --seconds 60
 */
import { createServer } from 'node:http';
import { get as httpGet } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import express, { type Request, type Response, type NextFunction } from 'express';

import { AppError } from '../../shared/types';
import type { StudyStep } from '../../shared/firsthand/contract';
import {
  MAX_IN_FLIGHT_RESULTS_READS_PER_USER,
  boundResultsRead,
  releaseResultsReadPermit,
  resetResultsReadGateForTests
} from '../src/middleware/results-read-concurrency';
import { writeSurveyCsv } from '../src/firsthand/survey-csv-response';
import type { StoredResponse } from '../src/firsthand/survey-results';

type ReleaseMode = 'close' | 'early' | 'late';
type Shape = 'csv' | 'aggregate' | 'slowwork';

/**
 * How long the `slowwork` shape holds the permit doing SERVER-side work.
 *
 * Stands in for a preflight-heavy export - `surveyCsvParticipantIds` and
 * `surveyCsvColumns` run serially, each up to 10s of admission plus a 120s
 * statement - and it is the shape that shows what
 * MAX_IN_FLIGHT_RESULTS_READS_PER_USER is for. A hold no client can shorten,
 * but a FINITE one: shorter than RESULTS_READ_QUEUE_TIMEOUT_MS, so a victim
 * queued behind ONE of them is served and a victim queued behind twenty is not.
 * That gap is the whole measurable value of bounding queue depth per caller,
 * and it is invisible in an arm where the hold is longer than the queue timeout
 * because there both answers are 503.
 */
const SLOW_WORK_MS = 3_000;

/**
 * Big enough that the kernel receive buffer of a client which never reads
 * cannot swallow it, because the whole attack depends on the write stalling.
 * A body that fits in the buffer is flushed, `close` fires, and the permit
 * comes straight back - which is a DIFFERENT measurement, and one this probe
 * would otherwise report as "no attack exists".
 */
const ATTACK_BODY_BYTES = 48 * 1024 * 1024;

const ANSWER_TEXT = 'x'.repeat(2048);

const CSV_STEPS: StudyStep[] = [
  { step_id: 'q1', order: 1, type: 'open_text', prompt: 'Tell us everything' }
];

const answersFor = (sessionId: string): StoredResponse[] => [
  {
    session_id: sessionId,
    step_id: 'q1',
    step_prompt: 'Tell us everything',
    step_type: 'open_text',
    response_payload: { text: ANSWER_TEXT },
    saved_at: new Date().toISOString()
  }
];

/**
 * Precomputed, and deliberately not `res.json` of a live object graph.
 *
 * The property under test is a large body buffered in the heap until the
 * client drains it. Serialising 48MB per request would make the probe measure
 * its own `JSON.stringify` instead, and the byte the socket stalls on is the
 * same either way.
 */
const BIG_AGGREGATE_BODY = JSON.stringify({
  respondents: 1,
  questions: [{ step_id: 'q1', prompt: 'p', type: 'open_text', answered: 1, answers: [{ session_id: 's', text: 'y'.repeat(ATTACK_BODY_BYTES) }] }]
});

const SMALL_AGGREGATE_BODY = JSON.stringify({ respondents: 0, questions: [] });

type Outcome = { ok: number; queueFull: number; userBusy: number; other: number };

const emptyOutcome = (): Outcome => ({ ok: 0, queueFull: 0, userBusy: 0, other: 0 });

/**
 * The probe server.
 *
 * `boundResultsRead` is mounted exactly as the four routes mount it: after the
 * thing that establishes `req.user`, before the handler. The handlers below are
 * the two shapes, and the release mode arrives as a query parameter so one
 * process can run both arms.
 */
async function startServer() {
  const app = express();

  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Stands in for `requireAdmin`, which is a role gate: it establishes WHO
    // the caller is and nothing about what they may read. That is the fact
    // #9 turns on.
    const id = req.header('x-probe-user') ?? 'unidentified';
    req.user = {
      id,
      name: id,
      email: `${id}@example.test`,
      // The LOWEST admin role, which is the point of #9: `requireAdmin` is a
      // role gate and ownership is checked inside the handler, so this role can
      // occupy a permit while being refused the data.
      role: 'researcher_admin'
    };
    next();
  });

  const release = (req: Request, res: Response, when: ReleaseMode) => {
    if (req.query.release === when) {
      releaseResultsReadPermit(res);
    }
  };

  // The victim's route: a cheap, small aggregate read. This is the "open the
  // results page" request whose success rate is the measurement.
  app.get('/victim', boundResultsRead, (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(SMALL_AGGREGATE_BODY);
  });

  // The streamed CSV shape. The real `writeSurveyCsv`, so the real
  // SURVEY_CSV_DRAIN_TIMEOUT_MS bounds the stall.
  app.get('/csv', boundResultsRead, async (req: Request, res: Response) => {
    const rows = Math.ceil(ATTACK_BODY_BYTES / ANSWER_TEXT.length);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');

    // The preflight-to-stream boundary, where the route calls it.
    release(req, res, 'early');

    const participants = async function* () {
      for (let index = 0; index < rows; index += 1) {
        yield { sessionId: `s${index}`, answers: answersFor(`s${index}`) };
      }
    };

    await writeSurveyCsv(res, CSV_STEPS, [], participants, { studyId: 'probe' });

    // The null control: the same call, after there is nothing left to protect.
    release(req, res, 'late');
  });

  // The buffered aggregate shape. `res.end` returns immediately and the body
  // sits in the socket's write buffer until the client drains it, so `close`
  // does not fire while a client reads nothing.
  app.get('/aggregate', boundResultsRead, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    release(req, res, 'early');
    res.end(BIG_AGGREGATE_BODY);
    release(req, res, 'late');
  });

  // Server-paced work, finite, with a small body. No client can lengthen this
  // hold and none can shorten it - which is what makes it the right shape for
  // measuring queue depth rather than drain stalling.
  app.get('/slowwork', boundResultsRead, async (_req: Request, res: Response) => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_WORK_MS));
    res.setHeader('Content-Type', 'application/json');
    res.end(SMALL_AGGREGATE_BODY);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    const code = error instanceof AppError ? error.code : 'UNKNOWN';
    if (!res.headersSent) {
      res.status(status).json({ code });
    }
  });

  const server = createServer(app);
  // Matches what index.ts sets, so the probe cannot measure an unbounded
  // request the production server would have cut off.
  server.timeout = 360_000;
  server.listen(0);
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;
  return { port, server };
}

/**
 * An attacker request that never reads its response.
 *
 * A raw socket rather than `http.get`, because `http.ClientRequest` consumes
 * the response as soon as anything is listening and even an unlistened one
 * drains enough to defeat the point. Nothing is ever read from this socket, so
 * its receive buffer fills, the TCP window closes and the server's write
 * stalls - which is precisely the client an admin can be.
 */
function stalledRequest(port: number, path: string, userId: string) {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => {});
  socket.on('connect', () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-probe-user: ${userId}\r\nConnection: close\r\n\r\n`
    );
    // Explicit, though a socket with no 'data' listener is paused anyway: the
    // intent is the measurement, and a later reader adding a listener for
    // debugging would silently end the attack.
    socket.pause();
  });
  return socket;
}

/** One victim poll, read to completion like a browser would. */
function victimPoll(port: number, userId: string): Promise<keyof Outcome> {
  return new Promise((resolve) => {
    const request = httpGet(
      {
        port,
        path: '/victim',
        headers: { 'x-probe-user': userId }
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          if (response.statusCode === 200) return resolve('ok');
          if (response.statusCode === 503) return resolve('queueFull');
          if (response.statusCode === 429) return resolve('userBusy');
          return resolve('other');
        });
      }
    );
    // BOUNDED. An unbounded victim poll would make a starved victim look like
    // a hung probe, and the run would end as a timeout with no numbers rather
    // than as a measurement.
    request.setTimeout(20_000, () => request.destroy());
    request.on('error', () => resolve('other'));
  });
}

type Arm = {
  name: string;
  shape: Shape | 'none';
  release: ReleaseMode;
  /** Slots one caller gets. 0 is no limit at all. See the docblock. */
  slots: number;
  attackerPerMinute: number;
  /** Requests fired together each interval, for the queue-depth arms. */
  burst?: number;
};

/**
 * How many caller ids an arm needs to hold `slots` slots.
 *
 * Zero means unlimited, and is signalled by returning 0 - the callers below
 * read that as "a fresh id every time".
 */
function slotsToIds(slots: number): number {
  if (slots === 0) {
    return 0;
  }

  if (slots % MAX_IN_FLIGHT_RESULTS_READS_PER_USER !== 0) {
    throw new Error(
      `Cannot build a ${slots}-slot arm from a shipped limit of ` +
        `${MAX_IN_FLIGHT_RESULTS_READS_PER_USER}: id multiplexing only reaches ` +
        'whole multiples of it. Change the arm, not the rounding.'
    );
  }

  return slots / MAX_IN_FLIGHT_RESULTS_READS_PER_USER;
}

/** The id a request runs under, given the arm's slot budget. */
const callerId = (role: string, sequence: number, ids: number): string =>
  ids === 0 ? `${role}-${sequence}` : `${role}-${sequence % ids}`;

/**
 * EXPRESSED RELATIVE TO THE SHIPPED LIMIT, never as bare numbers.
 *
 * `slotsToIds` can only build whole multiples of
 * MAX_IN_FLIGHT_RESULTS_READS_PER_USER and refuses anything else, so an arm
 * list holding literal 1s and 2s stops being runnable the moment the constant
 * moves - which is exactly what happened: the arms below were literal `1` and
 * `2` while the constant was 1, and raising it to 2 turned the whole probe into
 * a crash on its own default arm set. A measurement harness that cannot run is
 * worse than no harness, because the next reader assumes the numbers in the
 * commit came from something they can reproduce.
 *
 * THE 1-VERSUS-2 COMPARISON THAT CHOSE THE CONSTANT is therefore not in this
 * list any more, and cannot be: at a shipped limit of 2 there is no way to
 * simulate 1. To reproduce it, set MAX_IN_FLIGHT_RESULTS_READS_PER_USER back to
 * 1 and use `slots: 1` and `slots: 2`. Three interleaved rounds, 40s per arm,
 * gave:
 *
 *   slots  victim 200  503  429  success
 *   0              51    6    0     0.89   one admin starving another
 *   1              54    0    3     0.95
 *   2              51    0    6     0.89
 *
 * Zero 503s at both 1 and 2, in every round. See the constant's docblock.
 */
const SHIPPED = MAX_IN_FLIGHT_RESULTS_READS_PER_USER;

/**
 * EVERY ROW OF THE MERGE REQUEST'S TABLE, and that is the requirement.
 *
 * Five of these were dropped when the arm list was rewritten for the 1-versus-2
 * measurement - `csv before`, the NULL CONTROL, `limit alone`, and both
 * aggregate arms. The file still started, ran and printed a table, so nothing
 * failed; it just no longer produced the majority of the numbers the MR quotes.
 *
 * That is this repository's own named defect - a claim about verification that
 * is itself unverifiable - and it is the exact thing #9 was found to have done
 * by citing a probe file that had never been committed. A reader must be able
 * to run `npx tsx backend/probe/occupancy.ts` and get the published table back.
 *
 * The NULL CONTROL is the one that must never be dropped again. Without it the
 * before/after pair is a story: `late` calls the same function after the stream
 * has finished, so it MUST reproduce `before`, and if it ever reproduces
 * `after` instead then the mechanism is the new code path rather than the
 * timing and the fix is wrong.
 *
 * THE `limit alone` ARM IS SLOT-SENSITIVE, and two runs disagreed on it before
 * anyone noticed why: 0.05 measured when the shipped limit was 1, ~0.14 once it
 * was 2. Both say the same thing - 503s still land, so bounding the caller
 * without releasing the permit does NOT close the attack - but the figure moves
 * with the constant because a starved victim's own overlapping polls turn into
 * 429s at a rate the slot budget sets. Quote it as ~0.14 at the shipped limit,
 * and re-measure rather than trusting either number if the constant moves
 * again.
 */
const ARMS: Arm[] = [
  { name: 'control  no attacker                  ', shape: 'none', release: 'close', slots: SHIPPED, attackerPerMinute: 0 },
  { name: 'csv      before  close slots=unlimited', shape: 'csv', release: 'close', slots: 0, attackerPerMinute: 10 },
  { name: 'csv      after   early slots=shipped  ', shape: 'csv', release: 'early', slots: SHIPPED, attackerPerMinute: 10 },
  { name: 'csv      NULL    late  slots=unlimited', shape: 'csv', release: 'late', slots: 0, attackerPerMinute: 10 },
  { name: 'csv      after   early slots=unlimited', shape: 'csv', release: 'early', slots: 0, attackerPerMinute: 10 },
  { name: 'csv      limit   close slots=shipped  ', shape: 'csv', release: 'close', slots: SHIPPED, attackerPerMinute: 10 },
  { name: 'agg      before  close slots=unlimited', shape: 'aggregate', release: 'close', slots: 0, attackerPerMinute: 10 },
  { name: 'agg      shipped close slots=shipped  ', shape: 'aggregate', release: 'close', slots: SHIPPED, attackerPerMinute: 10 },
  { name: 'agg      early   early slots=shipped  ', shape: 'aggregate', release: 'early', slots: SHIPPED, attackerPerMinute: 10 },
  { name: 'burst20  before  close slots=unlimited', shape: 'slowwork', release: 'close', slots: 0, attackerPerMinute: 4, burst: 20 },
  { name: 'burst20  after   close slots=shipped  ', shape: 'slowwork', release: 'close', slots: SHIPPED, attackerPerMinute: 4, burst: 20 },
  { name: 'burst20  after   close slots=2xshipped', shape: 'slowwork', release: 'close', slots: SHIPPED * 2, attackerPerMinute: 4, burst: 20 }
];

async function runArm(port: number, arm: Arm, seconds: number): Promise<Outcome> {
  resetResultsReadGateForTests();

  const sockets: ReturnType<typeof connect>[] = [];
  const outcome = emptyOutcome();
  let attackerRequests = 0;

  const ids = slotsToIds(arm.slots);

  const fireAttack = () => {
    for (let index = 0; index < (arm.burst ?? 1); index += 1) {
      attackerRequests += 1;
      sockets.push(
        stalledRequest(
          port,
          `/${arm.shape}?release=${arm.release}`,
          callerId('attacker', attackerRequests, ids)
        )
      );
    }
  };

  const attackTimer =
    arm.attackerPerMinute === 0 || arm.shape === 'none'
      ? undefined
      : setInterval(fireAttack, Math.round(60_000 / arm.attackerPerMinute));

  // Fire one immediately rather than waiting a whole interval, or a short arm
  // measures mostly the unattacked state and reports the attack as harmless.
  if (attackTimer) {
    fireAttack();
    // Let the attacker take the permit before the victim's first poll, so the
    // first poll is not a free hit that flatters every arm equally.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  /**
   * EVERY 2s ON A FIXED SCHEDULE, not one-at-a-time.
   *
   * Serialising the polls would make a starved victim issue six requests in a
   * minute where an unattacked one issues thirty, and the two arms would no
   * longer be comparable on anything but the ratio. It also hides a real
   * effect: the per-caller limit applies to the VICTIM too, so a victim whose
   * poll is queued for ten seconds and who polls again meanwhile can be
   * refused by their own limit. That has to be visible, not designed out -
   * which is why `slots` multiplexes the victim's ids as well as the
   * attacker's.
   */
  let victimPolls = 0;
  const inFlight: Promise<void>[] = [];
  const pollTimer = setInterval(() => {
    victimPolls += 1;
    inFlight.push(
      victimPoll(port, callerId('victim', victimPolls, ids)).then((result) => {
        outcome[result] += 1;
      })
    );
  }, 2000);

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  clearInterval(pollTimer);
  await Promise.all(inFlight);

  clearInterval(attackTimer);
  sockets.forEach((socket) => socket.destroy());
  // Long enough for the server to see every hangup, so the next arm does not
  // start against permits the previous arm still holds. The reset above is the
  // belt; this is the braces, and without it an arm's first poll can be a 503
  // caused by its predecessor.
  await new Promise((resolve) => setTimeout(resolve, 500));

  return outcome;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: number) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : Number(argv[index + 1]);
  };

  const pairs = flag('pairs', 3);
  const seconds = flag('seconds', 60);

  const { port, server } = await startServer();
  const totals = new Map<string, Outcome>(ARMS.map((arm) => [arm.name, emptyOutcome()]));

  console.log(`probe: ${pairs} interleaved rounds, ${seconds}s per arm, ${ARMS.length} arms`);

  for (let round = 0; round < pairs; round += 1) {
    for (const arm of ARMS) {
      const outcome = await runArm(port, arm, seconds);
      const total = outcome.ok + outcome.queueFull + outcome.userBusy + outcome.other;
      const running = totals.get(arm.name);
      if (running) {
        running.ok += outcome.ok;
        running.queueFull += outcome.queueFull;
        running.userBusy += outcome.userBusy;
        running.other += outcome.other;
      }
      console.log(
        `round ${round + 1}  ${arm.name}  200=${outcome.ok} 503=${outcome.queueFull} ` +
          `429=${outcome.userBusy} other=${outcome.other} success=${
            total === 0 ? 'n/a' : (outcome.ok / total).toFixed(2)
          }`
      );
    }
  }

  console.log('\n| arm | victim 200 | victim 503 | victim 429 | victim other | success |');
  console.log('|---|---|---|---|---|---|');
  for (const arm of ARMS) {
    const outcome = totals.get(arm.name);
    if (!outcome) continue;
    const total = outcome.ok + outcome.queueFull + outcome.userBusy + outcome.other;
    console.log(
      `| ${arm.name} | ${outcome.ok} | ${outcome.queueFull} | ${outcome.userBusy} | ` +
        `${outcome.other} | ${total === 0 ? 'n/a' : (outcome.ok / total).toFixed(2)} |`
    );
  }

  server.closeAllConnections?.();
  server.close();
}

void main();
