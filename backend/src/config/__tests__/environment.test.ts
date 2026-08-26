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
  // '3.5' is the plausible fat-finger below the range.
  //
  // '99999', '65536' and '1e5' are the OTHER side of the range, and until #59
  // they were all accepted - this comment named '99999' as covered while the
  // array did not contain it, which is exactly the shape of claim this repo
  // keeps getting bitten by. Measured before the fix: 99999 and 100000 both
  // parsed clean and failed later inside `app.listen()`.
  it.each(['abc', '', '-1', '0', '3.5', '80abc', '65536', '99999', '1e5'])(
    'refuses to boot on the unusable PORT %p',
    (value) => {
      setVar('PORT', value);
      expect(() => validateBackendEnvironment()).toThrow(/PORT/);
    }
  );

  // CONTROL ARM. Without it, a schema that refused every PORT reads as a pass.
  // 65535 is in here as a LITERAL and it is the point of the arm above: a
  // `.max()` set one too low would refuse the highest bindable port and this
  // is the only thing that would notice.
  it.each(['3001', '8080', '1', '65535'])('still boots on the usable PORT %s', (value) => {
    setVar('PORT', value);
    expect(validateBackendEnvironment().PORT).toBe(Number(value));
  });

  // The ceiling written down as a literal on both sides, so a change to it is a
  // named failure rather than a silent widening. 65535 is the largest value a
  // 16-bit port field holds; 65536 is the first that is not a port at all.
  it('names 65535 as the ceiling and 65536 as over it', () => {
    setVar('PORT', '65535');
    expect(validateBackendEnvironment().PORT).toBe(65535);

    setVar('PORT', '65536');
    expect(() => validateBackendEnvironment()).toThrow(
      'PORT: Number must be less than or equal to 65535'
    );
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
   * WHAT `.url()` DOES NOT CHECK (#59).
   *
   * THIS ARM USED TO BE AN ACCEPTANCE, and flipping it is the whole of #59.
   * #48 pinned `localhost:3000` and `htp://example.com` as values the schema
   * took, on purpose, so that "we did not fix this" was written down rather
   * than assumed. zod 3's `.url()` is `new URL()`, which parses ANY scheme -
   * `localhost:3000` is read as the scheme `localhost:` with the path `3000`,
   * which is exactly what somebody types when they mean `http://localhost:3000`.
   *
   * A browser `Origin` header is always `scheme://host[:port]` with a
   * lower-cased scheme, and the cors() middleware in backend/src/index.ts
   * compares it to this string, so each of these boots and then matches
   * nothing. `ftp:` and `javascript:` are here because the refine has to be a
   * scheme allowlist rather than a `htp:` denylist, and `HTTPS://EXAMPLE.COM`
   * because an upper-cased scheme is a perfectly good URL that no browser will
   * ever send.
   *
   * NO PARENTHESES IN THE TITLE, deliberately. The mutation canary selects the
   * test it pins with jest's `-t`, which is a REGEX, so an `http(s)` in the
   * title would select nothing and grade as TEST_MISSING rather than KILLED.
   */
  it.each([
    'localhost:3000',
    'htp://example.com',
    'ftp://example.com',
    'javascript:alert(1)',
    'HTTPS://EXAMPLE.COM',
    // ONE SLASH. `new URL()` normalises `http:/x.com` to `http://x.com/`, but
    // zod returns the string as written, so what reaches cors() is the broken
    // form. Refused rather than repaired, and written down here because a
    // narrowing nobody records is a narrowing somebody rediscovers in an
    // incident.
    'http:/x.com'
  ])('refuses to boot on the non-http scheme CORS_ORIGIN %p', (value) => {
    setVar('CORS_ORIGIN', value);
    expect(() => validateBackendEnvironment()).toThrow(/CORS origin must be an http\(s\) URL/);
  });

  /**
   * PADDING IS TRIMMED, NOT PRESERVED (#59).
   *
   * `' https://x.com '` used to validate and keep its spaces - measured - and a
   * padded value matches no Origin header for the same reason a bad scheme
   * does. This is the likelier accident of the two: a trailing space in a chart
   * value or an `.env` line is invisible in review.
   *
   * Asserting the RESULT rather than that it merely parses, because the padded
   * value PARSES EITHER WAY: `new URL(' https://x.com ')` succeeds, since the
   * WHATWG parser strips leading and trailing C0-and-space itself. A "does not
   * throw" assertion here would be decorative.
   *
   * WHAT AN EARLIER VERSION OF THIS DOCBLOCK GOT WRONG. It said a `.trim()`
   * running after `.url()` would leave the spaces on. It would not: the refine
   * and the result both see the trimmed value under either order, and the
   * refute gate on !272 measured the swapped schema passing all 47 arms of this
   * file. The order IS load-bearing, but only for whitespace
   * `String.prototype.trim()` strips and the URL parser does not - which is why
   * the U+00A0 arm below exists. Without it, nothing here can see the order.
   */
  it('trims a space-padded CORS_ORIGIN rather than carrying the padding into the cors origin', () => {
    setVar('CORS_ORIGIN', ' https://x.com ');
    expect(validateBackendEnvironment().CORS_ORIGIN).toBe('https://x.com');
  });

  it('trims tab and newline padding too, which is what an unresolved chart value leaves', () => {
    setVar('CORS_ORIGIN', '\thttp://localhost:3000\n');
    expect(validateBackendEnvironment().CORS_ORIGIN).toBe('http://localhost:3000');
  });

  /**
   * THE ARM THAT MAKES `.trim()` BEFORE `.url()` LOAD-BEARING.
   *
   * A non-breaking space is what a value pasted out of a wiki page, a Slack
   * message or a rendered document carries, and it is invisible in every review
   * tool there is. `String.prototype.trim()` strips U+00A0 and U+3000; the
   * WHATWG URL parser strips neither.
   *
   * Measured on both orders: with `.trim()` first both are accepted and
   * normalised; with `.url()` first both are REFUSED as malformed. So this is
   * the only arm in the file that fails when the two are swapped, and the
   * choice it pins is the permissive one - forgive the paste, do not fail the
   * boot over a character nobody can see.
   *
   * The characters are written as escapes and the title is plain ASCII, so the
   * canary can select this test with jest's `-t` regex and so a reviewer can
   * tell which whitespace is meant without measuring the pixels.
   */
  it('trims a non-breaking space, which the URL parser leaves in place', () => {
    // U+00A0, what a value pasted out of a rendered page carries.
    setVar('CORS_ORIGIN', '\u00a0https://x.com\u00a0');
    expect(validateBackendEnvironment().CORS_ORIGIN).toBe('https://x.com');

    // U+3000, the ideographic space. Same class, different keyboard.
    setVar('CORS_ORIGIN', '\u3000https://x.com');
    expect(validateBackendEnvironment().CORS_ORIGIN).toBe('https://x.com');
  });

  // CONTROL ARM. `.kubera/playground-backend.yaml` sets exactly this shape, and
  // without this a schema that refused EVERY origin would satisfy both refusal
  // arms above perfectly.
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

/**
 * THE NORMALISED ORIGIN REACHES THE OTHER ELEVEN READERS (#59).
 *
 * Raised by the refute gate on !272, which measured the gap rather than
 * reasoning about it. zod parses a COPY of `process.env`, so trimming
 * `CORS_ORIGIN` in the schema fixes `config.CORS_ORIGIN` - two readers, both in
 * backend/src/index.ts - and leaves `process.env.CORS_ORIGIN` padded for the
 * ELEVEN readers that use it directly: routes/auth.ts x6, routes/userCalendar.ts
 * x2, services/userCalendar.ts x3, every one a redirect target or an OAuth
 * callback URL built by concatenation.
 *
 * The SCHEME half needed nothing here: a bad scheme stops the boot, so those
 * eleven never run. The PADDING half did. Measured against real express before
 * the write-back, `res.redirect(process.env.CORS_ORIGIN)` at auth.ts:300
 * answered `302` with `location: "%20https://x.com%20"` - a relative-path
 * redirect to a route that does not exist.
 *
 * `backend/src/config/index.ts` is where it belongs rather than inside
 * `validateBackendEnvironment`: a function called "validate" that mutates the
 * process environment is a surprise, and the eleven readers are a backend
 * concern, not a shared-schema one.
 */
describe('backend CORS_ORIGIN normalisation reaching process.env', () => {
  const importConfig = (): void => {
    jest.isolateModules(() => {
      require('../index');
    });
  };

  afterEach(() => {
    setVar('CORS_ORIGIN', ORIGINAL_CORS_ORIGIN);
  });

  it('writes the trimmed origin back, so a padded value cannot reach a redirect', () => {
    setVar('CORS_ORIGIN', ' https://x.com ');

    importConfig();

    expect(process.env.CORS_ORIGIN).toBe('https://x.com');
  });

  /**
   * THE CONTROL, and it is the reason the write-back is conditional.
   *
   * Assigning unconditionally would put the schema default into a variable
   * nobody set - and those eleven readers are chains like
   * `process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3001'`,
   * so an unset variable resolving to the CORS default would silently change
   * which fallback wins. Without this arm, that regression reads as a pass.
   */
  it('leaves an UNSET CORS_ORIGIN unset rather than filling in the schema default', () => {
    setVar('CORS_ORIGIN', undefined);

    importConfig();

    expect(process.env.CORS_ORIGIN).toBeUndefined();
  });

  // A value that needed no normalising must come back byte-identical, so the
  // write-back cannot be mistaken for a pass when it is rewriting things it
  // should not touch.
  it('leaves an already-clean CORS_ORIGIN exactly as it was', () => {
    setVar('CORS_ORIGIN', 'https://adaptalabs.kubera-playground.adaptavist.net');

    importConfig();

    expect(process.env.CORS_ORIGIN).toBe('https://adaptalabs.kubera-playground.adaptavist.net');
  });
});
