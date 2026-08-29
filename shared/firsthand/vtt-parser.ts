// A minimal WebVTT reader for ingested transcript artefacts (#79 step 4).
//
// The exports researchers upload come from Meet, Teams and Zoom, all of which
// emit WebVTT; plain-text transcripts are the other accepted kind. This parses
// just enough to render cues with timestamps - cue payload text and its start
// time - and nothing it does not need (no styling, no region/position
// settings, no cue identifiers beyond skipping them). No dependency is added:
// a full WebVTT library brings positioning and karaoke-timing machinery this
// surface has no use for, and the grammar for "timestamp line + text lines"
// is a few rules.
//
// The contract that matters: malformed input must NOT throw. A transcript that
// cannot be parsed as cues is still worth showing as raw text (the refusal, if
// any, already happened at mime validation on upload), so the caller falls
// back to preformatted text when this returns no cues. Every branch here
// returns rather than throws.

export interface VttCue {
  /** Cue start, in whole seconds from zero. */
  startSeconds: number;
  /** Cue end in seconds, or null when the end stamp is missing/unparseable. */
  endSeconds: number | null;
  /** The cue's visible text, newlines preserved, HTML-ish tags stripped. */
  text: string;
}

const TIMESTAMP =
  /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;

// `00:01:02.500 --> 00:01:05.000 align:start` - the settings after the second
// stamp are ignored. Anchored loosely so a stray leading space does not break
// the line.
const CUE_TIMING = new RegExp(
  `^\\s*${TIMESTAMP.source}\\s*-->\\s*${TIMESTAMP.source}`
);

/**
 * Parse one `HH:MM:SS.mmm` (or `MM:SS.mmm`, or comma-decimal) stamp to
 * seconds. Returns null on anything it cannot read, so a single bad stamp
 * drops one cue rather than the whole transcript.
 */
export function parseVttTimestamp(raw: string): number | null {
  // Guarded like parseVtt itself: this is an exported standalone, and a JS
  // caller handing it a non-string should get the documented null, not a
  // throw from raw.trim().
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  const match = TIMESTAMP.exec(trimmed);
  // The match must span the WHOLE trimmed input, or "12:34:56:78" would parse
  // as a valid prefix.
  if (!match || match.index !== 0 || match[0] !== trimmed) {
    return null;
  }
  // Delegates the seconds maths to groupsToSeconds - the SAME function
  // parseVtt uses on the live path - so the range and millis-padding cases
  // this function's tests exercise cover the path that actually renders cues.
  return groupsToSeconds(match[1], match[2], match[3], match[4]);
}

/**
 * Seconds from the four capture groups of one embedded TIMESTAMP (hours may
 * be undefined), or null when minutes/seconds are out of range. Shared by
 * both stamps of a cue timing line; parseVttTimestamp is the standalone twin
 * kept for callers holding a raw string.
 */
function groupsToSeconds(
  hoursRaw: string | undefined,
  minutesRaw: string,
  secondsRaw: string,
  millisRaw: string | undefined
): number | null {
  const hours = hoursRaw ? Number(hoursRaw) : 0;
  const minutes = Number(minutesRaw);
  const seconds = Number(secondsRaw);
  const millis = millisRaw ? Number(millisRaw.padEnd(3, '0')) : 0;
  if (minutes > 59 || seconds > 59) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** Strip WebVTT inline tags (`<c>`, `<00:00:01.000>`, `<v Bob>`) from a line. */
function stripCueTags(line: string): string {
  return line.replace(/<[^>]*>/g, '');
}

/**
 * Parse WebVTT body into cues. Returns an empty array for anything it cannot
 * read as cues - the caller renders raw text in that case. Never throws.
 */
export function parseVtt(source: string): VttCue[] {
  if (typeof source !== 'string' || source.length === 0) {
    return [];
  }

  // Normalise line endings and split into blocks on blank lines. WebVTT
  // separates cues with a blank line; the `WEBVTT` header, NOTE blocks and
  // STYLE blocks are their own blocks we skip.
  const blocks = source
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n\s*\n/);

  const cues: VttCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    // Find the timing line: it may be the first line of the block, or the
    // second when the block opens with a cue identifier.
    let timingIndex = -1;
    let timing: RegExpExecArray | null = null;
    for (let i = 0; i < lines.length && i < 2; i++) {
      const candidate = CUE_TIMING.exec(lines[i]);
      if (candidate) {
        timingIndex = i;
        timing = candidate;
        break;
      }
    }
    if (timing === null || timingIndex === -1) {
      // A header, NOTE, STYLE, or free text with no timing - not a cue.
      continue;
    }

    // CUE_TIMING embeds TIMESTAMP twice: groups 1-4 are the start stamp
    // (hours, minutes, seconds, millis), 5-8 the end. Read them directly
    // rather than reconstructing a string to re-parse.
    const startSeconds = groupsToSeconds(timing[1], timing[2], timing[3], timing[4]);
    if (startSeconds === null) {
      continue;
    }
    const endSeconds = groupsToSeconds(timing[5], timing[6], timing[7], timing[8]);

    const text = lines
      .slice(timingIndex + 1)
      .map(stripCueTags)
      .join('\n')
      .trim();
    if (text.length === 0) {
      continue;
    }

    cues.push({ startSeconds, endSeconds, text });
  }

  return cues;
}
