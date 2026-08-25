/**
 * NODE_ENV FAILS CLOSED (#4).
 *
 * Every security control in backend/src/index.ts is keyed off
 * `config.NODE_ENV === 'production'`: helmet, CSRF, `cookie.secure`,
 * `cookie.sameSite`, `cookie.domain`, `trust proxy` (and so every rate limiter's
 * keying). shared/config/environment used to end that field with
 * `.catch(() => 'development')`, so `staging`, `prod`, `Production` or a typo
 * resolved silently to 'development' and turned all of it off in a deployment that
 * believed it was production.
 *
 * Reproduced at the real entry point before the fix - `NODE_ENV=prod npx tsx
 * backend/src/index.ts` started and logged `"environment":"development"`,
 * `"csrfEnabled":false` and `Development mode: Helmet disabled to allow DevTools`.
 *
 * Two arms, both required. A change that refuses EVERY value satisfies the
 * refusal arm perfectly, so the three recognised values and the unset case are
 * asserted here as controls rather than assumed.
 */

import { NODE_ENVS, validateBackendEnvironment } from '../../../../shared/config/environment';

/**
 * THE PERMITTED SET, as a literal.
 *
 * Written out here rather than derived from NODE_ENVS, so adding a fourth environment
 * fails this file by name and becomes a visible decision. The message assertion at the
 * bottom spells the same three names out a third time, for the same reason.
 *
 * Read off the exported const rather than off the schema's internals on purpose:
 * `removeDefault()` exists on `ZodDefault` and not on `ZodCatch`, so reaching into the
 * schema would make the mutation canary's mutation fail to COMPILE rather than fail
 * this test - and a mutation that does not build proves nothing.
 */
const PERMITTED_NODE_ENVS = ['development', 'production', 'test'];

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

const setNodeEnv = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
};

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV);
});

describe('backend NODE_ENV validation', () => {
  it('permits exactly three environments, named as literals', () => {
    expect([...NODE_ENVS]).toEqual(PERMITTED_NODE_ENVS);
  });

  // REFUSAL ARM. 'prod' and 'Production' are the plausible typos, 'staging' is the
  // plausible unmodelled environment, and 'PRODUCTION' is the casing mistake.
  it.each(['prod', 'Production', 'PRODUCTION', 'staging', 'stage', 'dev', 'live'])(
    'refuses to boot on the unrecognised NODE_ENV %s',
    (value) => {
      setNodeEnv(value);
      expect(() => validateBackendEnvironment()).toThrow(/NODE_ENV/);
    }
  );

  // CONTROL ARM. Not optional: without it, a change that refuses everything looks
  // like a pass.
  it.each(PERMITTED_NODE_ENVS)('still boots on the recognised NODE_ENV %s', (value) => {
    setNodeEnv(value);
    expect(validateBackendEnvironment().NODE_ENV).toBe(value);
  });

  it('treats an UNSET NODE_ENV as development, because npm run dev sets nothing', () => {
    setNodeEnv(undefined);
    expect(validateBackendEnvironment().NODE_ENV).toBe('development');
  });

  // The empty string is a variable something deliberately wrote - most plausibly an
  // unresolved ${...} in a chart or a compose file - so it carries a failed intent
  // that an absent name does not. It refuses, and this pins that choice.
  it('refuses an EMPTY NODE_ENV rather than treating it as unset', () => {
    setNodeEnv('');
    expect(() => validateBackendEnvironment()).toThrow(/NODE_ENV/);
  });

  /**
   * THE MESSAGE IS THE POINT.
   *
   * A boot failure saying "invalid config" costs an on-call engineer twenty minutes;
   * one that names the value it got and the values it wanted costs twenty seconds.
   * Pinned as an exact literal, which also pins the permitted set: zod 3 builds this
   * string, and a zod upgrade that drops the received value (zod 4 does) fails here
   * by name instead of degrading the message quietly.
   */
  it('names the offending value and lists the permitted ones', () => {
    setNodeEnv('prod');

    expect(() => validateBackendEnvironment()).toThrow(
      "NODE_ENV: Invalid enum value. Expected 'development' | 'production' | 'test', received 'prod'"
    );
  });

  /**
   * AT BOOT, NOT ON FIRST REQUEST.
   *
   * backend/src/config/index.ts calls getBackendConfig() at module scope, so the
   * throw lands on import - before index.ts binds a port and before the Kubera
   * initContainer's migrate/seed touches the database. A pod that never starts is a
   * visible CrashLoopBackOff. A pod that starts and then 500s every request gets
   * rolled out over the healthy one.
   */
  it('throws when the config module is imported, not when a request arrives', () => {
    setNodeEnv('prod');

    expect(() => {
      jest.isolateModules(() => {
        require('../index');
      });
    }).toThrow(/NODE_ENV/);
  });
});
