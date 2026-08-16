'use strict';

/**
 * Test fixture, loaded with `node --require`, and inert unless
 * CORTEX_CAPTURE_POOL_CONFIG=1 is set.
 *
 * It replaces `pg` with a Pool that reports the TLS config the REAL driver
 * would connect with, then exits non-zero so a run that picks this up by
 * accident cannot look like success.
 *
 * Why it resolves the config through a real pg Client rather than just echoing
 * what it was handed: pg merges a parsed connection string OVER the explicit
 * ssl option, so the argument to `new Pool()` is not the connection. An
 * earlier version of this fixture printed the argument, and the script's tests
 * passed while `?ssl=0` produced a cleartext connection. Measuring anywhere
 * except the driver's own resolved parameters measures the wrong thing.
 */

const Module = require('node:module');

if (process.env.CORTEX_CAPTURE_POOL_CONFIG === '1') {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, ...rest) {
    if (request !== 'pg') {
      return originalLoad.call(this, request, ...rest);
    }

    const realPg = originalLoad.call(this, request, ...rest);

    return {
      ...realPg,
      Pool: class CapturingPool {
        constructor(config = {}) {
          let summary;
          try {
            const ssl = new realPg.Client(config).connectionParameters.ssl;
            summary =
              ssl && typeof ssl === 'object'
                ? {
                    kind: 'object',
                    rejectUnauthorized: ssl.rejectUnauthorized,
                    hasCa: Boolean(ssl.ca),
                    replacedHostnameCheck: typeof ssl.checkServerIdentity === 'function',
                  }
                : { kind: typeof ssl, value: ssl === undefined ? 'undefined' : String(ssl) };
          } catch (error) {
            summary = { kind: 'error', message: String(error && error.message) };
          }
          process.stdout.write(`POOL_SSL_CONFIG:${JSON.stringify(summary)}\n`);
          // Never 0: this fixture performs none of the work the script exists
          // to do, and a success code would make that look fine.
          process.exit(3);
        }
      },
    };
  };
}
