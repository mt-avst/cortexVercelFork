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

/**
 * PORT AND CORS_ORIGIN FAIL CLOSED TOO (#48).
 *
 * The follow-up #4 deliberately left behind, because NODE_ENV was the only field
 * whose coercion disabled a SECURITY control and bundling the rest would have made
 * one deploy-risk decision unreviewable. These two are availability, not security.
 *
 * MEASURED BEFORE THE CHANGE, on the schema as it stood: `PORT=abc` parsed to
 * **NaN** and `PORT=''` parsed to **0**, because `.catch(() => 3001)` never fired -
 * `z.string().transform(Number)` RETURNS NaN rather than throwing, so there was
 * nothing to catch. `app.listen(NaN)` binds an ephemeral port, so the Kubera
 * readiness probe on 3001 never passes and no log line says why. `CORS_ORIGIN=not
 * a url` became `http://localhost:3000` in silence, which reaches an operator as
 * browser CORS errors rather than as a config fault.
 *
 * EVERY REFUSAL ARM HAS A CONTROL. A schema that refused every value would satisfy
 * all the `toThrow` arms perfectly, so the usable values and the UNSET case are
 * asserted beside them - the unset case in particular, because `npm run dev` sets
 * neither and must keep working.
 *
 * 3001 AND http://localhost:3000 ARE WRITTEN AS LITERALS here, not read off the
 * schema. A test that derives its expectation from the default cannot see the
 * default change.
 */
const ORIGINAL_PORT = process.env.PORT;
const ORIGINAL_CORS_ORIGIN = process.env.CORS_ORIGIN;

const setVar = (name: 'PORT' | 'CORS_ORIGIN', value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

afterEach(() => {
  setVar('PORT', ORIGINAL_PORT);
  setVar('CORS_ORIGIN', ORIGINAL_CORS_ORIGIN);
});

describe('backend PORT validation', () => {
  // 'abc' is the whole defect: it did NOT throw before, it produced NaN.
  // '' is the unresolved `${...}` in a chart. '-1' and '0' are not ports.
  // '3.5' and '99999' are the plausible fat-fingers either side of the range.
  it.each(['abc', '', '-1', '0', '3.5', '80abc'])(
    'refuses to boot on the unusable PORT %p',
    (value) => {
      setVar('PORT', value);
      expect(() => validateBackendEnvironment()).toThrow(/PORT/);
    }
  );

  // CONTROL ARM. Without it, a schema that refused every PORT reads as a pass.
  it.each(['3001', '8080', '1'])('still boots on the usable PORT %s', (value) => {
    setVar('PORT', value);
    expect(validateBackendEnvironment().PORT).toBe(Number(value));
  });

  it('treats an UNSET PORT as 3001, because npm run dev sets nothing', () => {
    setVar('PORT', undefined);
    expect(validateBackendEnvironment().PORT).toBe(3001);
  });

  // The regression arm, and the reason this ticket exists at all. `NaN === NaN`
  // is false, so `toBe(NaN)` cannot be written by accident - `Number.isNaN` on
  // the parsed value is what would have caught this before.
  it('never yields NaN for a non-numeric PORT, which listen would bind as an ephemeral port', () => {
    setVar('PORT', 'abc');

    let parsed: unknown = 'did not parse';
    try {
      parsed = validateBackendEnvironment().PORT;
    } catch {
      parsed = 'refused';
    }

    expect(parsed).toBe('refused');
    expect(Number.isNaN(parsed)).toBe(false);
  });

  it('names PORT in the boot failure so an on-call engineer sees which variable', () => {
    setVar('PORT', 'abc');
    expect(() => validateBackendEnvironment()).toThrow('PORT: Expected number, received nan');
  });
});

describe('backend CORS_ORIGIN validation', () => {
  it.each(['not a url', '', '//example.com', 'example.com'])(
    'refuses to boot on the malformed CORS_ORIGIN %p',
    (value) => {
      setVar('CORS_ORIGIN', value);
      expect(() => validateBackendEnvironment()).toThrow(/CORS origin must be a valid URL/);
    }
  );

  /**
   * WHAT `.url()` DOES NOT CHECK, asserted rather than assumed.
   *
   * zod 3's `.url()` is `new URL()`, which parses ANY scheme - so `localhost:3000`
   * is read as the scheme `localhost:` with the path `3000`, and `htp://` is a
   * perfectly good URL that no browser Origin header will ever match. Both are
   * accepted here today. That is a separate defect from #48's silent coercion -
   * this one is a validator that is too loose, not one that is bypassed - and
   * pinning it as an ACCEPTANCE keeps the change honest about what it did and did
   * not fix. See the ponytail note on CORS_ORIGIN.
   */
  it.each(['localhost:3000', 'htp://example.com'])(
    'accepts the scheme-shaped CORS_ORIGIN %p today, which url() cannot see',
    (value) => {
      setVar('CORS_ORIGIN', value);
      expect(validateBackendEnvironment().CORS_ORIGIN).toBe(value);
    }
  );

  // CONTROL ARM. `.kubera/playground-backend.yaml` sets exactly this shape.
  it.each(['http://localhost:3000', 'https://adaptalabs.kubera-playground.adaptavist.net'])(
    'still boots on the valid CORS_ORIGIN %s',
    (value) => {
      setVar('CORS_ORIGIN', value);
      expect(validateBackendEnvironment().CORS_ORIGIN).toBe(value);
    }
  );

  it('treats an UNSET CORS_ORIGIN as http://localhost:3000', () => {
    setVar('CORS_ORIGIN', undefined);
    expect(validateBackendEnvironment().CORS_ORIGIN).toBe('http://localhost:3000');
  });

  // The regression arm: the old `.catch()` answered a malformed value with the
  // localhost default, which is indistinguishable from having set nothing.
  it('does not silently substitute the localhost default for a malformed value', () => {
    setVar('CORS_ORIGIN', 'not a url');

    let parsed: unknown = 'did not parse';
    try {
      parsed = validateBackendEnvironment().CORS_ORIGIN;
    } catch {
      parsed = 'refused';
    }

    expect(parsed).toBe('refused');
    expect(parsed).not.toBe('http://localhost:3000');
  });
});
