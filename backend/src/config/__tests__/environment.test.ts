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

  /**
   * A PATH IS NORMALISED AWAY, NOT REFUSED (#64).
   *
   * MEASURED BEFORE THE FIX, against the schema as it then stood - these are
   * the three values this arm used to accept unchanged:
   *   'http://x.com/'           -> 'http://x.com/'
   *   'https://x.com/app'       -> 'https://x.com/app'
   *   'https://x.com/a/b?q=1#f' -> 'https://x.com/a/b?q=1#f'
   * A browser Origin header is scheme://host[:port] with no path and no
   * trailing slash, and the cors middleware in backend/src/index.ts compares
   * the header to this string, so each of those booted and matched nothing.
   *
   * The trailing slash is the likeliest of the family: it is what the address
   * bar shows, so it is what an operator copies.
   *
   * REFUSING WAS THE OTHER OPTION. Normalising was chosen because the
   * transform on its own refuses nothing a browser could send, whereas a
   * no-path rule could refuse a boot in the operator environment that
   * docker-compose.prod.yml takes CORS_ORIGIN from, which this repository
   * cannot enumerate. The shape allow-list further down DOES narrow what
   * boots, and its own arms name what it narrows.
   *
   * EXPECTATIONS ARE LITERALS, not derived from new URL, so this arm can still
   * see the transform change. Deriving them would make the test agree with any
   * transform at all, including no transform.
   *
   * NO PARENTHESES IN THE TITLE, deliberately - the mutation canary selects the
   * test it pins with jest's -t, which is a regex.
   */
  it.each([
    ['http://x.com/', 'http://x.com'],
    ['https://x.com/app', 'https://x.com'],
    ['https://x.com/a/b?q=1#f', 'https://x.com'],
    ['https://x.com:8443/app/', 'https://x.com:8443'],
    ['http://localhost:3000/', 'http://localhost:3000']
  ])('normalises the path off CORS_ORIGIN %p to %p', (value, expected) => {
    setVar('CORS_ORIGIN', value);
    expect(validateBackendEnvironment().CORS_ORIGIN).toBe(expected);
  });

  /**
   * THE CANARY-SELECTABLE ARM for the entry above.
   *
   * The it.each titles interpolate the values, and every one of those values
   * contains a dot, which is a regex metacharacter - both runners treat jest's
   * -t as a regex, so the manifest's own validator refuses such a name and the
   * entry would grade TEST_MISSING rather than KILLED. This arm carries the
   * same assertion under a title made of plain words, so the canary has
   * something it can select.
   */
  it('drops a trailing slash from CORS_ORIGIN, because a browser Origin header carries none', () => {
    setVar('CORS_ORIGIN', 'http://x-example-host/');
    expect(validateBackendEnvironment().CORS_ORIGIN).toBe('http://x-example-host');
  });

  /**
   * THE REFINE STILL RUNS BEFORE THE TRANSFORM.
   *
   * `new URL()` would happily normalise 'http:/x.com' to 'http://x.com/' and
   * 'HTTP://x.com' to 'http://x.com', so a transform placed BEFORE the refine
   * would silently repair two values #59 deliberately refuses.
   *
   * WHAT THIS ARM IS AND IS NOT. An earlier version of this docblock said
   * swapping the two would pass every other test in the file. MUTATION
   * REFUTED THAT: with the swap applied and this arm deleted, the it.each at
   * the top of this describe still fails on 'HTTPS://EXAMPLE.COM' and
   * 'http:/x.com', because #59 already pinned both. So the order is not
   * unguarded without this arm, and a comment claiming otherwise would send
   * the next reader to the wrong place.
   *
   * What this arm adds is the scheme-PLUS-PATH shapes the #59 arm lacks -
   * 'HTTP://x.com/' and 'HTTPS://EXAMPLE.COM/app' - and it states the order
   * dependency at the site that depends on it rather than leaving it implied.
   */
  it.each(['http:/x.com', 'HTTP://x.com/', 'HTTPS://EXAMPLE.COM/app'])(
    'still refuses rather than repairs the non-http scheme CORS_ORIGIN %p',
    (value) => {
      setVar('CORS_ORIGIN', value);
      expect(() => validateBackendEnvironment()).toThrow(/CORS origin must be an http\(s\) URL/);
    }
  );

  /**
   * USERINFO IS REFUSED, and this arm exists BECAUSE of the transform.
   *
   * Everything before an `@` in a URL is userinfo, so the host is what follows
   * it. MEASURED against the schema with the transform and without the refine
   * - every one of these was accepted and normalised:
   *   'https://app.example.com@evil.com'       -> 'https://evil.com'
   *   'https://app.example.com:8443@evil.com/' -> 'https://evil.com'
   *   'https://x.com%2f@evil.com'              -> 'https://evil.com'
   *
   * WHY THE TRANSFORM MAKES IT WORSE RATHER THAN NEUTRAL. index.ts hands this
   * to `cors()` as a STRING, and for a string the cors package emits it as
   * `Access-Control-Allow-Origin` verbatim without comparing it to the request
   * Origin - the browser compares, and `credentials: true` is set alongside.
   * Un-normalised, `https://app.example.com@evil.com` is an ACAO no browser
   * ever matches, so the misconfiguration fails CLOSED. Normalised, it is a
   * well-formed origin a browser WILL match, so it fails OPEN - granting
   * credentialed cross-origin reads to the host after the `@`.
   *
   * There is no attacker-controlled path to this value today; it is deployment
   * config. This is defence in depth against the transform quietly repairing a
   * broken value into a dangerous one.
   */
  it.each([
    'https://app.example.com@evil.com',
    'https://app.example.com:8443@evil.com/',
    'https://x-example-host%2f@evil.com',
    'https://user:pass@x-example-host/p',
    // PASSWORD WITHOUT A USERNAME. The username half of the refine cannot see
    // this one, so it is the arm that fails when the password half goes.
    'https://:secret@x-example-host'
  ])('refuses the userinfo-carrying CORS_ORIGIN %p rather than normalising it to the host after the at sign', (value) => {
    setVar('CORS_ORIGIN', value);
    expect(() => validateBackendEnvironment()).toThrow(
      /CORS origin must not contain userinfo/
    );
  });

  /**
   * THE CANARY-SELECTABLE ARM for the userinfo entry.
   *
   * Every it.each title above interpolates a URL, and a URL is made of regex
   * metacharacters - dots at minimum. Both runners treat jest's -t as a regex
   * and the manifest validator refuses such a name outright, so the entry
   * would grade TEST_MISSING rather than KILLED. This arm carries the same
   * assertion under a title made of plain words.
   */
  it('refuses a CORS origin that hides its real host behind an at sign', () => {
    setVar('CORS_ORIGIN', 'https://app-example-host@evil-example-host');
    expect(() => validateBackendEnvironment()).toThrow(
      /CORS origin must not contain userinfo/
    );
  });

  /**
   * THE SHAPE IS ALLOW-LISTED, because the transform REPAIRS what it parses.
   *
   * `new URL(v).origin` does not only drop a path. The WHATWG parser reads `\`
   * as `/`, strips tab and newline from anywhere in the value, percent-decodes
   * and case-folds the host and maps fullwidth letters, ideographic dots and
   * zero-width characters onto ASCII. So a broken value comes out the far side
   * as a DIFFERENT, well-formed origin - and index.ts hands that string to
   * `cors()`, which emits it as Access-Control-Allow-Origin with credentials
   * on. MEASURED on this branch before the allow-list, every one of these
   * booted:
   *   'http://evil.com\@good.com'        -> 'http://evil.com'
   *   'https://\evil.com'                -> 'https://evil.com'
   *   'https:///evil.com'                -> 'https://evil.com'
   *   'https://good.com<LF>.evil.com'    -> 'https://good.com.evil.com'
   *   'https://%65vil.com'               -> 'https://evil.com'
   *   'https://@evil.com'                -> 'https://evil.com'
   *   'https://a.com,https://b.com'      -> 'https://a.com,https'
   *   'https://a.com/,https://evil.com'  -> 'https://a.com'
   *   'https://*.good.com'               -> 'https://*.good.com'
   * The userinfo refine sees none of the backslash, empty-userinfo or comma
   * shapes, because the parser reports an empty username for all of them. A
   * block-list would be one more entry behind the parser each time, so the
   * raw text is held to the one shape an operator means instead.
   */
  it.each([
    'http://evil.com\\@good.com',
    'https://\\evil.com',
    'https:///evil.com',
    'https://good.com\n.evil.com',
    'https://good.com\r.evil.com',
    'https://go\tod.com',
    'https://%65vil.com',
    // FULLWIDTH small e, U+FF45 - folds to ASCII 'e'.
    'https://ｅvil.com',
    // IDEOGRAPHIC FULL STOP, U+3002 - folds to '.'.
    'https://good.com。evil.com',
    // ZERO WIDTH SPACE, U+200B - dropped by the host parser.
    'https://go​od.com',
    'https://@evil.com',
    'https://:@evil.com',
    'https://a.com,https://b.com',
    'https://a.com/,https://evil.com',
    'https://*.good.com',
    'https://good.com/pa th',
    'https://good.com/p\\q',
    // THE RULE ITSELF rather than a measured repair. An `@` in the path parses
    // to the right host, and a non-numeric port is userinfo the refine above
    // also refuses - so neither is exploitable today. They are here so that
    // loosening the path class or the port group fails by name.
    'https://good.com/x@evil.com',
    'https://good.com:x@evil.com'
  ])('refuses the CORS_ORIGIN %p rather than repairing it into another origin', (value) => {
    setVar('CORS_ORIGIN', value);
    expect(() => validateBackendEnvironment()).toThrow(
      /CORS origin must be http\(s\):\/\/host\[:port\]/
    );
  });

  /**
   * THE CANARY-SELECTABLE ARM for the allow-list entry. Plain words only: the
   * it.each titles above interpolate URLs, and the canary selects with jest's
   * -t, which is a regex.
   */
  it('refuses a CORS origin whose backslash would hand the host to whatever precedes it', () => {
    setVar('CORS_ORIGIN', 'http://evil-example-host\\@good-example-host');
    expect(() => validateBackendEnvironment()).toThrow(
      /CORS origin must be http\(s\):\/\/host\[:port\]/
    );
  });

  /**
   * THE CONTROL on the allow-list. A pattern that refused everything would
   * satisfy every arm above, so the shapes an operator actually writes are
   * pinned as accepted, with LITERAL expectations.
   */
  it.each([
    ['https://good.com', 'https://good.com'],
    ['https://good.com/', 'https://good.com'],
    ['https://good.com:8443/app?x#y', 'https://good.com:8443'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['https://adaptalabs.kubera-playground.adaptavist.net', 'https://adaptalabs.kubera-playground.adaptavist.net'],
    // The punycode form the deployment doc tells an operator to write for a
    // non-ASCII host. Pinned so tightening the host class cannot invalidate
    // the documented workaround in silence.
    ['https://xn--nxasmq6b.com', 'https://xn--nxasmq6b.com'],
    // An IPv4 address in shorthand: accepted, and rewritten into dotted form
    // by the parser rather than refused. The same host written another way,
    // pinned so the rewrite is a decision rather than a surprise.
    ['https://127.1', 'https://127.0.0.1']
  ])('still accepts the well-shaped CORS_ORIGIN %p as %p', (value, expected) => {
    setVar('CORS_ORIGIN', value);
    expect(validateBackendEnvironment().CORS_ORIGIN).toBe(expected);
  });

  /**
   * THE PRICE, pinned so it is a decision rather than an accident. The host
   * class is ASCII letters, digits, dots and hyphens, so an IPv6 literal, an
   * underscore and a non-ASCII host are refused although origin/main booted
   * them. None is a shape a deployed CORS origin takes, and a non-ASCII host
   * can still be written in its punycode form.
   */
  it.each(['http://[::1]:3000', 'https://my_host.example.com'])(
    'refuses the CORS_ORIGIN %p because its host falls outside the allow-list',
    (value) => {
      setVar('CORS_ORIGIN', value);
      expect(() => validateBackendEnvironment()).toThrow(
        /CORS origin must be http\(s\):\/\/host\[:port\]/
      );
    }
  );

  /**
   * THE CONTROL ON THE REFINE, and it is not decorative.
   *
   * The refine runs even when an earlier STRING check on the same chain has
   * already failed, so it sees 'not a url' too. An unguarded `new URL()` there
   * throws a raw TypeError that escapes the ZodError handling - measured, it
   * turned four of #59's refusal arms from their own named message into
   * 'Invalid URL'. This arm pins that a malformed value still reports the
   * malformed-URL message rather than being swallowed or re-labelled.
   */
  it.each(['not a url', '', 'example.com'])(
    'still reports the malformed message for %p rather than a raw URL parse error',
    (value) => {
      setVar('CORS_ORIGIN', value);
      expect(() => validateBackendEnvironment()).toThrow(
        /CORS origin must be a valid URL/
      );
      // NOT RE-LABELLED. The refine's catch returns true because `.url()` owns
      // this refusal; a catch returning false would add a userinfo complaint
      // about a value that carries no userinfo, and only this line sees it.
      expect(() => validateBackendEnvironment()).not.toThrow(/userinfo/);
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

  /**
   * THE PATH REACHES THE ELEVEN READERS TOO, not just `config`.
   *
   * The scheme half of #59 covered all thirteen consumers for free, because a
   * bad scheme stops the boot before any of them runs. A PATH does not stop
   * the boot, so without the write-back carrying the normalised value the
   * eleven would go on concatenating onto `https://x.com/app` while `cors()`
   * compared against `https://x.com`. Measured on the diff that introduced
   * #64's transform: mutating this assignment to write the merely-TRIMMED
   * value instead left the whole backend suite at 1970 passed. This arm is
   * what makes that mutation visible.
   */
  it('writes the path-normalised origin back, so the eleven readers agree with cors', () => {
    setVar('CORS_ORIGIN', 'https://x-example-host/app');

    importConfig();

    expect(process.env.CORS_ORIGIN).toBe('https://x-example-host');
  });

  /**
   * THE OPERATOR IS TOLD, because this change moves their OAuth callback base.
   *
   * A path-carrying CORS_ORIGIN is set in an environment this repository
   * cannot see - `docker-compose.prod.yml` passes `${CORS_ORIGIN}` through
   * from the operator. Normalising it is right for `cors()` and it also moves
   * `${CORS_ORIGIN}/auth/google-callback` from `https://x.com/app/...` to
   * `https://x.com/...`. That is a fix rather than a regression, because their
   * CORS matched nothing either way, but it is not something to do silently.
   *
   * ALL THREE ARMS ARE NEEDED and the two quiet ones are the controls. Warning
   * on everything reads as a pass against the first arm alone, and the
   * measured mutation that flips this condition - warn on whitespace, stay
   * silent on a dropped path - is the exact inverse of the intent and left the
   * backend suite at 1970 passed.
   */
  describe('the boot warning names a dropped path and stays quiet otherwise', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    /**
     * DISTINCT lines, not a call count. The same warning has been observed
     * arriving twice here, depending on which other tests ran first. The
     * cause is NOT known: a load counter showed `../index` evaluated once per
     * import, so it is not a double module load. Production boots once and
     * warns once. Asserting on the distinct set says what is meant ("one
     * warning, naming both forms") without encoding a repeat count nobody
     * can explain as if it were the contract.
     */
    const warnings = (): string[] => [
      ...new Set(warn.mock.calls.map((call) => String(call[0])))
    ];

    it('names both the written value and the normalised one when a path is dropped', () => {
      setVar('CORS_ORIGIN', 'https://x-example-host/app');

      importConfig();

      const lines = warnings().filter((line) => line.includes('CORS_ORIGIN'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('https://x-example-host/app');
      expect(lines[0]).toContain('https://x-example-host');
    });

    it('stays quiet when only whitespace was normalised, which no operator can act on', () => {
      setVar('CORS_ORIGIN', ' https://x-example-host ');

      importConfig();

      expect(warnings().filter((line) => line.includes('CORS_ORIGIN'))).toEqual([]);
    });

    it('stays quiet when the value needed no normalising at all', () => {
      setVar('CORS_ORIGIN', 'https://x-example-host');

      importConfig();

      expect(warnings().filter((line) => line.includes('CORS_ORIGIN'))).toEqual([]);
    });
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
