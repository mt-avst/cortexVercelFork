import type { Server } from 'node:http';

import { logger } from './utils/logger';

/**
 * The socket-level bounds, applied to the HTTP server the app listens on.
 *
 * DEFENCE IN DEPTH, AND SAID PLAINLY SO NOBODY DELETES THE WRONG ONE. The fix
 * for an export that never finishes is the export's own wall-clock deadline in
 * firsthand/survey-csv-response.ts: it knows which study stalled, it logs a
 * reason, and it destroys the socket at a moment it chose. These are the
 * backstop for everything that has no such bound of its own - and for the next
 * unbounded response somebody adds.
 *
 * Two of the three already had a non-zero default on Node 22 (requestTimeout
 * 300000, headersTimeout 60000). `server.timeout` did not: it is 0, meaning a
 * socket that goes quiet mid-request stays open forever. Pinning all three
 * here makes the numbers auditable and survives a Node upgrade changing a
 * default underneath the application.
 */

/**
 * How long the client has to send its request headers.
 *
 * Node's own default. Kept rather than tightened because it is already well
 * below anything a real client needs and lowering it buys nothing this
 * application is exposed to - the ingress terminates TLS and no request body
 * here is large.
 */
export const SERVER_HEADERS_TIMEOUT_MS = 60_000;

/**
 * How long the client has to send the ENTIRE request.
 *
 * Below Node's 300000 default, deliberately. Every body this app parses goes
 * through `express.json()` and its 100kb default limit; media never touches
 * the API, because uploads are presigned S3 PUTs the browser makes directly.
 * So two minutes is generous by orders of magnitude for the largest request
 * that can legitimately arrive.
 *
 * Must stay at or above SERVER_HEADERS_TIMEOUT_MS: Node treats a headers
 * timeout larger than the request timeout as a misconfiguration.
 */
export const SERVER_REQUEST_TIMEOUT_MS = 120_000;

/**
 * How long a socket may be idle mid-request before it is destroyed.
 *
 * The one that was genuinely unbounded, and the only reason this file exists.
 *
 * ABOVE the CSV export's own deadline on purpose, not by accident. The
 * application-level bound must be the one that fires: it logs which study and
 * why, and an operator reading a destroyed socket with no log line has nothing
 * to work from. If this fired first it would silently pre-empt that.
 */
export const SERVER_SOCKET_TIMEOUT_MS = 360_000;

/**
 * Applies all three, and returns the server so a caller can assert on it.
 *
 * Separate from server.ts because server.ts binds a port on import unless
 * NODE_ENV is 'test' - so the values themselves would be untestable if they
 * lived there, and untestable numbers are how a policy constant drifts.
 */
export function applyServerTimeouts(server: Server): Server {
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.timeout = SERVER_SOCKET_TIMEOUT_MS;

  logger.info('Server timeouts applied', {
    headersTimeoutMs: SERVER_HEADERS_TIMEOUT_MS,
    requestTimeoutMs: SERVER_REQUEST_TIMEOUT_MS,
    socketTimeoutMs: SERVER_SOCKET_TIMEOUT_MS
  });

  return server;
}
