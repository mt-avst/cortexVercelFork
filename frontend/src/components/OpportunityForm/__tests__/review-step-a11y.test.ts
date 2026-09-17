import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Code review MEDIUM (a11y, row 30): `.review-section__edit`'s Edit link
 * used the identity accent `--fs-accent` (#FF5A1F) as its own text colour -
 * at 0.875rem that measures ~3:1 on the light cream surface, below WCAG
 * AA's 4.5:1 for text. `--fs-accent-strong` is the theme's own "text-safe
 * fill step" for exactly this case (`_themes.css`'s comment beside both
 * tokens: `--fs-accent` is "the identity step", `--fs-accent-strong` "the
 * text-safe" one - ~5.18:1 on white).
 *
 * A rendered-DOM assertion cannot see this: jsdom does not apply an
 * external stylesheet, so a class-based `color` declaration never reaches
 * `getComputedStyle` in a component test. This reads the stylesheet source
 * instead, the same technique `styles/__tests__/accent-fill-policy.test.ts`
 * already uses for the identical class of defect (an identity fill or a
 * literal colour standing in for the text-safe token).
 */
describe('ReviewStep - the Edit link colour is the text-safe accent step, not the identity one', () => {
  const css = readFileSync(join(__dirname, '..', 'review-step.css'), 'utf8');
  const ruleStart = css.indexOf('.review-section__edit {');
  const ruleEnd = css.indexOf('\n}', ruleStart);
  const rule = ruleStart >= 0 && ruleEnd > ruleStart ? css.slice(ruleStart, ruleEnd) : '';

  it('finds the rule it is supposed to be checking', () => {
    // A policy test that silently reads nothing passes forever.
    expect(rule).not.toBe('');
  });

  it('sets its colour from --fs-accent-strong', () => {
    expect(rule).toMatch(/color:\s*var\(--fs-accent-strong\)/);
  });

  it('does not fall back to the identity --fs-accent for its own text colour', () => {
    // A regex that would also match "--fs-accent-strong" is the exact wrong
    // shape of check here - it must reject the identity token SPECIFICALLY,
    // not merely find something containing its name.
    expect(rule).not.toMatch(/color:\s*var\(--fs-accent\)/);
  });
});
