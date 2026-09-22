/**
 * Routes a mocked `pool.connect()` through a test suite's EXISTING
 * `pool.query` mock, for a handler that moved from `pool.query` per statement
 * to a transaction on one checked-out client (cto/AdaptaLabs#151 was the
 * first: `PATCH /api/opportunities/:id`).
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK` are answered directly and never reach
 * `mockQuery` - so they consume no queued `mockResolvedValueOnce`, and never
 * appear in `mockQuery.mock.calls` - which is what lets a suite's existing
 * positional or SQL-substring arrangements, built entirely against
 * `pool.query`, keep working unchanged once the handler under test switches
 * to `client.query`. Every other statement is forwarded to `mockQuery`
 * verbatim, so the handler sees a database that behaves exactly as the suite
 * already describes it.
 *
 * A test that needs its OWN client behaviour - asserting `release` was
 * called, or failing a specific statement - arranges `mockConnect` directly
 * instead of calling this; it is a default, not the only shape available.
 */

/**
 * The one method every call site actually needs from a mocked `pool.query`.
 *
 * Returns `unknown` rather than `Promise<unknown>`: a jest mock's inferred
 * signature is untyped, and the caller `await`s the result either way.
 */
type QueryMock = (sql: unknown, params?: unknown[]) => unknown;

/** The one method every call site actually needs from a mocked `pool.connect`. */
interface ConnectMock {
  mockResolvedValue(value: unknown): unknown;
}

export function wireConnectThroughQuery(mockConnect: ConnectMock, mockQuery: QueryMock): void {
  mockConnect.mockResolvedValue({
    query: (sql: unknown, params?: unknown[]) =>
      /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(String(sql))
        ? Promise.resolve({ rows: [], rowCount: 0 })
        : mockQuery(sql, params),
    release: () => undefined,
  });
}
