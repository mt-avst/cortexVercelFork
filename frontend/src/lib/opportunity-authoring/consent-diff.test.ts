import { describe, expect, it } from 'vitest';

import { describeConsentDiff, diffConsentText } from './consent-diff';

/** The visible text, in order, ignoring how it was marked up. */
const rendered = (segments: readonly { text: string }[]) =>
  segments.map((segment) => segment.text).join('');

/** Only the runs of one kind, joined, so a test can name what changed. */
const of = (
  segments: readonly { kind: string; text: string }[],
  kind: string
) =>
  segments
    .filter((segment) => segment.kind === kind)
    .map((segment) => segment.text)
    .join('|');

describe('diffConsentText', () => {
  it('reports nothing changed when nothing changed', () => {
    const diff = diffConsentText('We record your screen.', 'We record your screen.');

    expect(diff.addedWords).toBe(0);
    expect(diff.removedWords).toBe(0);
    expect(diff.segments.every((segment) => segment.kind === 'same')).toBe(true);
  });

  /**
   * Trimming, and only trimming - the same rule `consentTextMatches` follows.
   * A textarea adds a trailing newline for free, and "1 word added" beside two
   * identical sentences teaches an author to stop reading the summary.
   */
  it('ignores surrounding whitespace', () => {
    const diff = diffConsentText('We record your screen.', '  We record your screen.\n');

    expect(diff.addedWords).toBe(0);
    expect(diff.removedWords).toBe(0);
  });

  it('marks an inserted clause as added, and nothing else', () => {
    const diff = diffConsentText(
      'We record your screen and microphone.',
      'We record your screen, your camera and microphone.'
    );

    // The counts alone would pass for a diff that marked the whole sentence.
    // Naming which words are marked is what pins it to the actual change.
    expect(of(diff.segments, 'added')).toContain('camera');
    expect(of(diff.segments, 'removed')).not.toContain('microphone');
    expect(diff.addedWords).toBeGreaterThan(0);
  });

  it('marks a deleted clause as removed', () => {
    const diff = diffConsentText(
      'We record your screen and microphone.',
      'We record your screen.'
    );

    expect(of(diff.segments, 'removed')).toContain('microphone');
    expect(diff.removedWords).toBeGreaterThan(0);
    // One addition, and it is not a bug: punctuation travels with its word, so
    // deleting a trailing clause turns "screen" into "screen." and that reads
    // as one word replaced. Written down rather than smoothed over, because the
    // alternative - stripping punctuation before comparing - would let a full
    // stop moved into the middle of a sentence pass as no change at all.
    expect(diff.addedWords).toBe(1);
    expect(of(diff.segments, 'added')).toBe('screen.');
  });

  /**
   * The reassembled diff must be readable as prose in both directions:
   * everything the template said appears once across `same` + `removed`, and
   * everything the author wrote appears once across `same` + `added`. A diff
   * that drops a word from the middle is worse than no diff at all, because it
   * shows the author a sentence neither side ever contained.
   */
  it('loses nothing from either side', () => {
    const approved = 'This session records your screen and microphone while you work.';
    const current = 'This session records your screen while you work, and stores it.';
    const diff = diffConsentText(approved, current);

    expect(
      rendered(diff.segments.filter((segment) => segment.kind !== 'added'))
    ).toBe(approved);
    expect(
      rendered(diff.segments.filter((segment) => segment.kind !== 'removed'))
    ).toBe(current);
  });

  it('merges adjacent words of the same kind into one run', () => {
    const diff = diffConsentText('a b c d', 'a d');

    // "b c" is one removal, not two - a word-by-word stutter of separate
    // elements reads badly and is announced once per element.
    const removals = diff.segments.filter((segment) => segment.kind === 'removed');
    expect(removals).toHaveLength(1);
    expect(removals[0].text.trim()).toBe('b c');
  });

  it('counts words rather than tokens, so whitespace never inflates the total', () => {
    const diff = diffConsentText('one two', 'one two three four');

    expect(diff.addedWords).toBe(2);
    expect(diff.removedWords).toBe(0);
  });

  it('handles the wording being replaced outright', () => {
    const diff = diffConsentText('Alpha beta.', 'Completely different words here.');

    expect(diff.removedWords).toBe(2);
    expect(diff.addedWords).toBe(4);
  });

  it('handles an emptied field without throwing', () => {
    const diff = diffConsentText('Alpha beta.', '');

    expect(diff.addedWords).toBe(0);
    expect(diff.removedWords).toBe(2);
  });
});

describe('diffConsentText - the rendered runs stay readable', () => {
  /**
   * 🔥 Found in a browser, not by a test.
   *
   * Whitespace used to be tokenised in its own right and matched by the LCS, so
   * a replaced word left the deletion and the insertion abutting with no space
   * between them. The screen read "This sessionWe recordsrecord your screen" -
   * every word run together, on the one surface whose entire job is showing an
   * author exactly what their consent no longer says.
   */
  it('never leaves a deleted run touching the inserted run that replaced it', () => {
    const diff = diffConsentText(
      'This session records your screen and microphone.',
      'We record your screen and microphone.'
    );

    for (let i = 0; i < diff.segments.length - 1; i += 1) {
      const here = diff.segments[i];
      const next = diff.segments[i + 1];
      if (here.kind === next.kind) continue;
      // Whatever the boundary, the left side ends in whitespace or the right
      // side begins with it. Otherwise two words render as one.
      expect(/\s$/.test(here.text) || /^\s/.test(next.text)).toBe(true);
    }
  });

  it('keeps the author\'s own spacing on the words they kept', () => {
    const diff = diffConsentText('one two three', 'one\ntwo three');
    const kept = diff.segments.filter((s) => s.kind === 'same').map((s) => s.text).join('');

    // Their line break, not the template's space.
    expect(kept).toContain('\n');
  });
});

describe('diffConsentText - the two states that are not a word change', () => {
  it('reports a spacing-only difference as such, rather than as no change', () => {
    // `consentTextMatches` compares the interiors exactly, so this study IS
    // classified custom. A diff saying "No wording has changed" beside a
    // "Custom wording" badge would look like one of the two was broken.
    const diff = diffConsentText('one two', 'one  two');

    expect(diff.addedWords).toBe(0);
    expect(diff.removedWords).toBe(0);
    expect(diff.whitespaceOnly).toBe(true);
    expect(describeConsentDiff(diff)).toBe(
      'The words are unchanged; only the spacing differs.'
    );
  });

  it('does not claim a spacing-only difference when the texts are identical', () => {
    expect(diffConsentText('one two', 'one two').whitespaceOnly).toBe(false);
    expect(diffConsentText('one two', ' one two\n').whitespaceOnly).toBe(false);
  });

  /**
   * `consent_text` is capped at 10,000 characters on the authoring paths but
   * NOT on the studies API, where only the 100kb JSON body limit applies. The
   * table is quadratic in the token counts, so an unbounded value allocates
   * tens of millions of cells - on a step that opens its editor by itself for
   * custom wording. Refusing beats freezing the author's tab.
   */
  it('refuses to compare wording far larger than any consent copy', () => {
    const huge = 'word '.repeat(60_000);
    const started = Date.now();
    const diff = diffConsentText('short approved wording', huge);

    expect(diff.tooLargeToCompare).toBe(true);
    expect(diff.segments).toEqual([]);
    expect(describeConsentDiff(diff)).toMatch(/too long to compare/i);
    // The point is that it did not try. A quadratic table over 60,000 tokens
    // would not return in this budget.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still compares wording of an ordinary length', () => {
    const long = 'word '.repeat(400);
    expect(diffConsentText(long, `${long}extra`).tooLargeToCompare).toBe(false);
  });
});

describe('describeConsentDiff', () => {
  /**
   * Colour, strike-through and underline carry nothing to a screen reader, so
   * this sentence is the entire diff for a share of the people the feature is
   * meant to protect. It is not a nicety.
   */
  it('says so plainly when nothing changed', () => {
    expect(
      describeConsentDiff(diffConsentText('same words', 'same words'))
    ).toBe('No wording has changed.');
  });

  it('reports removals before additions, and counts both', () => {
    expect(
      describeConsentDiff(diffConsentText('one two three', 'one four five six'))
    ).toBe('2 words removed, 3 words added compared with the approved wording.');
  });

  it('reports only what actually happened', () => {
    expect(describeConsentDiff(diffConsentText('one two', 'one'))).toBe(
      '1 word removed compared with the approved wording.'
    );
    expect(describeConsentDiff(diffConsentText('one', 'one two'))).toBe(
      '1 word added compared with the approved wording.'
    );
  });
});
