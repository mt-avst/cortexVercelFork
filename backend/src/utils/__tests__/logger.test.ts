import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

import { Logger, redactSensitiveUrl } from '../logger';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

/**
 * Logger reads NODE_ENV in its field initialisers, so the environment has to
 * be set before the instance is constructed - the exported singleton captured
 * 'test' when the module first loaded and cannot be re-pointed.
 */
const loggerUnder = (nodeEnv: string | undefined): Logger => {
  if (nodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = nodeEnv;
  }
  return new Logger();
};

describe('Logger environment gating', () => {
  let logSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    // Assigning undefined would set the literal string "undefined".
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
  });

  it.each(['development', 'production'])('writes to console.log under %s', (nodeEnv) => {
    loggerUnder(nodeEnv).error('boom');

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain('boom');
  });

  it('stays quiet under test, so suites are not flooded', () => {
    loggerUnder('test').error('boom');

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // The point of the change. Previously these fell through both branches and
  // wrote nothing at all, silently disabling every error log in the app -
  // including the pool error guard from !86, whose entire remedy is one log
  // line. Issue #3.
  it.each([undefined, 'staging', 'prod', 'Production', ''])(
    'degrades to noisy rather than silent under the unrecognised NODE_ENV %s',
    (nodeEnv) => {
      loggerUnder(nodeEnv as string | undefined).error('pool is dead');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('pool is dead');
    }
  );

  it('still carries structured context on the fallback path', () => {
    loggerUnder('staging').error('Unexpected error on idle database client', {
      poolName: 'backend',
    });

    const written = String(errorSpy.mock.calls[0][0]);
    expect(written).toContain('backend');
    expect(written).toContain('ERROR');
  });
});

describe('redactSensitiveUrl', () => {
  it('redacts a participant session capability token in the path', () => {
    expect(redactSensitiveUrl('/api/firsthand/session/abc123secret/events')).toBe(
      '/api/firsthand/session/[REDACTED]/events'
    );
  });

  // The Okta callback lands at /auth/callback?code=...&state=..., so without
  // this the full authorization code was logged on every login, twice.
  it('redacts the OAuth authorization code and state', () => {
    const redacted = redactSensitiveUrl('/auth/callback?code=live-auth-code&state=xyz789');

    expect(redacted).not.toContain('live-auth-code');
    expect(redacted).not.toContain('xyz789');
    expect(redacted).toContain('code=[REDACTED]');
    expect(redacted).toContain('state=[REDACTED]');
  });

  it.each(['id_token', 'access_token', 'refresh_token', 'token'])(
    'redacts the %s query parameter',
    (param) => {
      const redacted = redactSensitiveUrl(`/auth/callback?${param}=SENSITIVE_VALUE`);

      expect(redacted).not.toContain('SENSITIVE_VALUE');
    }
  );

  it('preserves everything that is not a credential', () => {
    expect(redactSensitiveUrl('/api/opportunities?type=test&q=hello')).toBe(
      '/api/opportunities?type=test&q=hello'
    );
  });

  it('stops at the next parameter rather than swallowing the rest', () => {
    const redacted = redactSensitiveUrl('/auth/callback?code=secret&redirect=/admin');

    expect(redacted).toBe('/auth/callback?code=[REDACTED]&redirect=/admin');
  });

  it('leaves undefined alone', () => {
    expect(redactSensitiveUrl(undefined)).toBeUndefined();
  });
});
