import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listening } from '../../__tests__/helpers/listening';
import express from 'express';

jest.mock('../../services/reminders', () => ({
  sendDueReminders: jest.fn(),
}));

import cronRouter from '../cron';
import { sendDueReminders } from '../../services/reminders';
import { errorHandler } from '../../utils/errorHandler';

const mockSendDueReminders = sendDueReminders as unknown as jest.Mock;

/**
 * `GET /api/cron/send-reminders` COMPARED ITS SECRET WITH `!==`.
 * cto/AdaptaLabs#22.
 *
 * TWO DIFFERENT PROPERTIES ARE PINNED HERE AND THEY NEED DIFFERENT KINDS OF
 * TEST, which is the part worth reading before adding to this file.
 *
 * The BEHAVIOUR is testable: a bearer token of the wrong length must produce a
 * 401 and not a 500. That is not a stylistic point - `timingSafeEqual` THROWS
 * on unequal-length buffers, so the obvious version of this fix turns every
 * wrong-length guess into an unhandled error, and the route's own catch turns
 * that into a 500. A 500 that only appears for wrong-length input is a longer
 * oracle than the timing side channel it replaced.
 *
 * The CONSTANT-TIME PROPERTY ITSELF IS NOT BEHAVIOURAL. `!==`,
 * `Buffer.equals` and `timingSafeEqual` all return exactly the same boolean for
 * every input; they differ only in how long they take to say so, and a timing
 * assertion on a shared CI runner is a flake generator. So it is pinned by
 * reading this source - the same device `gamification.leaderboard-limit.test.ts`
 * uses to stop a fourth route being added uncapped - and the scan carries a
 * CONTROL proving it can still see the defective shape when handed one.
 *
 * WHY DIGESTS RATHER THAN A LENGTH CHECK. Guarding `timingSafeEqual` with
 * `a.length === b.length` moves the leak instead of closing it: an early return
 * on length tells an attacker how long the secret is, which is the single most
 * useful thing to learn about it. Hashing both sides to a fixed 32 bytes means
 * no branch anywhere depends on what the caller sent.
 */

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use('/api/cron', cronRouter);
  a.use(errorHandler);
  return a;
})();

const PATH = '/api/cron/send-reminders';
const SECRET = 'a-cron-secret-of-a-particular-length';

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  mockSendDueReminders.mockResolvedValue({ sent: 0 } as never);
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_SECRET;
  }
});

describe('the cron secret comparison', () => {
  // ------------------------------------------------------------------
  // THE CONTROL. Every refusal below is worthless against a route that refuses
  // everything, so this proves the correct token still gets through this exact
  // fixture.
  // ------------------------------------------------------------------
  it('runs the reminder job for the correct bearer token', async () => {
    const res = await request(listening(app)).get(PATH).set('Authorization', `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(mockSendDueReminders).toHaveBeenCalled();
  });

  it('refuses a bearer token of the same length as the secret', async () => {
    const wrong = 'b'.repeat(SECRET.length);

    const res = await request(listening(app)).get(PATH).set('Authorization', `Bearer ${wrong}`);

    expect(res.status).toBe(401);
    expect(mockSendDueReminders).not.toHaveBeenCalled();
  });

  // The one a naive `timingSafeEqual` fix fails: unequal-length buffers THROW,
  // and the throw arrives as a 500 rather than a refusal.
  it('refuses a bearer token far shorter than the secret without throwing', async () => {
    const res = await request(listening(app)).get(PATH).set('Authorization', 'Bearer x');

    expect(res.status).toBe(401);
    expect(mockSendDueReminders).not.toHaveBeenCalled();
  });

  it('refuses a bearer token far longer than the secret without throwing', async () => {
    const res = await request(listening(app))
      .get(PATH)
      .set('Authorization', `Bearer ${'x'.repeat(4096)}`);

    expect(res.status).toBe(401);
    expect(mockSendDueReminders).not.toHaveBeenCalled();
  });

  it('refuses a request that sends no Authorization header at all', async () => {
    const res = await request(listening(app)).get(PATH);

    expect(res.status).toBe(401);
    expect(mockSendDueReminders).not.toHaveBeenCalled();
  });

  it('refuses a header that is the bare secret without the Bearer scheme', async () => {
    const res = await request(listening(app)).get(PATH).set('Authorization', SECRET);

    expect(res.status).toBe(401);
    expect(mockSendDueReminders).not.toHaveBeenCalled();
  });

  // An unset CRON_SECRET must refuse EVERYTHING. The digest comparison would
  // otherwise happily match a caller who also sends nothing, because
  // `Bearer undefined` is a perfectly comparable string.
  it('refuses every request when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;

    const missing = await request(listening(app)).get(PATH);
    const guessed = await request(listening(app))
      .get(PATH)
      .set('Authorization', 'Bearer undefined');
    const empty = await request(listening(app)).get(PATH).set('Authorization', 'Bearer ');

    expect(missing.status).toBe(401);
    expect(guessed.status).toBe(401);
    expect(empty.status).toBe(401);
    expect(mockSendDueReminders).not.toHaveBeenCalled();
  });
});

/**
 * THE LENGTH ORACLE, WHICH THE REST OF THIS FILE COULD NOT SEE.
 *
 * The refute gate on !253 replaced the body of `bearerMatches` with a version
 * that kept BOTH `createHash` and `timingSafeEqual` and simply short-circuited
 * first:
 *
 *   if (supplied.length !== expected.length) return false;
 *   return timingSafeEqual(digest(supplied), digest(expected));
 *
 * It type-checked, and the full backend jest run - 69 suites, 1158 tests -
 * passed. That is the precise defect the docblock on `bearerMatches` claims to
 * have closed: an early return on length tells a caller how long the secret is.
 * A guard that cannot detect the thing its own comment names is worse than no
 * guard, because it stops anybody looking.
 *
 * IT IS DETECTABLE BEHAVIOURALLY AFTER ALL, which is what makes this a test
 * rather than a stricter scan. The mutation and the real thing return the same
 * boolean for every input - that is why the seven request-level arms above miss
 * it - but they do not do the same WORK: a short circuit computes NO digests,
 * and the real comparison computes two whatever the caller sent. Counting
 * `createHash` calls is a total, deterministic assertion with no timing in it.
 */
describe('the cron secret comparison does no length short circuit', () => {
  /**
   * THE MODULE OBJECT `cron.ts` ACTUALLY CALLS THROUGH, which is not the one
   * `import * as nodeCrypto from 'node:crypto'` gives this file.
   *
   * With `esModuleInterop` a namespace import of a CommonJS module is compiled
   * to `__importStar(require(...))`, which builds a COPY - so a spy installed on
   * it is never consulted by the router. The first version of this suite did
   * exactly that and reported ZERO hashes for every request, correct token
   * included. Its own control arm is what caught it: an assertion that a
   * counter reads 2 for a wrong-length token is satisfied by a broken spy just
   * as well as by a broken guard, and only the arm that MUST see the counter
   * move could tell those apart.
   *
   * `jest.requireActual` returns the live singleton, the same object cron.ts's
   * own `require('node:crypto')` resolved to.
   */
  const nodeCrypto = jest.requireActual<typeof import('node:crypto')>('node:crypto');

  let algorithms: unknown[] = [];
  let spy: ReturnType<typeof jest.spyOn>;

  /**
   * COUNTS SHA-256 SPECIFICALLY, because a request makes three hashes and only
   * two of them are this guard's. Measured rather than assumed: a probe against
   * this exact fixture recorded `["sha256","sha256","sha1"]`, the sha1 being
   * express's own ETag over the JSON response body.
   *
   * Asserting the raw count of 3 would have passed just as well and pinned an
   * incidental property of express's response handling - so a future
   * `etag: false` would fail this suite for a reason its name does not describe.
   */
  const guardDigests = () => algorithms.filter((a) => a === 'sha256').length;

  beforeEach(() => {
    algorithms = [];
    const real = nodeCrypto.createHash;
    spy = jest.spyOn(nodeCrypto, 'createHash').mockImplementation(((...args: unknown[]) => {
      algorithms.push(args[0]);
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  // The real comparison hashes BOTH sides before it can say anything, so the
  // work it does is identical whatever the caller sent. These three lengths
  // straddle the secret's own.
  it.each([
    ['far shorter than the secret', 'Bearer x'],
    ['exactly the length of the secret', `Bearer ${'b'.repeat(SECRET.length)}`],
    ['far longer than the secret', `Bearer ${'x'.repeat(4096)}`],
  ])('still hashes both sides for a token %s', async (_label, header) => {
    const res = await request(listening(app)).get(PATH).set('Authorization', header);

    expect(res.status).toBe(401);
    expect(guardDigests()).toBe(2);
  });

  // THE CONTROL. The three arms above assert a count of 2, which a spy wired to
  // the wrong module would report as 0 for every input including a correct
  // token - so the counter has to be shown moving on the path that certainly
  // reaches the comparison.
  it('hashes both sides for the correct token too', async () => {
    const res = await request(listening(app)).get(PATH).set('Authorization', `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(guardDigests()).toBe(2);
  });
});

/**
 * The scan, for what the call counter cannot see. Swapping `timingSafeEqual`
 * for `Buffer.equals` ON THE DIGESTS computes the same two hashes and returns
 * the same boolean, so only reading the source tells them apart.
 */
describe('the cron secret comparison is constant time', () => {
  const SOURCE = readFileSync(join(__dirname, '..', 'cron.ts'), 'utf8');

  /**
   * A comparison that returns at the first differing byte, OR on a length.
   *
   * The `.length` arm is the one the gate needed. It was absent, so a
   * `supplied.length !== expected.length` pre-check read as clean.
   */
  const hasShortCircuitingSecretCompare = (source: string): boolean =>
    /authHeader\s*(!==|===)/.test(source) ||
    /(!==|===)\s*`Bearer/.test(source) ||
    /\.length\s*(!==|===)/.test(source);

  it('compares digests through timingSafeEqual rather than string equality', () => {
    // The CALL, not the import. `toContain('timingSafeEqual')` was satisfied by
    // the import line alone, which is how a body with no comparison in it at all
    // would have passed.
    expect(SOURCE).toContain('return timingSafeEqual(digest(');
    expect(hasShortCircuitingSecretCompare(SOURCE)).toBe(false);
  });

  // THE CONTROL ARM. An assertion that the defective shape is absent passes
  // just as well when the detector is broken, and a detector that can never
  // fire is indistinguishable from a clean file. One sample per arm, including
  // the length pre-check the gate got past.
  it.each([
    ['the short-circuiting comparison it replaced', 'if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {'],
    ['a length pre-check in front of the digests', 'if (supplied.length !== expected.length) return false;'],
    ['a bare comparison against the Bearer template', 'return value === `Bearer ${cronSecret}`;'],
  ])('still recognises %s', (_label, sample) => {
    expect(hasShortCircuitingSecretCompare(sample)).toBe(true);
  });

  // And the detector must not fire on the code that is actually there, or the
  // arms above would pass for the wrong reason.
  it('does not fire on a comparison that hashes first', () => {
    expect(
      hasShortCircuitingSecretCompare(
        "return timingSafeEqual(digest(authHeader ?? ''), digest(`Bearer ${cronSecret}`));"
      )
    ).toBe(false);
  });
});
