const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

/**
 * The detector in `csv-stream-check.mjs`, against BOTH behaviours it exists to
 * tell apart.
 *
 * A diagnostic that has only ever seen one kind of server is a diagnostic whose
 * answer nobody should trust: "verdict: STREAMED" passes just as well from a
 * function that returns STREAMED unconditionally. So there are two real HTTP
 * servers here - one that streams a body in spaced writes with no
 * Content-Length, one that buffers the whole thing and sends it in a single
 * write behind a Content-Length - and the check has to disagree about them.
 *
 * That pairing is the whole point of the file. The production question
 * (cto/AdaptaLabs#11) is whether the ingress in front of the deployed app
 * behaves like the first server or the second, and nothing local can answer it -
 * but whether the instrument can tell them apart is answerable here, and has to
 * be, before the answer it gives in production means anything.
 */

const importCheck = () => import('./csv-stream-check.mjs');

/** Listens on an ephemeral port and hands back the base url plus a closer. */
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/export.csv`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The app's own behaviour: chunked, no Content-Length, written over time.
 *
 * The spacing is what makes this a stream rather than three writes in one tick -
 * without it Node coalesces them into a single TCP segment and the client sees
 * one read, which is exactly the shape this test needs to distinguish.
 */
const streamingServer = (rows = 12, gapMs = 12) =>
  listen(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/csv' });
    res.write('participant,answer\r\n');
    for (let i = 0; i < rows; i++) {
      res.write(`p${i},answer ${i}\r\n`);
      await sleep(gapMs);
    }
    res.end();
  });

/** A proxy that collected the whole body first: one write, behind a length. */
const bufferingServer = (rows = 12, delayMs = 150) =>
  listen(async (_req, res) => {
    const body =
      'participant,answer\r\n' +
      Array.from({ length: rows }, (_, i) => `p${i},answer ${i}\r\n`).join('');
    // The delay stands in for the origin producing the export while the proxy
    // waits: the bytes exist only once it is over.
    await sleep(delayMs);
    res.writeHead(200, {
      'content-type': 'text/csv',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  });

test('reports STREAMED for a chunked body written over time', async () => {
  const { measure, verdictFor } = await importCheck();
  const server = await streamingServer();
  try {
    const measurement = await measure({ url: server.url, cookie: 'connect.sid=test' });
    const { verdict, reasons } = verdictFor(measurement);

    assert.equal(verdict, 'STREAMED', reasons.join('; '));
    assert.equal(measurement.status, 200);
    assert.ok(measurement.chunks > 1, `expected several reads, got ${measurement.chunks}`);
  } finally {
    await server.close();
  }
});

test('reports BUFFERED for a Content-Length body sent in one write', async () => {
  // THE ARM THAT MATTERS. Without it, "STREAMED" in production is a word the
  // script prints rather than a measurement it made.
  const { measure, verdictFor } = await importCheck();
  const server = await bufferingServer();
  try {
    const measurement = await measure({ url: server.url, cookie: 'connect.sid=test' });
    const { verdict, reasons } = verdictFor(measurement);

    assert.equal(verdict, 'BUFFERED', reasons.join('; '));
    assert.ok(
      reasons.some((r) => r.includes('Content-Length')),
      `expected the Content-Length reason, got: ${reasons.join('; ')}`
    );
  } finally {
    await server.close();
  }
});

test('names a transfer too short to judge as INCONCLUSIVE rather than guessing', async () => {
  // A fast, tiny response looks buffered by every signal the check has, and
  // saying BUFFERED about it would be a false alarm on an empty study.
  const { verdictFor } = await importCheck();

  const { verdict, reasons } = verdictFor({
    status: 200,
    headers: {},
    httpVersion: '1.1',
    bytes: 20,
    chunks: 1,
    ttfbMs: 1,
    totalMs: 2,
  });

  assert.equal(verdict, 'INCONCLUSIVE');
  assert.match(reasons.join(' '), /too short/);
});

test('does not call a non-200 a verdict about streaming', async () => {
  // An expired cookie answers 401 in milliseconds, which would otherwise read
  // as a clean BUFFERED - a wrong answer to a question that was never asked.
  const { verdictFor } = await importCheck();

  const { verdict } = verdictFor({
    status: 401,
    headers: {},
    httpVersion: '1.1',
    bytes: 0,
    chunks: 0,
    ttfbMs: 1,
    totalMs: 1,
  });

  assert.equal(verdict, 'INCONCLUSIVE');
});

test('an interrupted stream is reported as a broken transfer', async () => {
  const { measure, interruptVerdictFor } = await importCheck();
  const server = await streamingServer(200, 8);
  try {
    const measurement = await measure({
      url: server.url,
      cookie: 'connect.sid=test',
      abortAfterBytes: 24,
    });
    const interrupt = interruptVerdictFor(measurement);

    assert.equal(measurement.aborted, true);
    assert.equal(interrupt.ok, true, interrupt.detail);
  } finally {
    await server.close();
  }
});

test('an interrupt that finishes cleanly anyway is reported as a PROBLEM', async () => {
  // The control on the arm above, and the production failure it is looking for:
  // a proxy that already holds the whole body serves it complete no matter when
  // the client gives up, so the abort "succeeds" and the file is a lie.
  const { interruptVerdictFor } = await importCheck();

  const interrupt = interruptVerdictFor({ aborted: true, completed: true });

  assert.equal(interrupt.ok, false);
  assert.match(interrupt.detail, /CLEAN end/);
});

test('refuses to run without a url and a cookie', async () => {
  const { parseArgs } = await importCheck();

  assert.match(parseArgs([]).error, /--url/);
  assert.match(parseArgs(['--url', 'https://x/y.csv']).error, /--cookie/);
  assert.match(parseArgs(['--nope']).error, /unknown argument/);

  const good = parseArgs(['--url', 'https://x/y.csv', '--cookie', 'connect.sid=a']);
  assert.equal(good.error, undefined);
  assert.equal(good.minBytes, 4096);
});
