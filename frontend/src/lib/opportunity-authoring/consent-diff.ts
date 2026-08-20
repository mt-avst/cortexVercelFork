/**
 * What an author changed when they overrode the approved consent wording.
 *
 * Showing the two versions side by side was the cheaper option and is the wrong
 * one: consent copy is four dense sentences that differ by a clause, and asking
 * somebody to spot that difference by eye is asking them not to notice it. The
 * question the screen has to answer is "what exactly does this no longer say",
 * and only a diff answers it.
 *
 * Word-level rather than character-level, because a character diff of prose
 * fragments words into unreadable confetti; and word-level rather than
 * line-level, because consent wording has no lines - it is one paragraph, so a
 * line diff would report the entire thing as replaced.
 */

export type ConsentDiffKind = 'same' | 'added' | 'removed';

export interface ConsentDiffSegment {
  readonly kind: ConsentDiffKind;
  readonly text: string;
}

export interface ConsentDiff {
  readonly segments: readonly ConsentDiffSegment[];
  /** Words present in the author's wording and not in the template's. */
  readonly addedWords: number;
  /** Words present in the template's wording and not in the author's. */
  readonly removedWords: number;
  /**
   * The two differ, but not in any word - only in the spacing between them.
   *
   * Worth reporting rather than saying "no wording has changed", because the
   * classification DOES change on it: `consentTextMatches` trims the ends and
   * compares the rest exactly, so a doubled space marks a study as running on
   * custom wording. A diff that reported no change beside a "Custom wording"
   * badge would look like one of the two was broken.
   */
  readonly whitespaceOnly: boolean;
  /**
   * The comparison was refused because the input is too large to diff.
   *
   * `consent_text` is bounded at 10,000 characters on the authoring paths but
   * NOT on the studies API, where only the 100kb JSON body limit applies. The
   * table below is quadratic in the token counts, so an unbounded value would
   * allocate tens of millions of cells and hang the author's tab on a step that
   * opens itself. Refusing is better than freezing, and it is honest about why.
   */
  readonly tooLargeToCompare: boolean;
}

/**
 * The longest wording worth comparing word by word, per side.
 *
 * Bounded per SIDE rather than on the product of the two, because the shape
 * that actually arrives is a fifty-word template against an arbitrarily long
 * override - and a product cap lets that pair through while catching nothing
 * that matters. Four thousand words is roughly 25,000 characters: two and a
 * half times the 10,000-character cap the authoring paths already impose, and
 * far beyond any consent copy a person would write.
 */
const MAX_DIFF_TOKENS = 4_000;

/**
 * Split into words, each carrying the whitespace that FOLLOWS it.
 *
 * Keeping the separator attached to its word is what makes the rendered diff
 * readable. Whitespace used to be tokenised separately and matched by the LCS
 * in its own right, so a replaced word left the deletion and the insertion
 * abutting with no space between them: the browser showed
 * "This sessionWe recordsrecord your screen" for a rewritten opening. Every run
 * now ends with its own trailing space, so runs can never collide.
 *
 * Comparison is on the word alone (`trimEnd`), because a word followed by a
 * newline and the same word followed by a space are the same word. The ORIGINAL
 * token is what gets rendered, so the author's own spacing is preserved on
 * screen even though it is not what decided the match.
 */
const tokenise = (text: string): string[] => text.match(/\S+\s*/g) ?? [];

const wordOf = (token: string): string => token.trimEnd();

/**
 * Longest common subsequence over tokens, as a table of lengths.
 *
 * Consent wording is capped at `INLINE_STUDY_LIMITS.maxConsentLength`, and the
 * templates are around fifty words, so the quadratic table is a few thousand
 * cells on any realistic input. A smarter algorithm would be harder to read for
 * no measurable gain on the only sizes this ever sees.
 */
const lcsLengths = (left: string[], right: string[]): number[][] => {
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0)
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        wordOf(left[i]) === wordOf(right[j])
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  return table;
};

/**
 * Diff the approved wording against what the author actually wrote.
 *
 * Both sides are trimmed first, for the same reason `consentTextMatches` trims:
 * a trailing newline a textarea added is not an edit the author made, and
 * reporting it as one would put "1 word added" beside two identical sentences.
 */
export const diffConsentText = (
  approved: string,
  current: string
): ConsentDiff => {
  const left = tokenise(approved.trim());
  const right = tokenise(current.trim());

  if (left.length > MAX_DIFF_TOKENS || right.length > MAX_DIFF_TOKENS) {
    return {
      segments: [],
      addedWords: 0,
      removedWords: 0,
      whitespaceOnly: false,
      tooLargeToCompare: true
    };
  }

  const table = lcsLengths(left, right);

  const segments: ConsentDiffSegment[] = [];
  let addedWords = 0;
  let removedWords = 0;

  // Adjacent tokens of the same kind are merged as they are emitted rather than
  // in a second pass, so a rewritten clause renders as one marked run instead of
  // as a word-by-word stutter of separate <del> elements - which reads badly and
  // is announced by a screen reader once per element.
  const push = (kind: ConsentDiffKind, text: string) => {
    const last = segments[segments.length - 1];

    if (last && last.kind === kind) {
      segments[segments.length - 1] = { kind, text: last.text + text };
      return;
    }

    segments.push({ kind, text });
  };

  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (wordOf(left[i]) === wordOf(right[j])) {
      // The AUTHOR's spacing is what stays on screen: this is their wording
      // now, and re-imposing the template's line breaks on it would show them
      // a paragraph they did not write.
      push('same', right[j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      removedWords += 1;
      push('removed', left[i]);
      i += 1;
    } else {
      addedWords += 1;
      push('added', right[j]);
      j += 1;
    }
  }

  while (i < left.length) {
    removedWords += 1;
    push('removed', left[i]);
    i += 1;
  }

  while (j < right.length) {
    addedWords += 1;
    push('added', right[j]);
    j += 1;
  }

  return {
    segments,
    addedWords,
    removedWords,
    whitespaceOnly:
      addedWords === 0 && removedWords === 0 && approved.trim() !== current.trim(),
    tooLargeToCompare: false
  };
};

/**
 * The diff in one sentence, for people who are not going to read the marked-up
 * paragraph - and for those who cannot, since colour and strike-through carry
 * no meaning to a screen reader.
 */
export const describeConsentDiff = (diff: ConsentDiff): string => {
  if (diff.tooLargeToCompare) {
    return 'This wording is too long to compare word by word with the approved wording.';
  }

  if (diff.whitespaceOnly) {
    return 'The words are unchanged; only the spacing differs.';
  }

  if (diff.addedWords === 0 && diff.removedWords === 0) {
    return 'No wording has changed.';
  }

  const parts: string[] = [];

  if (diff.removedWords > 0) {
    parts.push(
      `${diff.removedWords} ${diff.removedWords === 1 ? 'word' : 'words'} removed`
    );
  }

  if (diff.addedWords > 0) {
    parts.push(
      `${diff.addedWords} ${diff.addedWords === 1 ? 'word' : 'words'} added`
    );
  }

  return `${parts.join(', ')} compared with the approved wording.`;
};
