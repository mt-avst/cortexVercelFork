import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listening } from '../__tests__/helpers/listening';

// The deep-health probe is the one piece of index.ts that wants a database on
// import. Same double as health-endpoint.test.ts, inline jest.fn() to avoid TDZ.
jest.mock('../utils/deepHealth', () => ({
  createDatabaseHealthProbe: jest.fn(() => jest.fn()),
  DEEP_HEALTH_TIMEOUT_MS: 2000,
  DEEP_HEALTH_CACHE_MS: 1000,
}));

// The REAL app, for its real middleware chain. A hand-built copy would pin
// nothing: the whole point is what `express.json()` was configured with in
// index.ts, not what a test could configure it with.
import app, { BODY_SIZE_LIMIT } from '../index';

/**
 * THE PARSED BODY LIMIT IS NOW A DECISION. cto/AdaptaLabs#22.
 *
 * `express.json()` was called with NO `limit`, so the app ran on the
 * framework's 100 kB default. Nothing was broken by that - what was broken is
 * that three routes accepting unbounded arrays had this default as their ONLY
 * bound, which means the size of a request those routes would accept was set
 * by a number nobody in this repository had ever chosen, in a call that says
 * nothing about arrays.
 *
 * SO THE VALUE DID NOT CHANGE, deliberately: '100kb' is express's own default
 * and today's behaviour is byte-for-byte what it was. The change is that
 * raising it is now a visible edit to a named constant with a docblock, rather
 * than a silent widening of every array bound in the app at once. Those arrays
 * carry their own ceiling too - see `time-slot-batch-bound.test.ts` - because a
 * body limit is the wrong instrument for "how many sessions may I create".
 *
 * Asserted as a STRING LITERAL rather than read from `BODY_SIZE_LIMIT`. A test
 * that derives its expectation from the constant cannot see the constant
 * change, and this is a constant whose whole purpose is to be noticed when
 * somebody moves it.
 */
describe('the parsed request body limit', () => {
  it('holds the body size limit at the value that was decided', () => {
    expect(BODY_SIZE_LIMIT).toBe('100kb');
  });

  it('refuses a JSON body larger than the limit', async () => {
    // Comfortably past 100 kB once serialised.
    const body = { blob: 'x'.repeat(200 * 1024) };

    const res = await request(listening(app)).post('/api/health').send(body);

    expect(res.status).toBe(413);
  });

  // THE CONTROL. A 413 on an over-limit body proves nothing if the app answers
  // 413 to every POST, so a body comfortably under the limit must get past the
  // parser and reach routing - a 404 here, which is a route decision and
  // therefore evidence the parser was happy.
  it('parses a JSON body under the limit', async () => {
    const body = { blob: 'x'.repeat(1024) };

    const res = await request(listening(app)).post('/api/health').send(body);

    expect(res.status).not.toBe(413);
  });

  it('refuses an over-limit urlencoded body too', async () => {
    const res = await request(listening(app))
      .post('/api/health')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`blob=${'x'.repeat(200 * 1024)}`);

    expect(res.status).toBe(413);
  });
});

/**
 * THE ONE THING THE BEHAVIOURAL ARMS ABOVE CANNOT SEE.
 *
 * '100kb' IS express's default, so deleting `{ limit: BODY_SIZE_LIMIT }` and
 * going back to a bare `express.json()` produces byte-identical behaviour -
 * every 413 above still fires, and the whole point of the ticket quietly
 * reverts. The regression here is that the number stops being a decision, and
 * "is it a decision" is a property of the source rather than of a response.
 *
 * So this reads index.ts, and carries a control proving the scan can still see
 * the unconfigured call it exists to forbid.
 */
describe('the body limit is wired, not merely declared', () => {
  const SOURCE = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

  /** Every body parser mounted with no explicit limit. */
  const unconfiguredParsers = (source: string): string[] =>
    (source.match(/express\.(json|urlencoded)\([^)]*\)/g) ?? []).filter(
      (call) => !call.includes('limit:')
    );

  /**
   * BOTH PARSERS GET THE EXACT CALL ASSERTED, not merely the substring `limit:`.
   *
   * The refute gate on !253 got `express.urlencoded({ extended: true, limit: undefined })`
   * past the full 1158-test jest run, because only `express.json` had an exact
   * assertion and `unconfiguredParsers` was satisfied by the four characters
   * `limit:` appearing anywhere in the call. `limit: process.env.BODY_LIMIT`
   * with the variable unset is the same hole and is far more likely to be
   * written by accident.
   */
  it('passes the constant to both body parsers', () => {
    expect(SOURCE).toContain('express.json({ limit: BODY_SIZE_LIMIT })');
    expect(SOURCE).toContain('express.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT })');
    expect(unconfiguredParsers(SOURCE)).toEqual([]);
  });

  it('still recognises a body parser mounted with no limit', () => {
    expect(unconfiguredParsers('app.use(express.json());')).toEqual(['express.json()']);
  });
});
