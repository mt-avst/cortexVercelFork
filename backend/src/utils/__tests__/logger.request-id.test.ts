import { describe, it, expect, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { logger } from '../logger';

/**
 * THE x-request-id A CALLER SENDS IS NORMALISED BEFORE IT IS REFLECTED INTO A
 * RESPONSE HEADER. cto/AdaptaLabs#43's sixth site - a header, not a query,
 * but the same "trusted to be a string" defect.
 *
 * Before this, `req.headers['x-request-id'] as string` went straight into
 * `res.setHeader`. Three shapes that made wrong: a REPEATED header arrives
 * from Node's HTTP parser as ONE comma-joined string (the array arm below is
 * defence in depth for a hand-built req, not a wire shape - measured with a
 * real http.request during review of this change); a CR/LF in the value makes
 * `setHeader` THROW, turning a junk inbound header into a 500 from the
 * logging middleware of all places; and the length was unbounded, so the
 * response echoed as many bytes as the caller cared to send.
 *
 * The rule now: a bare string of 1-128 characters from [A-Za-z0-9._-] is
 * reflected verbatim; anything else gets a freshly generated id. Both
 * directions tested - a normaliser that regenerates everything would pass the
 * hostile arms perfectly.
 */

const runMiddleware = (headerValue: string | string[] | undefined): string => {
  const middleware = logger.requestLogger();

  const req = {
    headers: headerValue === undefined ? {} : { 'x-request-id': headerValue },
    method: 'GET',
    url: '/api/health',
    ip: '127.0.0.1',
    get: () => undefined,
  } as unknown as Request;

  const setHeader = jest.fn();
  const res = {
    setHeader,
    end: function end() {
      return this;
    },
    statusCode: 200,
  } as unknown as Response;

  const next = jest.fn();
  middleware(req, res, next);

  expect(next).toHaveBeenCalledTimes(1);
  const call = setHeader.mock.calls.find(([name]) => name === 'X-Request-ID');
  expect(call).toBeDefined();
  return call![1] as string;
};

describe('requestLogger x-request-id reflection', () => {
  it('reflects a well-formed id verbatim', () => {
    expect(runMiddleware('abc-123.DEF_456')).toBe('abc-123.DEF_456');
  });

  it('generates an id when none was sent', () => {
    expect(runMiddleware(undefined)).toMatch(/^req-/);
  });

  it.each([
    ['a repeated header as Node actually delivers it, comma-joined', 'id-one, id-two'],
    ['an array from a hand-built req, as defence in depth', ['id-one', 'id-two'] as string[]],
    ['a value over the length bound', 'x'.repeat(300)],
    ['a value with a space', 'abc def'],
    ['a value with a newline (the header-injection shape)', 'abc\r\nX-Injected: 1'],
    ['an empty string', ''],
  ])('replaces %s with a generated id', (_name, value) => {
    const reflected = runMiddleware(value);
    expect(reflected).toMatch(/^req-/);
    // Not merely prefixed - the hostile value must be GONE.
    expect(reflected).not.toContain('id-one');
    expect(reflected).not.toContain('X-Injected');
  });
});
