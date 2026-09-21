import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * THE TWO QUESTION BUILDERS' DESTRUCTIVE CONTROLS, pinned to the text pair.
 *
 * cto/AdaptaLabs#141 repointed the remove/delete icon buttons in these two
 * component-local stylesheets from `--status-danger` to `--status-danger-text`.
 * The two tokens are the SAME value in light and diverge in dark, where
 * `--status-danger` measures 3.15:1 as text on the app ground - a signal
 * colour, built for a border or a fill, not for a glyph somebody has to read.
 * `--status-danger-text` is the pair built for the text role.
 *
 * WHY THIS FILE EXISTS. Reverting either of those two declarations survived
 * the whole frontend suite: the change was a one-word swap between two tokens
 * that both exist, both resolve, and differ only in dark, so no lint, no type
 * check and no render test could see it. It regresses silently and it
 * regresses only for dark-theme users, which is the worst combination going.
 *
 * WHAT IT DELIBERATELY DOES NOT PIN. `--status-danger` is still the RIGHT
 * answer for a border - the needs-attention card's left edge uses it, and the
 * negative arm below is scoped to the two text rules rather than to the file,
 * so that border is free to stay as it is.
 */

const read = (file: string): string =>
  readFileSync(join(__dirname, '..', file), 'utf8');

const QUESTION_LIST = read('question-list.css');
const SCREENER = read('screener-questions.css');

/** The declarations of one rule, so an arm pins the property it names. */
const blockFor = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const from = css.indexOf('{', start);
  return css.slice(from + 1, css.indexOf('\n}', from));
};

/** Strips comments, so a comment naming the old token is not read as the code. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '');

describe('question builder destructive controls use the danger text token', () => {
  it('colours the question list remove control from the danger text token', () => {
    const block = withoutComments(
      blockFor(QUESTION_LIST, '.question-card__control--danger')
    );

    expect(block).toMatch(/color:\s*var\(--status-danger-text\)\s*;/);
    // The bare signal token is what this was, and what a careless revert
    // would put back. Pinned negatively as well as positively, because the
    // positive arm alone would pass a rule that declared both.
    expect(block).not.toMatch(/color:\s*var\(--status-danger\)\s*;/);
  });

  it('colours the screener option remove control from the danger text token', () => {
    const block = withoutComments(
      blockFor(SCREENER, '.screener-option__remove')
    );

    expect(block).toMatch(/color:\s*var\(--status-danger-text\)\s*;/);
    expect(block).not.toMatch(/color:\s*var\(--status-danger\)\s*;/);
  });

  /**
   * CONTROL. The two arms above assert on a rule looked up by name, and a
   * lookup that silently found nothing would be an arm that cannot fail.
   * `blockFor` throws on a missing selector rather than returning empty, and
   * this proves it - so a renamed selector shows up as a red test here
   * instead of as a guard that quietly stopped guarding anything.
   */
  it('throws rather than passing vacuously when a pinned selector is renamed', () => {
    expect(() => blockFor(QUESTION_LIST, '.question-card__no-such-rule')).toThrow(
      /selector not found/
    );
  });

  /**
   * The signal token stays available for the role it IS right for. This arm
   * is what stops the two above from being read as "never use the signal
   * token in this file", which would be the wrong lesson.
   */
  it('leaves the signal token in place on the needs attention card border', () => {
    expect(
      withoutComments(blockFor(QUESTION_LIST, '.question-card--needs-attention'))
    ).toMatch(/border-left-color:\s*var\(--status-danger\)\s*;/);
  });
});
