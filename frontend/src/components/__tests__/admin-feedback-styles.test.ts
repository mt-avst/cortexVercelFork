import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * AdminFeedback carries no dark-baked colour (cto/AdaptaLabs#141).
 *
 * THE DEFECT. This component's styling lived in a `<style>` tag inside the
 * .tsx, and its modal carried eight inline `style={{}}` colour literals -
 * `#fff`, `rgba(224, 224, 224, *)`, `rgba(255, 78, 80, *)` - plus two alert
 * blocks baked to bootstrap's danger red and warning amber. Inline style beats
 * an external rule on specificity no matter how the selector is weighted, so
 * those literals won over the token-driven rules sitting right beside them and
 * the surface rendered frozen-dark on a light theme.
 *
 * WHY THIS IS A SOURCE-PINNING TEST AND WHAT THAT DOES NOT BUY. jsdom applies
 * no CSS, so nothing here proves a rendered colour. It proves the two things
 * that actually regress: that the colours live in a stylesheet rather than in
 * inline style, and that they are expressed as tokens rather than literals. A
 * token that is itself wrong in one theme is invisible to this file - that is
 * what the contrast arms in the sibling `pending-approvals-styles.test.ts`
 * and the repo's axe run are for.
 *
 * THE SCRIM IS A DELIBERATE EXCEPTION, not an oversight. A modal backdrop and
 * its drop shadow are black in both themes by design - a scrim that inverts
 * with the theme stops being a scrim. They are allowed by name below rather
 * than by loosening the rule, so a NEW literal anywhere else still fails.
 */

const COMPONENT = readFileSync(
  join(__dirname, '..', 'AdminFeedback.tsx'),
  'utf8'
);
const CSS = readFileSync(join(__dirname, '..', 'admin-feedback.css'), 'utf8');

/** Colour literals: hex, or rgb/rgba with a non-zero channel. */
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/gi;

/**
 * The scrim and its shadow, both intentionally theme-neutral black. Matched
 * against what COLOUR_LITERAL captures, which stops at the third channel and
 * carries no closing delimiter - so this pattern must not demand one.
 */
const ALLOWED_NEUTRAL = /^rgba?\(\s*0\s*,\s*0\s*,\s*0$/;

/** The declarations of one rule, so an arm pins the property it names. */
const blockFor = (selector: string): string => {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const from = CSS.indexOf('{', start);
  return CSS.slice(from + 1, CSS.indexOf('\n}', from));
};

/** Strips block and line comments so a comment quoting an old value is not an offence. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('AdminFeedback carries no dark-baked colour', () => {
  it('has no colour literal in an inline style, except the deliberate black scrim', () => {
    const offences = (withoutComments(COMPONENT).match(COLOUR_LITERAL) ?? []).filter(
      (literal) => !ALLOWED_NEUTRAL.test(literal)
    );

    expect(offences).toEqual([]);
  });

  it('keeps the scrim exception to exactly the two neutral blacks, so it cannot widen', () => {
    const neutrals = (withoutComments(COMPONENT).match(COLOUR_LITERAL) ?? []).filter(
      (literal) => ALLOWED_NEUTRAL.test(literal)
    );

    // The backdrop and the modal's drop shadow. A third means somebody added a
    // literal and reached for this exception rather than a token.
    expect(neutrals).toHaveLength(2);
  });

  it('has no colour literal in the stylesheet either', () => {
    expect(withoutComments(CSS).match(COLOUR_LITERAL) ?? []).toEqual([]);
  });

  /**
   * THE BACKGROUND LINE SPECIFICALLY, not "somewhere in the block".
   *
   * The first version of this arm matched `--status-danger` anywhere inside
   * the danger block, and a control refuted it: swapping the BACKGROUND to
   * `--status-warning` left the arm green, because the block's border line
   * still mentioned `--status-danger`. An arm that a whole wrong colour walks
   * past is decorative. Each property is now pinned on its own line.
   */
  it('tints the two alerts from their own status token rather than bootstrap reds', () => {
    const danger = blockFor('.feedback-alert--danger');
    expect(danger).toMatch(
      /background-color:\s*color-mix\(in srgb, var\(--status-danger\)/
    );
    expect(danger).toMatch(/border:[^;]*var\(--status-danger\)/);

    const warning = blockFor('.feedback-alert--warning');
    expect(warning).toMatch(
      /background-color:\s*color-mix\(in srgb, var\(--status-warning\)/
    );
    expect(warning).toMatch(/border:[^;]*var\(--status-warning\)/);
  });

  it('colours alert text from the text-pair tokens, never from the signal token', () => {
    // --status-danger is a 3.15:1 signal colour: right for a border, wrong for
    // words. --status-danger-text is the pair designed to clear AA in both.
    expect(CSS).toMatch(/color:\s*var\(--status-danger-text\)/);
    expect(CSS).not.toMatch(/color:\s*var\(--status-danger\)\s*;/);
  });

  it('declares the stylesheet rather than re-growing an inline style block', () => {
    expect(COMPONENT).toMatch(/import\s+['"]\.\/admin-feedback\.css['"]/);
    expect(COMPONENT).not.toMatch(/<style[\s>]/);
  });
});
