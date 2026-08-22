import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_ADMISSION_TIMEOUT_MS,
  ADMIN_CONCURRENCY_LIMIT,
  PARTICIPANT_RESERVED_CONNECTIONS,
  PUBLIC_CONCURRENCY_LIMIT,
  RUNTIME_POOL_MAX_CONNECTIONS,
  RuntimeDatabaseAdmissionTimeoutError,
  RuntimeDatabaseBusyError,
  admitRuntimeCheckout,
  currentRuntimeWorkClass,
  publicAdmissionStats,
  resetRuntimeAdmissionForTests,
  runAsParticipantWork,
  runAsPublicWork,
  runHoldingRuntimeSlot,
  runtimeAdmissionStats
} from "./runtime-pool-admission";

/**
 * The admission cap, tested by HOLDING slots rather than by counting calls.
 *
 * Every one of these opens admissions and does not release them until the
 * assertion has been made, because the defect being closed is about occupancy:
 * a test that admitted and released in sequence would pass against no cap at
 * all.
 */

/** Lets the microtask queue drain so a pending admission can settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Whether a promise has resolved, without awaiting it. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  const raced = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled"
    ),
    Promise.resolve(marker)
  ]);
  await settle();
  return raced === marker;
}

beforeEach(() => {
  resetRuntimeAdmissionForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetRuntimeAdmissionForTests();
});

describe("the cap itself", () => {
  /**
   * PINNED, and pinning a constant is the point rather than a weakness of the
   * test.
   *
   * These three numbers are not an implementation detail - they are the whole
   * policy. They decide who loses when five connections are contended, and
   * narrowing the reservation from three to one hands admin work four fifths
   * of the pool with nothing anywhere saying that was intended. The
   * derivation test below cannot see it: 4 is still 5 - 1.
   *
   * So the decision is written down where changing it fails, exactly as !201
   * did for the rate-limit ceilings. A deliberate change edits this line and
   * says why in the diff; an accidental one goes red.
   */
  it("holds the connection split to the numbers that were decided", () => {
    expect(RUNTIME_POOL_MAX_CONNECTIONS).toBe(5);
    expect(PARTICIPANT_RESERVED_CONNECTIONS).toBe(3);
    expect(ADMIN_CONCURRENCY_LIMIT).toBe(2);
  });

  it("derives the admin ceiling from the pool so the two cannot drift", () => {
    expect(ADMIN_CONCURRENCY_LIMIT).toBe(
      RUNTIME_POOL_MAX_CONNECTIONS - PARTICIPANT_RESERVED_CONNECTIONS
    );
    expect(ADMIN_CONCURRENCY_LIMIT).toBeGreaterThan(0);
    expect(ADMIN_CONCURRENCY_LIMIT).toBeLessThan(RUNTIME_POOL_MAX_CONNECTIONS);
  });

  it("admits exactly ADMIN_CONCURRENCY_LIMIT admin checkouts at once and holds the rest", async () => {
    const held = [];
    for (let index = 0; index < ADMIN_CONCURRENCY_LIMIT; index += 1) {
      held.push(await admitRuntimeCheckout());
    }

    const queued = admitRuntimeCheckout();
    expect(await isPending(queued)).toBe(true);
    expect(runtimeAdmissionStats()).toEqual({ available: 0, waiting: 1 });

    held[0].release();
    await expect(queued).resolves.toBeDefined();
  });

  it("leaves at least PARTICIPANT_RESERVED_CONNECTIONS admissible while admin work is at its ceiling", async () => {
    for (let index = 0; index < ADMIN_CONCURRENCY_LIMIT; index += 1) {
      await admitRuntimeCheckout();
    }

    // Not "some participants get through" - the specific number the pool is
    // sized to leave them. Asserting one would pass against a cap of four.
    const participants = await Promise.all(
      Array.from({ length: PARTICIPANT_RESERVED_CONNECTIONS }, () =>
        runAsParticipantWork(() => admitRuntimeCheckout())
      )
    );

    expect(participants).toHaveLength(PARTICIPANT_RESERVED_CONNECTIONS);
    // Participants are not merely given a bigger share; they are not counted.
    expect(runtimeAdmissionStats()).toEqual({ available: 0, waiting: 0 });
  });

  it("hands a released slot to the longest-waiting admin, not the newest", async () => {
    const held = [];
    for (let index = 0; index < ADMIN_CONCURRENCY_LIMIT; index += 1) {
      held.push(await admitRuntimeCheckout());
    }

    const order: string[] = [];
    const first = admitRuntimeCheckout().then(() => order.push("first"));
    const second = admitRuntimeCheckout().then(() => order.push("second"));
    await settle();

    held[0].release();
    await first;
    held[1].release();
    await second;

    expect(order).toEqual(["first", "second"]);
  });
});

describe("work classification", () => {
  it("treats unclassified work as admin, so an unmarked path is capped rather than exempt", () => {
    expect(currentRuntimeWorkClass()).toBe("admin");
  });

  it("carries the participant class across an await", async () => {
    const seen = await runAsParticipantWork(async () => {
      await settle();
      return currentRuntimeWorkClass();
    });

    expect(seen).toBe("participant");
  });

  it("does not leak the participant class out of its scope", async () => {
    await runAsParticipantWork(async () => {
      await settle();
    });

    expect(currentRuntimeWorkClass()).toBe("admin");
  });
});

describe("skipping instead of queueing", () => {
  it("refuses immediately when no slot is free", async () => {
    for (let index = 0; index < ADMIN_CONCURRENCY_LIMIT; index += 1) {
      await admitRuntimeCheckout();
    }

    await expect(admitRuntimeCheckout({ whenBusy: "skip" })).rejects.toThrow(
      RuntimeDatabaseBusyError
    );
    // The refusal must not have joined the queue: a waiter left behind would
    // be handed a permit nobody holds.
    expect(runtimeAdmissionStats()).toEqual({ available: 0, waiting: 0 });
  });

  it("takes a slot normally when one is free", async () => {
    const admitted = await admitRuntimeCheckout({ whenBusy: "skip" });
    expect(runtimeAdmissionStats().available).toBe(ADMIN_CONCURRENCY_LIMIT - 1);
    admitted.release();
    expect(runtimeAdmissionStats().available).toBe(ADMIN_CONCURRENCY_LIMIT);
  });

  it("never refuses participant work, which is not capped at all", async () => {
    for (let index = 0; index < ADMIN_CONCURRENCY_LIMIT; index += 1) {
      await admitRuntimeCheckout();
    }

    await expect(
      runAsParticipantWork(() => admitRuntimeCheckout({ whenBusy: "skip" }))
    ).resolves.toBeDefined();
  });
});

describe("re-entrancy", () => {
  it("passes a nested checkout through instead of deadlocking on the cap", async () => {
    // Fill the cap with the OUTER holders, so a nested acquire would have to
    // wait for a slot its own caller is holding.
    const outer = [];
    for (let index = 0; index < ADMIN_CONCURRENCY_LIMIT; index += 1) {
      outer.push(await admitRuntimeCheckout());
    }

    const nested = await runHoldingRuntimeSlot(() => admitRuntimeCheckout());

    expect(nested.alreadyHeld).toBe(true);
    // It took nothing, so releasing it must give nothing back.
    nested.release();
    expect(runtimeAdmissionStats()).toEqual({ available: 0, waiting: 0 });

    outer.forEach((slot) => slot.release());
    expect(runtimeAdmissionStats().available).toBe(ADMIN_CONCURRENCY_LIMIT);
  });

  it("still charges a permit to each of two SIBLING checkouts in one request", async () => {
    // The trap the shadowing store exists for. Both of these start from the
    // same request context; neither is inside the other. Tracking "this
    // context holds a slot" on the request's own store would let the second
    // ride the first's permit and quietly widen the cap.
    const [first, second] = await Promise.all([
      admitRuntimeCheckout(),
      admitRuntimeCheckout()
    ]);

    expect(first.alreadyHeld).toBe(false);
    expect(second.alreadyHeld).toBe(false);
    expect(runtimeAdmissionStats().available).toBe(ADMIN_CONCURRENCY_LIMIT - 2);
  });
});

describe("permit accounting", () => {
  it("ignores a second release rather than inventing a permit", async () => {
    const admitted = await admitRuntimeCheckout();
    admitted.release();
    admitted.release();

    expect(runtimeAdmissionStats().available).toBe(ADMIN_CONCURRENCY_LIMIT);
  });

  it("does not admit a second waiter off one release, even with a queue behind it", async () => {
    // The assertion above cannot see the defect on its own, and finding that
    // out is the reason this one exists: with nobody waiting, the `Math.min`
    // clamp in `release` absorbs the extra permit and the count still reads
    // correctly. The damage only appears when there IS a queue - the second
    // release is handed straight to a waiter, and the cap is silently one
    // wider for as long as that request runs.
    const held = [];
    for (let index = 0; index < ADMIN_CONCURRENCY_LIMIT; index += 1) {
      held.push(await admitRuntimeCheckout());
    }

    let admitted = 0;
    const queued = [
      admitRuntimeCheckout().then(() => {
        admitted += 1;
      }),
      admitRuntimeCheckout().then(() => {
        admitted += 1;
      })
    ];
    await settle();
    expect(runtimeAdmissionStats().waiting).toBe(2);

    held[0].release();
    held[0].release();
    await settle();

    expect(admitted).toBe(1);
    expect(runtimeAdmissionStats().waiting).toBe(1);

    held.slice(1).forEach((slot) => slot.release());
    await Promise.all(queued);
  });

  it("removes a timed-out waiter from the queue instead of leaking its permit", async () => {
    vi.useFakeTimers();

    const held = [];
    for (let index = 0; index < ADMIN_CONCURRENCY_LIMIT; index += 1) {
      held.push(await admitRuntimeCheckout());
    }

    const queued = admitRuntimeCheckout();
    const assertion = expect(queued).rejects.toThrow(
      RuntimeDatabaseAdmissionTimeoutError
    );
    await vi.advanceTimersByTimeAsync(ADMIN_ADMISSION_TIMEOUT_MS);
    await assertion;

    expect(runtimeAdmissionStats()).toEqual({ available: 0, waiting: 0 });

    // The permit the abandoned waiter would have been handed is still real.
    held.forEach((slot) => slot.release());
    expect(runtimeAdmissionStats().available).toBe(ADMIN_CONCURRENCY_LIMIT);
  });

  it("tells the caller to wait, and keeps the internal budget off the message", async () => {
    const busy = new RuntimeDatabaseBusyError();
    const timedOut = new RuntimeDatabaseAdmissionTimeoutError(10_000);

    for (const error of [busy, timedOut]) {
      expect(error.statusCode).toBe(503);
      // NOT "busy serving participants". The commonest way to exhaust the
      // admin budget is another ADMIN holding it - a colleague's export is
      // allowed a two-minute query - and naming participants sent the author
      // and the operator after the wrong cause.
      expect(error.message).toMatch(/busy with other work/i);
      expect(error.message).not.toMatch(/participant/i);
      expect(error.message).not.toMatch(/\d/);
    }

    expect(busy.code).toBe("RUNTIME_POOL_BUSY");
    expect(timedOut.code).toBe("RUNTIME_POOL_ADMISSION_TIMEOUT");
    expect(timedOut.waitedMs).toBe(10_000);
  });
});

/**
 * ANONYMOUS, PRE-CONSENT WORK.
 *
 * `GET /:id/recorded-study-brief` is `optionalAuth`, so it is reachable with no
 * credential, and it used to carry the participant marker - which handed the
 * uncapped lane to the open internet behind a limiter that `trust proxy: 1`
 * collapses to one key for every caller. Two review gates and a peer session
 * called that independently.
 */
describe("the public lane", () => {
  it("takes an admin permit as well as its own, so it cannot widen the total", async () => {
    const admitted = await runAsPublicWork(() => admitRuntimeCheckout());

    expect(publicAdmissionStats().available).toBe(PUBLIC_CONCURRENCY_LIMIT - 1);
    expect(runtimeAdmissionStats().available).toBe(ADMIN_CONCURRENCY_LIMIT - 1);

    admitted.release();

    expect(publicAdmissionStats().available).toBe(PUBLIC_CONCURRENCY_LIMIT);
    expect(runtimeAdmissionStats().available).toBe(ADMIN_CONCURRENCY_LIMIT);
  });

  it("refuses immediately rather than queueing, so a flood costs nothing to hold", async () => {
    await runAsPublicWork(() => admitRuntimeCheckout());

    await expect(runAsPublicWork(() => admitRuntimeCheckout())).rejects.toThrow(
      RuntimeDatabaseBusyError
    );

    // No queue means nothing for an unauthenticated flood to fill: no socket
    // held open for the admission budget, no timer, no place in line.
    expect(publicAdmissionStats()).toEqual({ available: 0, waiting: 0 });
    expect(runtimeAdmissionStats().waiting).toBe(0);
  });

  it("gives its own permit back when the admin budget refuses it", async () => {
    // Both permits or neither. A refusal that kept the first would narrow the
    // public budget by one every time the admin budget was full.
    for (let index = 0; index < ADMIN_CONCURRENCY_LIMIT; index += 1) {
      await admitRuntimeCheckout();
    }

    await expect(runAsPublicWork(() => admitRuntimeCheckout())).rejects.toThrow(
      RuntimeDatabaseBusyError
    );

    expect(publicAdmissionStats()).toEqual({
      available: PUBLIC_CONCURRENCY_LIMIT,
      waiting: 0
    });
  });

  it("cannot occupy the connections reserved for participants", async () => {
    await runAsPublicWork(() => admitRuntimeCheckout());
    for (let index = 0; index < ADMIN_CONCURRENCY_LIMIT - 1; index += 1) {
      await admitRuntimeCheckout();
    }

    // Non-participant work is at its ceiling, and three participants still get
    // in - the guarantee is unchanged by the new lane.
    const participants = await Promise.all(
      Array.from({ length: 3 }, () =>
        runAsParticipantWork(() => admitRuntimeCheckout())
      )
    );

    expect(participants).toHaveLength(3);
    expect(runtimeAdmissionStats().available).toBe(0);
  });
});
