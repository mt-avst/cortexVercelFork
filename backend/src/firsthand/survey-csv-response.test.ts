import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Response } from "express";

vi.mock("../utils/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  writeSurveyCsv,
  SURVEY_CSV_DRAIN_TIMEOUT_MS,
  SURVEY_CSV_EXPORT_DEADLINE_MS
} from "./survey-csv-response";
import { logger } from "../utils/logger";
import type { StudyStep } from "../../../shared/firsthand/contract";
import type { StoredResponse } from "./survey-results";

/**
 * THE WRITER'S OWN BEHAVIOUR, which nothing else covered.
 *
 * A review gate ran thirteen mutations over this change. Two of the survivors
 * were in this file, and both are cases the response's CONTENT cannot show:
 *
 *  - deleting all three `res.off(...)` cleanups - the listener leak the
 *    second commit of this MR exists to fix. The bug it fixed had no test, so
 *    it could come straight back.
 *  - deleting the client-hungup early return, so an abandoned download goes on
 *    costing a pool checkout per batch for a file nobody is reading.
 *
 * Both are asserted here on the SOCKET rather than the bytes.
 */

const steps: StudyStep[] = [
  { step_id: "q1", order: 1, type: "open_text", prompt: "How was it?" } as StudyStep
];

const answer = (sessionId: string): StoredResponse => ({
  session_id: sessionId,
  step_id: "q1",
  step_prompt: null,
  step_type: "open_text",
  response_payload: { text: "fine" },
  saved_at: "2026-08-22T00:00:00.000Z"
});

/** A response that reports a full buffer, so every write waits for a drain. */
function backpressuredResponse() {
  const emitter = new EventEmitter();
  const res = emitter as unknown as Response & EventEmitter;

  Object.assign(res, {
    destroyed: false,
    writableEnded: false,
    write: () => {
      // Always "full", so every write takes the slow path and attaches
      // listeners - which is the only path where a leak can happen.
      setImmediate(() => emitter.emit("drain"));
      return false;
    },
    end: () => {
      (res as { writableEnded: boolean }).writableEnded = true;
    },
    destroy: () => {
      (res as { destroyed: boolean }).destroyed = true;
    }
  });

  return res;
}

/**
 * A response that is permanently full and NEVER drains, recording what it was
 * given.
 *
 * `backpressuredResponse` above emits `drain` on the next tick, which is right
 * for the listener-leak tests but makes the backpressure itself invisible:
 * with the drain always arriving, honouring `res.write`'s return value and
 * ignoring it produce the same chunks in the same order, so
 *
 *     if (res.write(chunk)) { resolve(); return; }   ->   res.write(chunk); resolve();
 *
 * survived. Nothing failed, because a writer that never waits also never
 * attaches a listener and so never leaks one.
 *
 * Withholding the drain is what makes the difference observable. The honest
 * writer stops after the header and stays stopped; the mutant runs to
 * completion and calls `end()`. That is asserted on the CHUNKS, which this
 * fake keeps so the bytes the writer actually emits can be compared - the
 * line ending included, which nothing else in the suite reads.
 */
function stalledResponse() {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  const res = emitter as unknown as Response &
    EventEmitter & { chunks: string[] };

  Object.assign(res, {
    chunks,
    destroyed: false,
    writableEnded: false,
    // False every time, and no drain follows. `false` means "accepted, buffer
    // full" - so the chunk IS recorded, exactly as a real socket would.
    write: (chunk: string) => {
      chunks.push(chunk);
      return false;
    },
    end: () => {
      (res as { writableEnded: boolean }).writableEnded = true;
    },
    destroy: () => {
      (res as { destroyed: boolean }).destroyed = true;
    }
  });

  return res;
}

/**
 * A response that hangs up part-way through, mid-write.
 *
 * The ORDINARY cancellation: somebody closes the tab. `close` settles the
 * pending write, and it must settle it as a RESOLVE - the loop's own hangup
 * check then stops the export quietly. Rejecting instead routes an everyday
 * event into the failure path and logs it as an export failure, and since the
 * bytes are identical either way, only the log can see the difference.
 */
function hangsUpAfter(chunkCount: number) {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  const res = emitter as unknown as Response &
    EventEmitter & { chunks: string[] };

  Object.assign(res, {
    chunks,
    destroyed: false,
    writableEnded: false,
    write: (chunk: string) => {
      chunks.push(chunk);
      setImmediate(() => {
        if (chunks.length >= chunkCount) {
          (res as { destroyed: boolean }).destroyed = true;
          emitter.emit("close");
        } else {
          emitter.emit("drain");
        }
      });
      return false;
    },
    end: () => {
      (res as { writableEnded: boolean }).writableEnded = true;
    },
    destroy: () => {
      (res as { destroyed: boolean }).destroyed = true;
    }
  });

  return res;
}

/** Lets every already-queued microtask and immediate run. */
const settleTick = () =>
  new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

async function* participantsOf(ids: string[], onPull?: (id: string) => void) {
  for (const id of ids) {
    onPull?.(id);
    yield { sessionId: id, answers: [answer(id)] };
  }
}

describe("writing the export to the socket", () => {
  it("writes nothing more until the socket drains", async () => {
    const res = stalledResponse();
    let finished = false;
    const writing = writeSurveyCsv(
      res,
      steps,
      [],
      () => participantsOf(["a", "b", "c"]),
      { studyId: "study_1" }
    ).then(() => {
      finished = true;
    });

    await settleTick();

    // THE ASSERTION THAT KILLS "ignore the return value". A writer that
    // respects backpressure has written the header and is waiting; one that
    // does not has written all four chunks and resolved. Both produce
    // identical bytes in the end, so only the PAUSE tells them apart.
    expect(res.chunks).toHaveLength(1);
    expect(finished).toBe(false);
    expect(res.writableEnded).toBe(false);

    // And it resumes on exactly one drain per write, rather than draining the
    // whole export on the first.
    res.emit("drain");
    await settleTick();
    expect(res.chunks).toHaveLength(2);
    expect(finished).toBe(false);

    for (let i = 0; i < 3; i += 1) {
      res.emit("drain");
      await settleTick();
    }

    await writing;
    expect(finished).toBe(true);
    expect(res.chunks).toHaveLength(4);
    expect(res.writableEnded).toBe(true);
  });

  it("writes no row for a participant whose answers vanished mid-export", async () => {
    const res = stalledResponse();

    async function* withAGhost() {
      yield { sessionId: "kept", answers: [answer("kept")] };
      // Their session was deleted between the preflight and this batch - a
      // retake cascades exactly this way - so the batch read returned nothing
      // for them.
      yield { sessionId: "ghost", answers: [] };
      // IN THE MIDDLE, AND THIS IS THE WHOLE POINT. With the ghost last, the
      // skip's `continue` and a `break` emit identical bytes, so `continue` ->
      // `break` survived the entire suite - 825 jest, 590 vitest, 16 db tests,
      // all green. A skip that stops the export instead of stepping over one
      // row hands the researcher a short CSV that parses, with 200 OK and the
      // right filename: refusal turned into truncation, the one outcome this
      // file's headline forbids. Somebody has to come after the ghost or the
      // test cannot tell the two apart.
      yield { sessionId: "after", answers: [answer("after")] };
    }

    const writing = writeSurveyCsv(res, steps, [], () => withAGhost(), {
      studyId: "study_1"
    });
    for (let i = 0; i < 3; i += 1) {
      res.emit("drain");
      await settleTick();
    }
    await writing;

    const body = res.chunks.join("");

    // A row of empty cells asserts "this participant answered nothing", which
    // is not what happened. Absence is the honest reading.
    expect(body).not.toContain("ghost");
    // The controls. An export that wrote nothing would also not contain
    // "ghost" - and one that STOPPED at the ghost would still contain "kept",
    // which is why "after" is the assertion that matters.
    expect(body).toContain("kept");
    expect(body).toContain("after");
    expect(res.chunks).toHaveLength(3);
    expect(res.writableEnded).toBe(true);
  });

  it("ends every line with CRLF, on the bytes it actually emits", async () => {
    const res = stalledResponse();
    const writing = writeSurveyCsv(
      res,
      steps,
      [],
      () => participantsOf(["a"]),
      { studyId: "study_1" }
    );

    // Two writes, so two drains.
    for (let i = 0; i < 2; i += 1) {
      res.emit("drain");
      await settleTick();
    }
    await writing;

    const body = res.chunks.join("");

    // CSV_LINE_ENDING is CRLF because RFC 4180 says so and because Excel on
    // Windows is the most common destination for these files.
    //
    // BE PRECISE ABOUT WHAT THIS ADDS, because the finding that prompted it
    // was wrong. "CSV_LINE_ENDING -> '\n' survives everything" does not
    // reproduce: flipping the constant fails about twenty tests in
    // survey-csv.test.ts, which compare whole expected CSV strings. The
    // constant is well pinned already.
    //
    // What was NOT pinned is the WRITER drifting from the builder - this file
    // appends the ending itself, twice, and nothing read the bytes it pushes
    // to the socket. Measured: replacing both `+ CSV_LINE_ENDING` here with
    // `+ "\n"` while the builder keeps CRLF failed exactly ONE test in the
    // whole suite, this one. That is the gap, and it is narrower than the
    // finding claimed.
    expect(body.endsWith("\r\n")).toBe(true);
    expect(body.split("\r\n").filter((line) => line !== "")).toHaveLength(2);
    // The control: a body that contained no line ending at all would satisfy
    // an assertion about the ABSENCE of bare newlines.
    expect(body).toContain("\r\n");
    expect(body.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("leaves no listener behind, however many writes wait for a drain", async () => {
    const res = backpressuredResponse();
    const ids = Array.from({ length: 200 }, (_unused, i) => `s${i}`);

    await writeSurveyCsv(res, steps, [], () => participantsOf(ids), {
      studyId: "study"
    });

    // Two hundred backpressured writes. With the cleanups removed this is 200
    // dead `error` listeners and a MaxListenersExceededWarning that arrives
    // long after the cause - and a real export is far larger than 200 rows.
    expect(res.listenerCount("error")).toBe(0);
    expect(res.listenerCount("drain")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("stops pulling batches the moment the caller has gone", async () => {
    const res = backpressuredResponse();
    const pulled: string[] = [];
    const ids = Array.from({ length: 50 }, (_unused, i) => `s${i}`);

    const generator = participantsOf(ids, (id) => {
      pulled.push(id);
      // The caller hangs up while the third participant is being read.
      if (pulled.length === 3) {
        (res as unknown as { destroyed: boolean }).destroyed = true;
      }
    });

    await writeSurveyCsv(res, steps, [], () => generator, { studyId: "study" });

    // Each pull is a pool checkout in production. Without the early return
    // this runs to fifty, paying for a download nobody is taking.
    expect(pulled.length).toBeLessThan(10);
    expect(pulled.length).toBeGreaterThanOrEqual(3);
  });

  it("does not write at all when the caller left during the preflight", async () => {
    // The HIGH both gates found: `close` fires ONCE, so a response already
    // destroyed before the first write can never settle a listener attached
    // afterwards. The window is the two preflight reads, each allowed 120s.
    const res = backpressuredResponse();
    (res as unknown as { destroyed: boolean }).destroyed = true;

    const pulled: string[] = [];
    const generator = participantsOf(["s1"], (id) => pulled.push(id));

    // Resolves rather than hanging, which is the whole point.
    await expect(
      writeSurveyCsv(res, steps, [], () => generator, { studyId: "study" })
    ).resolves.toBeUndefined();
    expect(pulled).toEqual([]);
  });

  it("treats an ordinary hangup as a hangup, not as a failure", async () => {
    // `close` settling a pending write must RESOLVE. Rejecting sends every
    // cancelled download - a closed tab, a navigation away - into the catch,
    // which logs it as an export failure. Nothing about the RESPONSE can see
    // the difference, which is why nothing did: only the log can.
    vi.mocked(logger.error).mockClear();

    const res = hangsUpAfter(3);
    const ids = Array.from({ length: 50 }, (_unused, i) => `s${i}`);

    await writeSurveyCsv(res, steps, [], () => participantsOf(ids), {
      studyId: "study_1"
    });

    // The controls for the absence below, and what make it mean anything: the
    // hangup really did happen mid-export, so there was a live write for
    // `close` to settle, and the export really did stop for it.
    expect(res.chunks.length).toBeGreaterThanOrEqual(3);
    expect(res.chunks.length).toBeLessThan(ids.length);
    expect(res.writableEnded).toBe(false);

    // `logger.error` is proven able to fire by the test below, which drives a
    // real failure through the same mock.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("destroys the socket rather than ending it, when a row throws", async () => {
    const res = backpressuredResponse();

    async function* exploding() {
      yield { sessionId: "s1", answers: [answer("s1")] };
      throw new Error("batch read failed");
    }

    vi.mocked(logger.error).mockClear();

    await writeSurveyCsv(res, steps, [], () => exploding(), { studyId: "study" });

    // REFUSED, NOT TRUNCATED. `end()` here hands the researcher a CSV that
    // parses and holds part of their data.
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false);
    // The control arm for the hangup test above: this is the mock firing.
    expect(logger.error).toHaveBeenCalled();
  });
});

/**
 * A response that reports a full buffer and drains after a fixed delay.
 *
 * The case neither existing fake covers, and the one the whole-export deadline
 * is about: a client that IS reading, just slowly enough that no single write
 * ever hits the drain bound. Every wait here is legitimate on its own and the
 * export still never finishes.
 */
function slowlyDrainingResponse(
  drainAfterMs: number,
  stopDrainingAfterChunks = Number.POSITIVE_INFINITY
) {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  const res = emitter as unknown as Response &
    EventEmitter & { chunks: string[] };

  Object.assign(res, {
    chunks,
    destroyed: false,
    writableEnded: false,
    write: (chunk: string) => {
      chunks.push(chunk);
      // Stops reading part-way, which is how a client behaves when its user
      // closes the laptop lid or the network drops mid-download.
      if (chunks.length <= stopDrainingAfterChunks) {
        setTimeout(() => emitter.emit("drain"), drainAfterMs);
      }
      return false;
    },
    end: () => {
      (res as { writableEnded: boolean }).writableEnded = true;
    },
    destroy: () => {
      (res as { destroyed: boolean }).destroyed = true;
    }
  });

  return res;
}

/**
 * A response that accepts everything, so no write ever waits.
 *
 * This is the case where NEITHER timer can see the export: `res.write` returns
 * true every time, so the drain bound is never armed and the whole-export
 * timer has nothing to interrupt. What bounds it is the loop's own check of
 * the deadline signal - and without a fake like this, deleting that check
 * fails nothing.
 */
function acceptingResponse() {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  const res = emitter as unknown as Response &
    EventEmitter & { chunks: string[] };

  Object.assign(res, {
    chunks,
    destroyed: false,
    writableEnded: false,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {
      (res as { writableEnded: boolean }).writableEnded = true;
    },
    destroy: () => {
      (res as { destroyed: boolean }).destroyed = true;
    }
  });

  return res;
}

/**
 * A slow producer that IGNORES the deadline signal, deliberately.
 *
 * Not a strawman: the route tests' stand-in generators ignore it, and so does
 * the one `openSurveyCsvExport` returns when Postgres is unconfigured. A
 * deadline that only works when the generator co-operates is a deadline the
 * next generator can drop.
 */
async function* unhurriedParticipants(ids: string[], everyMs: number) {
  for (const id of ids) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    yield { sessionId: id, answers: [answer(id)] };
  }
}

const reasonsLogged = () =>
  vi
    .mocked(logger.error)
    .mock.calls.map(
      (call) => (call[1] as { reason?: string } | undefined)?.reason
    );

/**
 * THE BOUNDS ON AN EXPORT THAT NEVER FINISHES (cto/AdaptaLabs#5).
 *
 * Before these, `write` awaited `drain` with nothing racing it. `drain`,
 * `error` and `close` were the only three events that could settle it, and a
 * client whose TCP window is zero emits none of them - so the promise had no
 * reason ever to settle, and the request held the ONLY results-read permit
 * (MAX_CONCURRENT_RESULTS_READS is 1) for as long as the socket stayed open.
 * Every other admin, superadmin included, got 503 RESULTS_READ_QUEUE_FULL on
 * all four results routes. One authenticated caller, no data, no large study.
 *
 * Each assertion below is paired with a control, because the shape of these
 * tests is exactly the shape that passes vacuously: "the promise settled" is
 * also true of a probe that could not tell the difference.
 */
describe("bounding an export that never finishes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(logger.error).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("destroys a socket that never drains, rather than waiting forever", async () => {
    const res = stalledResponse();
    let settled = false;

    // Deliberately NOT awaited. A mutant that removes the bound leaves this
    // pending forever, and awaiting it would turn a regression into a runner
    // that hangs - a CI timeout with no failing test name, which is the
    // hardest kind of failure to read.
    void writeSurveyCsv(res, steps, [], () => participantsOf(["a"]), {
      studyId: "study_1"
    }).then(() => {
      settled = true;
    });

    // THE CONTROL FOR "it settled": just short of the bound it must NOT have.
    // Without this, a writer that gave up instantly - or one that never waited
    // for the socket at all - would pass the assertion below.
    await vi.advanceTimersByTimeAsync(SURVEY_CSV_DRAIN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(res.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(2);

    expect(settled).toBe(true);
    // REFUSED, NOT TRUNCATED. `end()` here hands back a one-line CSV that
    // parses, and a researcher computing a mean over a header row.
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false);
    expect(reasonsLogged()).toEqual(["drain_timeout"]);
  });

  it("leaves a socket that drains alone", async () => {
    // The other arm of the same probe. A writer that destroyed every export
    // would pass the test above; this is what says the bound fires only on the
    // stall.
    const res = slowlyDrainingResponse(1_000);

    let settled = false;
    void writeSurveyCsv(res, steps, [], () => participantsOf(["a", "b"]), {
      studyId: "study_1"
    }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(settled).toBe(true);
    expect(res.writableEnded).toBe(true);
    expect(res.destroyed).toBe(false);
    expect(res.chunks).toHaveLength(3);
    expect(reasonsLogged()).toEqual([]);
  });

  it("stops an export that is progressing but will never finish", async () => {
    // Every individual wait here is legitimate - 25 seconds is inside the
    // drain bound - so the per-write timeout alone cannot see this. Only the
    // whole-export deadline can.
    const res = slowlyDrainingResponse(25_000);
    const ids = Array.from({ length: 100 }, (_unused, i) => `s${i}`);

    let settled = false;
    void writeSurveyCsv(res, steps, [], () => participantsOf(ids), {
      studyId: "study_1"
    }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(SURVEY_CSV_EXPORT_DEADLINE_MS - 1_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(settled).toBe(true);
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false);
    expect(reasonsLogged()).toEqual(["export_deadline"]);

    // And it really did stop early rather than racing to the end: a header
    // plus one row per 25 seconds cannot be 101 chunks.
    expect(res.chunks.length).toBeLessThan(ids.length);
    expect(res.chunks.length).toBeGreaterThan(1);
  });

  it("aborts the signal the batch reads are watching", async () => {
    // The deadline has to reach the DATABASE side too, or it bounds only the
    // half of the export that waits on the socket - and a retrying batch read
    // (cto/AdaptaLabs#6) would run straight past it.
    const res = slowlyDrainingResponse(25_000);
    let seen: AbortSignal | undefined;

    void writeSurveyCsv(
      res,
      steps,
      [],
      (signal) => {
        seen = signal;
        return participantsOf(Array.from({ length: 100 }, (_u, i) => `s${i}`));
      },
      { studyId: "study_1" }
    );

    await vi.advanceTimersByTimeAsync(1_000);
    // The control: a signal that arrived already aborted would satisfy the
    // assertion below without any deadline existing.
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(SURVEY_CSV_EXPORT_DEADLINE_MS);

    expect(seen!.aborted).toBe(true);
    expect(seen!.reason).toMatchObject({ reason: "export_deadline" });
  });

  it("arms no timer that outlives the export", async () => {
    const res = slowlyDrainingResponse(1_000);

    let settled = false;
    void writeSurveyCsv(res, steps, [], () => participantsOf(["a", "b"]), {
      studyId: "study_1"
    }).then(() => {
      settled = true;
    });

    // THE CONTROL. A counter that read zero throughout would make the
    // assertion after the export vacuous, and both the deadline timer and the
    // per-write drain timer are meant to be armed at this point.
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(settled).toBe(true);
    // The whole-export deadline is five minutes. Left armed, it keeps a handle
    // - and the event loop - alive long after the response has gone.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a slow export that the socket never slows down", async () => {
    // No backpressure anywhere, and a generator that does not watch the
    // signal. Both timers are useless here; the loop's own deadline check is
    // the only thing left, which is exactly why this fake exists.
    const res = acceptingResponse();
    const ids = Array.from({ length: 100 }, (_unused, i) => `s${i}`);

    let settled = false;
    void writeSurveyCsv(
      res,
      steps,
      [],
      () => unhurriedParticipants(ids, 10_000),
      { studyId: "study_1" }
    ).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(SURVEY_CSV_EXPORT_DEADLINE_MS - 10_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(settled).toBe(true);
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false);
    expect(reasonsLogged()).toEqual(["export_deadline"]);
    expect(res.chunks.length).toBeLessThan(ids.length);
  });

  it("finishes a slow export that fits inside the deadline", async () => {
    // The control for the test above. Without it, a writer that destroyed
    // every unbackpressured export would pass just as well.
    const res = acceptingResponse();

    let settled = false;
    void writeSurveyCsv(
      res,
      steps,
      [],
      () => unhurriedParticipants(["a", "b", "c"], 10_000),
      { studyId: "study_1" }
    ).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toBe(true);
    expect(res.writableEnded).toBe(true);
    expect(res.destroyed).toBe(false);
    expect(res.chunks).toHaveLength(4);
  });

  it("does not let a late stall run past the deadline", async () => {
    // The deadline is a CEILING, not a suggestion. A client that stalls with
    // twenty seconds of budget left must be cut off at the deadline, not
    // twenty seconds after it - which is what a drain wait that ignores the
    // remaining budget would do.
    // Drains for fourteen chunks, so the FIFTEENTH - written at t=280s, with
    // twenty seconds of the deadline left - is the one that stalls.
    const res = slowlyDrainingResponse(20_000, 14);
    const ids = Array.from({ length: 100 }, (_unused, i) => `s${i}`);

    let settled = false;
    void writeSurveyCsv(res, steps, [], () => participantsOf(ids), {
      studyId: "study_1"
    }).then(() => {
      settled = true;
    });

    // The fifteenth chunk goes out at t=280s and nothing drains after it, so
    // the remaining budget - 20 seconds - is shorter than the drain bound.
    await vi.advanceTimersByTimeAsync(295_000);
    expect(settled).toBe(false);
    expect(res.chunks).toHaveLength(15);

    await vi.advanceTimersByTimeAsync(11_000);

    expect(settled).toBe(true);
    expect(res.destroyed).toBe(true);
    expect(reasonsLogged()).toEqual(["export_deadline"]);
  });

  it("aborts the signal it handed out once the export has ended", async () => {
    // NOT ONLY WHEN THE DEADLINE FIRES. A caller who hangs up leaves the loop
    // early with the generator suspended and a batch read or a retry backoff
    // still watching this signal; nothing else tells them to stop.
    //
    // It is also what makes the route's half of the plumbing observable - the
    // route tests hold the signal their stand-in was handed and assert it ends
    // up aborted, which is the only thing that separates the writer's own
    // signal from a substituted one. Without this the whole property is
    // unassertable without waiting five minutes.
    const res = acceptingResponse();
    let seen: AbortSignal | undefined;

    await writeSurveyCsv(
      res,
      steps,
      [],
      (signal) => {
        seen = signal;
        return participantsOf(["a", "b"]);
      },
      { studyId: "study_1" }
    );

    // A SUCCESSFUL export, deliberately: the abort must not be reachable only
    // through the failure path, or the route tests would be asserting the
    // deadline rather than the plumbing.
    expect(res.writableEnded).toBe(true);
    expect(res.destroyed).toBe(false);
    expect(seen!.aborted).toBe(true);

    // AND IT NEVER REACHES THE LOG. The abort is raised after the catch, so a
    // successful export must log nothing at all - a claim the file makes and
    // nothing pinned until a gate pointed out that this test asserted three
    // things and not that one.
    expect(reasonsLogged()).toEqual([]);
  });

  it("arms no timer when the export cannot even start", async () => {
    // The deadline timer used to be armed - and the factory called - ABOVE the
    // try whose finally clears it, so a factory that threw synchronously left
    // a five-minute timer holding the event loop open. Both review gates found
    // it with a probe: 300005ms to exit, against a control arm that exited in
    // 1ms.
    //
    // Unreachable through either route today, because calling an async
    // generator function cannot execute its body and so cannot throw. Pinned
    // anyway, because the symptom is a CI job that hangs with no named failing
    // test, and because `writeSurveyCsv` takes a plain function - the next
    // caller need not be a route.
    const res = acceptingResponse();

    // ASSERTED AS A RESOLUTION, not just awaited. With the factory call moved
    // back outside the try, this rejects - and a bare `await` would surface
    // that as an unhandled "the factory blew up", failing the test for a
    // reason its own name does not mention. This way the mutation fails on a
    // named assertion first.
    await expect(
      writeSurveyCsv(
        res,
        steps,
        [],
        () => {
          throw new Error("the factory blew up");
        },
        { studyId: "study_1" }
      )
    ).resolves.toBeUndefined();

    // The control for this counter being able to read non-zero is the
    // "arms no timer that outlives the export" test above, which watches it
    // rise mid-export and fall again.
    expect(vi.getTimerCount()).toBe(0);
    // And it is still a refusal rather than a tidy short file.
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it("pins both bounds as literals", () => {
    // LITERALS, not expressions over the constants. A test that derives its
    // expectation from the constant cannot see the constant change, and these
    // two are policy: the drain bound decides how long one admin can refuse
    // every other admin, and the deadline decides the ceiling on that.
    expect(SURVEY_CSV_DRAIN_TIMEOUT_MS).toBe(30_000);
    expect(SURVEY_CSV_EXPORT_DEADLINE_MS).toBe(300_000);

    // The relation matters as much as the numbers: a drain bound at or above
    // the whole-export deadline would make the deadline unreachable for a
    // stalled client, which is the case it exists for.
    expect(SURVEY_CSV_DRAIN_TIMEOUT_MS).toBeLessThan(
      SURVEY_CSV_EXPORT_DEADLINE_MS
    );
  });
});
