#!/usr/bin/env node
/**
 * Is the survey CSV export STREAMED all the way to the client, or buffered by
 * something in front of it?
 *
 * The launch gate on cto/AdaptaLabs#11, made runnable. The export destroys the
 * socket on every failure path - a batch read that throws, a stalled client, the
 * whole-export deadline, retry exhaustion - and that is deliberate: once the
 * header row is written the status is 200 and cannot be taken back, so a failure
 * part-way through must not finish tidily. A short CSV that parses is a
 * researcher computing a mean over part of their data with nothing on the page
 * saying so.
 *
 * Every part of that is proven in the test suite EXCEPT the part no test can
 * reach: the ingress. If a buffering proxy sits in front, it collects the whole
 * response before forwarding a byte, and a destroyed socket reaches the
 * researcher as a complete-looking truncated file with a Content-Length. The
 * refusal design is then defeated in production, silently, and this is the only
 * way to find out.
 *
 * WHAT IT MEASURES, and why these signals rather than "interrupt it and see":
 *
 *   Content-Length      A streamed response of unknown length cannot have one.
 *                       Its PRESENCE is the single strongest signal that
 *                       something buffered the whole body to count the bytes.
 *   Transfer-Encoding   `chunked` is what the app emits. HTTP/2 has no such
 *                       header, so its absence is only evidence on HTTP/1.1.
 *   time to first byte  A buffering proxy cannot send byte one until the origin
 *                       has finished, so TTFB collapses onto total time.
 *   chunk arrivals      A streamed body arrives in several reads spread over
 *                       time. One read containing everything is what buffering
 *                       looks like from here.
 *
 * The interrupt the issue describes is run too, as the last step and as a
 * confirmation rather than the primary evidence: a client abort proves the
 * transfer can be broken, but a buffering proxy that has already finished
 * collecting will happily serve a "complete" file to an interrupting client and
 * pass that check.
 *
 * Usage:
 *   node scripts/csv-stream-check.mjs --url <csv-url> --cookie <session-cookie>
 *
 *   --url      required, e.g.
 *              https://host/api/opportunities/<id>/survey-results.csv
 *   --cookie   required, the whole Cookie header value (connect.sid=...)
 *   --min-bytes  bytes to read before the interrupt step aborts. Default 4096.
 *   --json     print the measurement as JSON instead of prose
 *
 * Exit 0 when the verdict is STREAMED, 1 for BUFFERED or INCONCLUSIVE, 2 for a
 * usage or transport error. The verdict is about the PATH, not the data: run it
 * against an export big enough to take more than a moment, or it is inconclusive
 * by construction and says so.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const DEFAULT_MIN_BYTES = 4096;

/**
 * A body that arrives in one read is indistinguishable from a buffered one,
 * however it was sent - so the verdict withholds STREAMED rather than guessing.
 */
const MIN_CHUNKS_FOR_STREAMED = 2;

/**
 * Below this the measurement is noise: a response that completes in a few
 * milliseconds says nothing about whether a proxy would have buffered a large
 * one, because there was nothing to buffer.
 */
const MIN_TOTAL_MS_FOR_A_VERDICT = 50;

export function parseArgs(argv) {
  const args = { minBytes: DEFAULT_MIN_BYTES, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i];
    else if (arg === '--cookie') args.cookie = argv[++i];
    else if (arg === '--min-bytes') args.minBytes = Number(argv[++i]);
    else if (arg === '--json') args.json = true;
    else return { error: `unknown argument: ${arg}` };
  }
  if (!args.url) return { error: 'missing --url' };
  if (!args.cookie) return { error: 'missing --cookie' };
  if (!Number.isFinite(args.minBytes) || args.minBytes <= 0) {
    return { error: '--min-bytes must be a positive number' };
  }
  return args;
}

/**
 * One GET, measured.
 *
 * `abortAfterBytes` runs the issue's own check: destroy the socket once that
 * many bytes have arrived, and report what the client saw. Left undefined, the
 * download runs to completion and the timings describe the whole transfer.
 *
 * Written on `node:http` rather than `fetch` deliberately: this needs the raw
 * arrival time of each `data` event and the exact headers, and it needs to
 * destroy the socket rather than cancel a stream abstraction.
 */
export function measure({ url, cookie, abortAfterBytes }) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const started = Date.now();
    const chunkTimes = [];
    let bytes = 0;
    let firstByteAt = null;
    let aborted = false;

    const request = client.request(
      target,
      { method: 'GET', headers: { Cookie: cookie, Accept: 'text/csv' } },
      (res) => {
        const headerAt = Date.now();
        res.on('data', (chunk) => {
          if (firstByteAt === null) firstByteAt = Date.now();
          bytes += chunk.length;
          chunkTimes.push(Date.now() - started);
          if (abortAfterBytes !== undefined && bytes >= abortAfterBytes && !aborted) {
            aborted = true;
            // The socket, not just the stream: this is meant to look to the
            // server exactly like a researcher closing the tab.
            request.destroy(new Error('interrupted by csv-stream-check'));
          }
        });
        res.on('end', () =>
          resolve({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            httpVersion: res.httpVersion,
            bytes,
            chunks: chunkTimes.length,
            ttfbMs: (firstByteAt ?? headerAt) - started,
            totalMs: Date.now() - started,
            completed: true,
            aborted,
          })
        );
        res.on('error', (error) =>
          resolve({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            httpVersion: res.httpVersion,
            bytes,
            chunks: chunkTimes.length,
            ttfbMs: (firstByteAt ?? headerAt) - started,
            totalMs: Date.now() - started,
            completed: false,
            aborted,
            transportError: error.code ?? error.message,
          })
        );
      }
    );

    request.on('error', (error) =>
      resolve({
        ok: !!bytes || aborted,
        bytes,
        chunks: chunkTimes.length,
        ttfbMs: firstByteAt === null ? null : firstByteAt - started,
        totalMs: Date.now() - started,
        completed: false,
        aborted,
        transportError: error.code ?? error.message,
      })
    );

    request.end();
  });
}

/**
 * The verdict, from the measurement alone, so it can be tested against both a
 * streaming and a buffering server without a network.
 *
 * INCONCLUSIVE is a real answer here and not a cop-out. Every signal below
 * needs a transfer with some duration and some size behind it; against a
 * three-row export they all read as "buffered" for reasons that have nothing to
 * do with the ingress. Reporting that honestly is the difference between this
 * being a check and being a coin toss.
 */
export function verdictFor(measurement) {
  const reasons = [];
  const contentLength = measurement.headers?.['content-length'];
  const transferEncoding = measurement.headers?.['transfer-encoding'];

  if (measurement.status !== 200) {
    return {
      verdict: 'INCONCLUSIVE',
      reasons: [`the export answered ${measurement.status ?? 'no status'}, so nothing was measured`],
    };
  }
  if (measurement.totalMs < MIN_TOTAL_MS_FOR_A_VERDICT) {
    return {
      verdict: 'INCONCLUSIVE',
      reasons: [
        `the whole transfer took ${measurement.totalMs}ms, which is too short to tell ` +
          'streaming from buffering - run this against a bigger export',
      ],
    };
  }

  let buffered = false;
  if (contentLength !== undefined) {
    buffered = true;
    reasons.push(
      `Content-Length: ${contentLength} is present, and a streamed export of unknown ` +
        'length cannot have one - something counted the bytes first'
    );
  } else {
    reasons.push('no Content-Length, which is what a streamed body looks like');
  }

  if (measurement.chunks < MIN_CHUNKS_FOR_STREAMED) {
    buffered = true;
    reasons.push(
      `the body arrived in ${measurement.chunks} read(s); a streamed export arrives in several`
    );
  } else {
    reasons.push(`the body arrived in ${measurement.chunks} reads`);
  }

  // TTFB as a FRACTION of the whole, not an absolute: a slow origin makes both
  // numbers large without saying anything about buffering.
  const ttfbShare = measurement.totalMs > 0 ? measurement.ttfbMs / measurement.totalMs : 1;
  if (ttfbShare > 0.9) {
    buffered = true;
    reasons.push(
      `the first byte arrived at ${Math.round(ttfbShare * 100)}% of the total transfer time, ` +
        'so the response was assembled before it was sent'
    );
  } else {
    reasons.push(
      `the first byte arrived at ${Math.round(ttfbShare * 100)}% of the total transfer time`
    );
  }

  if (measurement.httpVersion?.startsWith('1') && transferEncoding !== 'chunked' && !buffered) {
    reasons.push(
      `HTTP/${measurement.httpVersion} with no chunked Transfer-Encoding, which is unusual for a ` +
        'streamed body - worth a look even though the other signals are clean'
    );
  }

  return { verdict: buffered ? 'BUFFERED' : 'STREAMED', reasons };
}

/**
 * What the interrupt told us, kept separate from the verdict above.
 *
 * A clean end after an abort means the client got a whole file it never asked
 * to finish - the exact shape a buffering proxy produces, and the shape a
 * researcher cannot distinguish from a successful export.
 */
export function interruptVerdictFor(measurement) {
  if (!measurement.aborted) {
    return {
      ok: false,
      detail: 'the transfer finished before it could be interrupted - use a bigger export',
    };
  }
  if (measurement.completed) {
    return {
      ok: false,
      detail:
        'the client saw a CLEAN end after aborting mid-transfer, which is what a buffered ' +
        'response looks like: a truncated file that parses',
    };
  }
  return {
    ok: true,
    detail: `the client saw a broken transfer (${measurement.transportError}), which is correct`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`csv-stream-check: ${args.error}`);
    console.error('usage: node scripts/csv-stream-check.mjs --url <csv-url> --cookie <cookie>');
    process.exitCode = 2;
    return;
  }

  const full = await measure({ url: args.url, cookie: args.cookie });
  if (!full.ok) {
    console.error(`csv-stream-check: request failed: ${full.transportError}`);
    process.exitCode = 2;
    return;
  }

  const { verdict, reasons } = verdictFor(full);
  const interrupted = await measure({
    url: args.url,
    cookie: args.cookie,
    abortAfterBytes: args.minBytes,
  });
  const interrupt = interruptVerdictFor(interrupted);

  if (args.json) {
    console.log(JSON.stringify({ verdict, reasons, full, interrupt, interrupted }, null, 2));
  } else {
    console.log(`verdict: ${verdict}`);
    for (const reason of reasons) console.log(`  - ${reason}`);
    console.log(`interrupt: ${interrupt.ok ? 'ok' : 'PROBLEM'} - ${interrupt.detail}`);
    console.log(
      `measured: ${full.bytes} bytes, ${full.chunks} reads, ttfb ${full.ttfbMs}ms, ` +
        `total ${full.totalMs}ms, HTTP/${full.httpVersion}`
    );
  }

  process.exitCode = verdict === 'STREAMED' && interrupt.ok ? 0 : 1;
}

// Only when run directly, so the test can import the pure halves above.
if (process.argv[1] && process.argv[1].endsWith('csv-stream-check.mjs')) {
  await main();
}
