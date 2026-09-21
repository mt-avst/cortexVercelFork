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

/**
 * Colour literals: a hex, or any of CSS's colour FUNCTIONS, captured whole.
 *
 * THE FIRST VERSION OF THIS PATTERN HAD TWO HOLES, both found by mutation
 * rather than by reading it. It matched only hex and comma-form rgb/rgba, so
 * an inline text colour set to the bare word white survived it, and so did
 * the same white written as a space-separated hsl. Neither shape is exotic:
 * they are what a hurried hand reaches for when a token is not to hand.
 *
 * Colour functions are now matched by name and captured to their closing
 * bracket, which also gives the scrim exception below a complete value to
 * test rather than a truncated prefix. The lookbehind keeps the `srgb` inside
 * a colour-mix interpolation clause from reading as an rgb call.
 */
const COLOUR_LITERAL =
  /#[0-9a-f]{3,8}\b|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^)]*\)/gi;

/**
 * CSS's named colours, which are literals exactly as much as a hex is. The
 * keywords that are NOT a fixed colour - transparent, currentColor, inherit -
 * are deliberately absent, because those are the theme-safe answers.
 */
const NAMED_COLOURS = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque',
  'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood',
  'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk',
  'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray',
  'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta', 'darkolivegreen',
  'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise',
  'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue',
  'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro',
  'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey',
  'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral',
  'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey',
  'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray',
  'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime', 'limegreen',
  'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue',
  'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue',
  'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace',
  'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod',
  'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff',
  'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red',
  'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray',
  'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle',
  'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen',
];

/**
 * A named colour in a VALUE position: somewhere to the right of a colon, on
 * the same declaration, as a whole word. The leading colon is what keeps a
 * pseudo-class or a property name from reading as a value, and the character
 * class stops the scan at the declaration's own boundaries so it cannot reach
 * across into the next rule.
 */
const NAMED_COLOUR_VALUE = new RegExp(
  `:[^;{}\\n]*?(?<![\\w-])['"\`]?(?:${NAMED_COLOURS.join('|')})(?![\\w-])`,
  'gi'
);

/**
 * The scrim and its shadow, both intentionally theme-neutral black. Matched
 * against what COLOUR_LITERAL captures, which is now a complete colour
 * function, closing bracket included.
 */
const ALLOWED_NEUTRAL = /^rgba?\(\s*0\s*,\s*0\s*,\s*0\b[^)]*\)$/i;

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

/** Every literal shape this file refuses, in one pass over a source. */
const literalsIn = (source: string): string[] => {
  const clean = withoutComments(source);
  return [
    ...(clean.match(COLOUR_LITERAL) ?? []),
    ...(clean.match(NAMED_COLOUR_VALUE) ?? []),
  ];
};

describe('AdminFeedback carries no dark-baked colour', () => {
  it('has no colour literal in an inline style, except the deliberate black scrim', () => {
    const offences = literalsIn(COMPONENT).filter(
      (literal) => !ALLOWED_NEUTRAL.test(literal)
    );

    expect(offences).toEqual([]);
  });

  it('keeps the scrim exception to exactly the two neutral blacks, so it cannot widen', () => {
    const neutrals = literalsIn(COMPONENT).filter((literal) =>
      ALLOWED_NEUTRAL.test(literal)
    );

    // The backdrop and the modal's drop shadow. A third means somebody added a
    // literal and reached for this exception rather than a token.
    expect(neutrals).toHaveLength(2);
  });

  it('has no colour literal in the stylesheet either', () => {
    expect(literalsIn(CSS)).toEqual([]);
  });

  /**
   * CONTROLS FOR THE SCANNER ITSELF.
   *
   * The three arms above assert an EMPTY list, and an empty list is what a
   * broken scanner returns too. These two prove the scanner can still see the
   * shapes it is meant to see - in particular the two it could not see before
   * this round, a bare named colour and a space-separated hsl.
   */
  it('detects a named colour in a value position, hex form or not', () => {
    const probe = "const style = { color: 'white', background: 'none' };";
    expect(literalsIn(probe)).not.toEqual([]);
  });

  it('detects a space separated hsl and a hex, and leaves the theme safe keywords alone', () => {
    expect(literalsIn('.x { color: hsl(0 0% 100%); }')).not.toEqual([]);
    expect(literalsIn('.x { color: #ff5a1f; }')).not.toEqual([]);
    expect(
      literalsIn('.x { color: transparent; background: currentColor; border: inherit; }')
    ).toEqual([]);
    // color-mix over a token is the sanctioned tint form and must stay clean,
    // or the arms above would fail on this file's own alert rules.
    expect(
      literalsIn('.x { background: color-mix(in srgb, var(--status-danger) 15%, transparent); }')
    ).toEqual([]);
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

  /**
   * THE ERROR TEXT'S OWN RULE, pinned to its own selector.
   *
   * The arm above searches the whole file, so any other rule reaching for the
   * danger-text token satisfies it. This one names the selector, which is the
   * half of the pair the rendered arm in `AdminFeedback.test.tsx` cannot see:
   * that one proves the element is nested where this selector can reach it,
   * this one proves the selector still paints danger red when it does.
   */
  it('paints the scoped error text rule from the danger text token', () => {
    expect(blockFor('.admin-feedback .feedback-error-text')).toMatch(
      /color:\s*var\(--status-danger-text\)\s*;/
    );
  });

  /**
   * THE MODAL'S SECONDARY TEXT, per rule.
   *
   * These four sit on the translucent dialog surface over the 0.85 black
   * view-modal scrim. --text-muted measures 4.35:1 on that composite in
   * light, which is under AA for normal text; --text-secondary measures
   * 7.21:1. Nothing in the previous revision of this file named these rules
   * at all, so swapping either of them back to the muted token was invisible.
   * Each is pinned by its own selector, because a file-wide search for the
   * secondary token is satisfied by whichever rule still has it.
   */
  it('pins the modal secondary text to the secondary token, not the muted one', () => {
    const secondaryRules = [
      '.admin-feedback .feedback-modal-header small',
      '.admin-feedback .feedback-modal-placeholder',
      '.admin-feedback .feedback-modal-meta',
      '.admin-feedback .feedback-modal-meta-item',
    ];

    for (const selector of secondaryRules) {
      const block = blockFor(selector);
      expect(block, selector).toMatch(/color:\s*var\(--text-secondary\)\s*;/);
      expect(block, selector).not.toMatch(/color:\s*var\(--text-muted\)/);
    }
  });

  it('pins the modal meta icon to the brand headline token', () => {
    // The one deliberately non-text colour in the meta block: an accent glyph,
    // dimmed by opacity rather than by a second colour. Unnamed until now, so
    // repointing it at any other token survived the whole suite.
    expect(blockFor('.admin-feedback .feedback-modal-meta-icon')).toMatch(
      /color:\s*var\(--brand-headline\)\s*;/
    );
  });

  it('pins the warning alert text to the primary text token', () => {
    // Same rule as the danger alert's text: the warning SIGNAL token is a
    // border-and-tint colour, and using it for the words drops the notice
    // well under AA on the tinted surface it sits on. Before this arm, that
    // swap changed the rendered colour and no test noticed.
    const warning = blockFor('.feedback-alert--warning');
    expect(warning).toMatch(/color:\s*var\(--text-primary\)\s*;/);
    expect(warning).not.toMatch(/color:\s*var\(--status-warning[a-z-]*\)\s*;/);
  });

  it('declares the stylesheet rather than re-growing an inline style block', () => {
    expect(COMPONENT).toMatch(/import\s+['"]\.\/admin-feedback\.css['"]/);
    expect(COMPONENT).not.toMatch(/<style[\s>]/);
  });
});
