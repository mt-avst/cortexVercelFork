import { AsyncLocalStorage } from "node:async_hooks";

import { AppError } from "../../../shared/types";
import { Semaphore, releaseOnce } from "../utils/semaphore";

/**
 * Who a runtime-pool checkout is being made FOR, and how many of them may be
 * in flight at once.
 *
 * A rate limiter bounds ARRIVALS. This bounds OCCUPANCY, which is the thing
 * that was never bounded. `express-rate-limit`'s MemoryStore counts hits per
 * key per window and has no notion of a request still running, so the ceilings
 * on the firsthand routers permit their whole minute's budget to be spent
 * concurrently at t=0. Sixty permitted reads fired at once are still sixty
 * handlers holding connections against a pool of five, and pg's waiting queue
 * is FIFO: a participant's `POST /api/firsthand/session/:token/runtime`
 * arriving behind them waits out `connectionTimeoutMillis` and fails, mid
 * survey, losing the answers that request was carrying.
 *
 * The aggregate is worse than any single ceiling suggests. The buckets are
 * deliberately independent of one another, and nothing composes the firsthand
 * router's with `opportunityWriteLimiter` or `surveyResultsLimiter` in
 * routes/opportunities.ts - which reach the same five connections. Per user,
 * per pod.
 *
 * So the guarantee here is stated in CONNECTIONS, not in requests:
 *
 *   at least PARTICIPANT_RESERVED_CONNECTIONS of the pool are never held by
 *   admin-originated work, no matter how much of it arrives at once.
 *
 * This is not the same as reserving them - a participant may still use the
 * whole pool, and participants may still queue behind each other. It is the
 * narrower and sufficient claim that admin traffic cannot be the reason a
 * participant's write fails.
 */

/**
 * Two classes, and the split is by WHOSE REQUEST it is, not by which module is
 * running.
 *
 * Module would have been the cheaper seam and it is the wrong one:
 * `getStudyById` is read by the authoring form AND by `session-create.ts` on
 * the participant's mint path, and `countStudyTasks` serves the participant
 * landing page. One repository function, several classes of caller.
 *
 * THE THIRD CLASS IS THE CORRECTION BOTH REVIEW GATES ASKED FOR.
 *
 * The first version had two classes and put `GET /:id/recorded-study-brief` in
 * the uncapped one, on the reasoning that a real participant loads that page.
 * True, and not sufficient: the route is `optionalAuth`, so it is reachable
 * with NO CREDENTIAL, and its only other ceiling is a 600/min bucket that
 * `trust proxy: 1` collapses to a single key for the whole internet. Two
 * checkouts per request, uncapped, from anyone holding a published opportunity
 * id - and those travel in Slack links. That is the starvation this file
 * exists to stop, reachable by an anonymous caller, through the exemption this
 * file granted.
 *
 * Worse than merely unclosed: by confining admin work to two connections, the
 * cap leaves an anonymous flood facing LESS competition than before, so it wins
 * a larger share of the pool than it did without this change.
 *
 * The asymmetry that justifies exempting a participant does not hold here. A
 * refusal on a session WRITE loses answers somebody has already given. A
 * refusal on a pre-consent landing-page READ costs a reload of a page nobody
 * has started.
 */
export type RuntimeWorkClass = "participant" | "public" | "admin";

type RuntimeWorkContext = {
  workClass: RuntimeWorkClass;
  /**
   * Whether the checkout that opened THIS context already holds an admission
   * slot. See `admitRuntimeCheckout` for why re-entrancy has to be tracked
   * rather than merely discouraged.
   */
  holdsSlot: boolean;
};

const runtimeWorkStorage = new AsyncLocalStorage<RuntimeWorkContext>();

/**
 * ADMIN IS THE DEFAULT, and that is the fail-safe direction rather than an
 * accident of ordering.
 *
 * Unclassified work - a cron tick, a background job, a route somebody adds
 * next year - is capped. The alternative default leaves every path nobody
 * remembered to mark free to starve participants, which is precisely the bug
 * this exists to close. The cost of the direction chosen is that a participant
 * path somebody forgets to mark is merely SLOWER, not broken: it competes for
 * two slots instead of five.
 *
 * "Forgets to mark" is then converted from a silent regression into a test
 * failure by the route table in
 * routes/__tests__/runtime-pool-admission-routes.test.ts, which asserts in both
 * directions which routes carry the marker.
 */
export function currentRuntimeWorkClass(): RuntimeWorkClass {
  return runtimeWorkStorage.getStore()?.workClass ?? "admin";
}

/**
 * Run `operation` - and everything it awaits - as participant-originated work.
 *
 * Used by `participantRuntimeWork`, the Express middleware in
 * middleware/runtime-work-class.ts. Exported separately so a non-request caller
 * (there is none today) can be classified without inventing a fake request.
 */
export function runAsParticipantWork<T>(operation: () => T): T {
  return runtimeWorkStorage.run(
    { workClass: "participant", holdsSlot: false },
    operation
  );
}

/**
 * Run `operation` as anonymous, pre-consent work.
 *
 * Used by `publicRuntimeWork` for `GET /:id/recorded-study-brief`, which is
 * `optionalAuth` and therefore reachable with no credential at all. Kept apart
 * from the admin class as well as the participant one: an anonymous flood that
 * could exhaust the admin budget would refuse every author, and one that could
 * exhaust the pool would lose participants their answers.
 */
export function runAsPublicWork<T>(operation: () => T): T {
  return runtimeWorkStorage.run(
    { workClass: "public", holdsSlot: false },
    operation
  );
}

/**
 * What an admin is told when admin work could not get in.
 *
 * "Something went wrong" would send an author to look for a fault in their own
 * study, and the condition is neither a fault nor theirs - it is the pool doing
 * exactly what it is now told to do. The wait is measured in seconds, not the
 * minute a 429 window costs, so "try again" is honest advice here in a way it
 * was not on the rate limiter.
 *
 * IT NO LONGER BLAMES PARTICIPANTS. The first version said "busy serving
 * participants", which is often false: the commonest way to exhaust the admin
 * budget is another ADMIN holding it - a colleague's survey export, which is
 * allowed a two-minute query. Naming participants sent both the author and the
 * operator reading the log after the wrong cause, which is the same failure
 * "something went wrong" was rejected for, one level more specific.
 *
 * The internal numbers - which budget ran out, how long it waited - stay on
 * the error object and go to the log, not to the caller.
 */
export const RUNTIME_POOL_BUSY_MESSAGE =
  "The task list database is busy with other work. Wait a few seconds and try again.";

/**
 * Thrown when admin-originated work asked not to wait and no slot was free.
 *
 * Only reachable through `whenBusy: "skip"`, which is only for work whose
 * caller already has a way to say "not established" - `answerCountsByStep`
 * answers `null`. Anything that would have to invent an answer must wait.
 */
export class RuntimeDatabaseBusyError extends AppError {
  constructor() {
    super(RUNTIME_POOL_BUSY_MESSAGE, 503, "RUNTIME_POOL_BUSY");
    this.name = "RuntimeDatabaseBusyError";
  }
}

/**
 * Thrown when admin-originated work waited out its admission budget.
 *
 * Distinct from the pool's own `connectionTimeoutMillis` failure so an
 * operator reading a log can tell "the pool is saturated" from "admin work is
 * queued behind other admin work".
 */
export class RuntimeDatabaseAdmissionTimeoutError extends AppError {
  /** The budget that ran out, for the log. Never for the caller. */
  public readonly waitedMs: number;

  constructor(waitedMs: number) {
    super(RUNTIME_POOL_BUSY_MESSAGE, 503, "RUNTIME_POOL_ADMISSION_TIMEOUT");
    this.name = "RuntimeDatabaseAdmissionTimeoutError";
    this.waitedMs = waitedMs;
  }
}

/**
 * The pool's own ceiling, lifted out of `getRuntimePoolConfig` so the two
 * numbers below cannot drift from it. `runtime-database.ts` reads it back.
 */
export const RUNTIME_POOL_MAX_CONNECTIONS = 5;

/**
 * How many of the pool's connections admin work may never occupy.
 *
 * Three, so three participants can be writing concurrently while admin traffic
 * is at its own ceiling. A participant write is one checkout holding a short
 * transaction, so three is well above the concurrency a single pod's live
 * sessions produce - the failure this closes was never two participants
 * colliding, it was sixty admin reads arriving at once.
 */
export const PARTICIPANT_RESERVED_CONNECTIONS = 3;

/**
 * Derived, never written down twice. Raising the pool without revisiting the
 * reservation would otherwise silently widen the admin cap.
 */
export const ADMIN_CONCURRENCY_LIMIT =
  RUNTIME_POOL_MAX_CONNECTIONS - PARTICIPANT_RESERVED_CONNECTIONS;

/**
 * How long admin work waits for a slot before giving up.
 *
 * Deliberately the same 10s as the pool's `connectionTimeoutMillis`, because
 * the two compose: an admin request's worst case becomes a wait here plus a
 * wait there. Doubling admin worst-case latency under saturation is the price
 * of the participant guarantee, and it is a price paid only in the state where
 * admin requests were already failing at ten seconds.
 */
export const ADMIN_ADMISSION_TIMEOUT_MS = 10_000;

/**
 * How much of the pool anonymous, pre-consent work may hold at once.
 *
 * ONE, and it is taken from INSIDE the admin budget rather than added beside
 * it - public work holds a public permit AND an admin permit. That keeps the
 * arithmetic this file is built on exactly as it was: non-participant work
 * never exceeds ADMIN_CONCURRENCY_LIMIT, so PARTICIPANT_RESERVED_CONNECTIONS
 * is still three. A second semaphore sitting alongside would have widened the
 * non-participant total to four and quietly eaten two of the three connections
 * the participant guarantee is made of.
 *
 * The two acquisitions are always taken in this order - public, then admin -
 * and admin work never takes the public one, so there is no cycle and no
 * deadlock.
 */
export const PUBLIC_CONCURRENCY_LIMIT = 1;

/** What to do when admin work arrives and every slot is taken. */
export type WhenRuntimePoolBusy = "wait" | "skip";

let admissions = new Semaphore(ADMIN_CONCURRENCY_LIMIT);
let publicAdmissions = new Semaphore(PUBLIC_CONCURRENCY_LIMIT);

/**
 * Ask permission to take a connection, and get back the release.
 *
 * The caller MUST call the returned function in a `finally`. It is idempotent,
 * because a checkout that released twice would hand out a permit that does not
 * exist and permanently widen the cap.
 *
 * Participant work is admitted immediately and unconditionally. It is not
 * merely given a bigger share - it is not counted at all, because counting it
 * would mean a burst of participants could refuse each other, and no ceiling
 * here is worth a participant losing answers.
 *
 * RE-ENTRANCY IS HANDLED, not forbidden. With two permits, one nested checkout
 * inside another is a deadlock rather than a slowdown, and a deadlock on the
 * participant runtime pool is an outage. Nothing nests today, and this makes
 * the day somebody does a hang into a loss of the cap instead.
 *
 * THAT LOSS IS NOT BOUNDED AT ONE, and an earlier version of this comment said
 * it was. `holdsSlot` marks the whole async subtree, so a `Promise.all` of N
 * nested checkouts inside one operation takes no further permits at all and
 * can occupy the entire pool on a single admin permit - the exact starvation
 * this file exists to stop. It is still the right trade against a deadlock,
 * but an understated comment is what the next author reasons from, so: if you
 * are about to nest, do not. The nesting is detected by
 * running the operation inside a SHADOWING context: work started inside sees
 * `holdsSlot`, and concurrent siblings started outside it do not, so
 * `Promise.all` over two repository calls still takes two permits.
 *
 * `alreadyHeld` is READ ONLY BY TESTS, deliberately and not by oversight.
 * `withRuntimeDatabaseClient` needs nothing but `release`, and the re-entrancy
 * decision is otherwise invisible: without this field a test can see that the
 * permit count did not move, which is also true of a checkout that failed to
 * take one. Keeping it is the difference between asserting the behaviour and
 * asserting its shadow.
 */
export async function admitRuntimeCheckout(options?: {
  whenBusy?: WhenRuntimePoolBusy;
}): Promise<{ release: () => void; alreadyHeld: boolean }> {
  const store = runtimeWorkStorage.getStore();
  const workClass = store?.workClass ?? "admin";

  if (workClass === "participant") {
    return { release: () => {}, alreadyHeld: false };
  }

  if (store?.holdsSlot) {
    return { release: () => {}, alreadyHeld: true };
  }

  if (workClass === "public") {
    return admitPublicCheckout();
  }

  if (options?.whenBusy === "skip") {
    if (!admissions.tryAcquire()) {
      throw new RuntimeDatabaseBusyError();
    }
  } else {
    await admissions.acquire(
      ADMIN_ADMISSION_TIMEOUT_MS,
      () => new RuntimeDatabaseAdmissionTimeoutError(ADMIN_ADMISSION_TIMEOUT_MS)
    );
  }

  return { release: releaseOnce(admissions), alreadyHeld: false };
}

/**
 * Anonymous work never queues. It takes both permits or it is refused.
 *
 * `tryAcquire` rather than a wait, and that is the point rather than a
 * shortcut. A queue is a thing an attacker can fill: every waiting request
 * holds a socket, a timer and a place in line for up to the admission budget,
 * so an unauthenticated flood would cost the process something even while
 * being correctly capped. Refusing immediately costs nothing to defend, and
 * the caller loses only a reload of a page they have not started.
 *
 * Both permits are taken in a fixed order and the first is given back if the
 * second is unavailable, so a refusal leaves the counts exactly as it found
 * them.
 */
function admitPublicCheckout(): { release: () => void; alreadyHeld: boolean } {
  if (!publicAdmissions.tryAcquire()) {
    throw new RuntimeDatabaseBusyError();
  }

  if (!admissions.tryAcquire()) {
    publicAdmissions.release();
    throw new RuntimeDatabaseBusyError();
  }

  const releasePublic = releaseOnce(publicAdmissions);
  const releaseAdmin = releaseOnce(admissions);

  return {
    release: () => {
      releaseAdmin();
      releasePublic();
    },
    alreadyHeld: false
  };
}

/**
 * Run `operation` in a context that says a slot is already held.
 *
 * Separate from `admitRuntimeCheckout` so the caller controls the scope: only
 * the work done WITH the client is inside it.
 */
export function runHoldingRuntimeSlot<T>(operation: () => T): T {
  const store = runtimeWorkStorage.getStore();

  return runtimeWorkStorage.run(
    { workClass: store?.workClass ?? "admin", holdsSlot: true },
    operation
  );
}

/** Test seam. Nothing in the application resets the semaphore. */
export function resetRuntimeAdmissionForTests(): void {
  admissions = new Semaphore(ADMIN_CONCURRENCY_LIMIT);
  publicAdmissions = new Semaphore(PUBLIC_CONCURRENCY_LIMIT);
}

/** Test seam. See `Semaphore.stats`. */
export function runtimeAdmissionStats() {
  return admissions.stats();
}

/** Test seam. The public sub-budget, held inside the admin one. */
export function publicAdmissionStats() {
  return publicAdmissions.stats();
}

/**
 * Whether an error is the admission cap refusing, rather than anything the
 * caller did.
 *
 * Both refusals already carry a 503 and a sentence for the author, and every
 * route that answers its own errors instead of throwing has to be able to tell
 * them apart from a genuine 400. A `catch` that flattens a transient capacity
 * condition into "your request was rejected" sends an author looking for a
 * mistake in their study that is not there.
 */
export function isRuntimePoolRefusal(error: unknown): boolean {
  return (
    error instanceof RuntimeDatabaseBusyError ||
    error instanceof RuntimeDatabaseAdmissionTimeoutError
  );
}
