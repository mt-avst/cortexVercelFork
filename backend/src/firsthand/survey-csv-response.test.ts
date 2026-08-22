import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Response } from "express";

vi.mock("../utils/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { writeSurveyCsv } from "./survey-csv-response";
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
      participantsOf(["a", "b", "c"]),
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

    const writing = writeSurveyCsv(res, steps, [], withAGhost(), {
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
      participantsOf(["a"]),
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

    await writeSurveyCsv(res, steps, [], participantsOf(ids), { studyId: "study" });

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

    await writeSurveyCsv(res, steps, [], generator, { studyId: "study" });

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
      writeSurveyCsv(res, steps, [], generator, { studyId: "study" })
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

    await writeSurveyCsv(res, steps, [], participantsOf(ids), {
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

    await writeSurveyCsv(res, steps, [], exploding(), { studyId: "study" });

    // REFUSED, NOT TRUNCATED. `end()` here hands the researcher a CSV that
    // parses and holds part of their data.
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false);
    // The control arm for the hangup test above: this is the mock firing.
    expect(logger.error).toHaveBeenCalled();
  });
});
