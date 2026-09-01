import { describe, it, expect, vi, afterEach } from 'vitest';
import axios, { AxiosError } from 'axios';
import { redactRequestBodies } from '../logger';

/**
 * A FAILED SAVE MUST NOT PRINT WHAT WAS BEING SAVED. cto/AdaptaLabs#88.
 *
 * axios's `toJSON()` carries `config.data` - the request body - and
 * `JSON.stringify` calls it before any replacer runs, so handing an
 * AxiosError to the logger serialised a researcher's note about a named
 * colleague into the console on every failed `PUT /bookings/:id/notes`.
 * The redaction lives in the logger's stringify replacer, not at call
 * sites, so the next route added cannot reintroduce it.
 */

const NOTE = 'SECRET-NOTE: Dana froze up and blamed her manager';
const TOKEN = 'Bearer secret-auth-token';
const CSRF = 'csrf-sentinel-token-9f2a';

const axiosErrorCarryingTheNote = (): AxiosError =>
  new AxiosError(
    'Request failed with status code 403',
    'ERR_BAD_REQUEST',
    {
      method: 'put',
      url: '/api/bookings/b1/notes',
      data: JSON.stringify({ researcher_notes: NOTE }),
      headers: { Authorization: TOKEN } as never,
    } as never,
    undefined,
    undefined
  );

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('redactRequestBodies (cto/AdaptaLabs#88)', () => {
  it('control: without the replacer, a serialised axios error DOES carry the body', () => {
    // The leak, demonstrated. Without this arm the assertions below pass just
    // as well against an axios that stopped serialising config entirely.
    const raw = JSON.stringify(axiosErrorCarryingTheNote());
    expect(raw).toContain(NOTE);
  });

  it('drops the request body, keeping method and url', () => {
    const line = JSON.stringify(axiosErrorCarryingTheNote(), redactRequestBodies);

    expect(line).not.toContain(NOTE);
    expect(line).toContain('[REDACTED: request body]');
    expect(line).toContain('/api/bookings/b1/notes');
    expect(line).toContain('put');
  });

  it('drops the config headers too: they carry auth material', () => {
    const line = JSON.stringify(axiosErrorCarryingTheNote(), redactRequestBodies);
    expect(line).not.toContain(TOKEN);
  });

  it('drops the headers of a BODILESS mutating call, where axios omits the data key entirely', async () => {
    // axios's toJSONObject drops undefined values, so a DELETE or the cancel
    // POST serialises with NO `data` key at all - and the first cut's
    // data-keyed predicate passed the whole config through, live X-CSRF-Token
    // included. Both review gates reproduced that independently through the
    // real client interceptor. Driven through a real axios instance here so
    // the fixture cannot drift from what toJSON actually emits.
    const instance = axios.create();
    let caught: unknown;
    try {
      await instance.request({
        url: '/api/bookings/b1/cancel',
        method: 'post',
        headers: { 'X-CSRF-Token': CSRF },
        adapter: async (config) => {
          throw new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', config as never);
        },
      });
    } catch (error) {
      caught = error;
    }

    // Control: without the replacer the serialised error really does carry
    // the live token - proving the arm can see the leak it guards against.
    expect(JSON.stringify(caught)).toContain(CSRF);

    const line = JSON.stringify(caught, redactRequestBodies);
    expect(line).not.toContain(CSRF);
    expect(line).toContain('/api/bookings/b1/cancel');
    // No body existed, so no marker: a bodiless call must not read as though
    // something was hidden.
    expect(line).not.toContain('[REDACTED: request body]');
  });

  it('leaves an object with no request body alone', () => {
    const plain = { message: 'boom', config: { url: '/x', method: 'get' }, other: 1 };
    expect(JSON.stringify(plain, redactRequestBodies)).toBe(JSON.stringify(plain));
  });
});

describe('the logger applies the redaction end to end', () => {
  const captureApiError = async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    // Reset HERE, not only in afterEach: under `-t` (which is exactly how the
    // mutation canary invokes this file) no earlier test has run, so without
    // this the dynamic import returns the module cached by the top-level
    // static import - a logger built under NODE_ENV=test that prints nothing,
    // and the arm fails for a reason that has nothing to do with redaction.
    vi.resetModules();
    // Fresh module so the Logger class re-reads NODE_ENV at construction.
    const { default: logger } = await import('../logger');
    logger.apiError('put', '/api/bookings/b1/notes', 403, axiosErrorCarryingTheNote());
    return lines.join('\n');
  };

  it('a production log line names the failure but never the note', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const output = await captureApiError();

    expect(output).toContain('API Error');
    expect(output).toContain('/api/bookings/b1/notes');
    expect(output).not.toContain(NOTE);
    expect(output).not.toContain(TOKEN);
  });

  it('a development log line is redacted the same way', async () => {
    // The leak was first demonstrated in devtools, not in production; a fix
    // that only guarded one branch would pass the arm above and still print
    // the note to every developer console.
    vi.stubEnv('NODE_ENV', 'development');
    const output = await captureApiError();

    expect(output).toContain('API Error');
    expect(output).not.toContain(NOTE);
  });
});
