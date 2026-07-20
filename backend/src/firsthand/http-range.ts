/**
 * Single-range subset of RFC 9110 Range parsing for media streaming.
 *
 * A server MAY ignore a Range header, so every malformed or multi-range
 * request resolves to "full" (a plain 200 with the whole body) rather than an
 * error. Only a syntactically valid single bytes range that lies entirely
 * beyond the object resolves to "unsatisfiable" (416).
 */

export type RangeRequestResolution =
  | { kind: "full" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

const singleByteRangePattern = /^bytes=\s*(\d*)-(\d*)$/;

export function resolveRangeRequest(
  rangeHeader: string | null | undefined,
  sizeBytes: number
): RangeRequestResolution {
  if (!rangeHeader) {
    return { kind: "full" };
  }

  const match = singleByteRangePattern.exec(rangeHeader.trim());

  if (!match) {
    return { kind: "full" };
  }

  const [, firstBytePart, lastBytePart] = match;

  if (firstBytePart === "" && lastBytePart === "") {
    return { kind: "full" };
  }

  // Suffix form "bytes=-N": the last N bytes of the object.
  if (firstBytePart === "") {
    const suffixLength = Number.parseInt(lastBytePart, 10);

    if (suffixLength === 0 || sizeBytes === 0) {
      return { kind: "unsatisfiable" };
    }

    return {
      kind: "range",
      start: Math.max(sizeBytes - suffixLength, 0),
      end: sizeBytes - 1
    };
  }

  const start = Number.parseInt(firstBytePart, 10);

  if (start >= sizeBytes) {
    return { kind: "unsatisfiable" };
  }

  if (lastBytePart === "") {
    return { kind: "range", start, end: sizeBytes - 1 };
  }

  const requestedEnd = Number.parseInt(lastBytePart, 10);

  if (requestedEnd < start) {
    return { kind: "full" };
  }

  return { kind: "range", start, end: Math.min(requestedEnd, sizeBytes - 1) };
}

export function buildContentRangeHeader(
  start: number,
  end: number,
  sizeBytes: number
): string {
  return `bytes ${start}-${end}/${sizeBytes}`;
}

export function buildUnsatisfiableContentRangeHeader(
  sizeBytes: number
): string {
  return `bytes */${sizeBytes}`;
}

export function createUnsatisfiableRangeResponse(sizeBytes: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      "Content-Range": buildUnsatisfiableContentRangeHeader(sizeBytes),
      "Accept-Ranges": "bytes"
    }
  });
}
