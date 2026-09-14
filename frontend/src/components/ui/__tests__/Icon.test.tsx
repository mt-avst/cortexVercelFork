import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ArrowRight } from 'lucide-react';
import { Icon } from '../Icon';

/**
 * One wrapper over lucide, so every glyph in the product is stroked at the
 * same weight regardless of its pixel size (lucide's raw components scale
 * stroke-width with the viewBox, so a bare 14px icon reads thinner than a
 * bare 24px one at the same `strokeWidth={2}`). `absoluteStrokeWidth` fixes
 * that; this test pins it ON by default rather than trusting every call site
 * to remember the prop.
 */
describe('Icon', () => {
  it('defaults to size 16', () => {
    const { container } = render(<Icon icon={ArrowRight} aria-hidden="true" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
  });

  it.each([14, 16, 20, 24] as const)('renders at the canonical %ipx size', (size) => {
    const { container } = render(<Icon icon={ArrowRight} size={size} aria-hidden="true" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe(String(size));
    expect(svg?.getAttribute('height')).toBe(String(size));
  });

  it('applies absoluteStrokeWidth: a 16px icon strokes heavier than lucide\'s raw 24px default', () => {
    const { container } = render(<Icon icon={ArrowRight} size={16} aria-hidden="true" />);
    const svg = container.querySelector('svg');
    // lucide's own absoluteStrokeWidth formula: strokeWidth * 24 / size.
    // Without it this would read "2" (the raw default) at any size.
    expect(svg?.getAttribute('stroke-width')).toBe('3');
  });

  it('scales stroke-width for a non-integer result (14px) rather than dropping absoluteStrokeWidth', () => {
    const { container } = render(<Icon icon={ArrowRight} size={14} aria-hidden="true" />);
    const svg = container.querySelector('svg');
    const strokeWidth = parseFloat(svg?.getAttribute('stroke-width') ?? '0');
    expect(strokeWidth).toBeCloseTo((2 * 24) / 14, 5);
  });

  it('passes through aria-hidden and className to the underlying svg', () => {
    const { container } = render(
      <Icon icon={ArrowRight} aria-hidden="true" className="opportunity-row__icon" />
    );
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('class')).toContain('opportunity-row__icon');
  });

  it('rejects a non-canonical size at compile time (enforced by npm run typecheck)', () => {
    // A review gate found the previous version of this test asserted a
    // locally-declared array had length 4, which cannot fail for the reason
    // its name gave. This one actually exercises the type: `size={18}`
    // must be a type error, or `@ts-expect-error` itself errors ("unused
    // directive") and `npm run typecheck` fails for real.
    const renderWithInvalidSize = () => (
      // @ts-expect-error - 18 is not one of the four canonical IconSize values
      <Icon icon={ArrowRight} size={18} aria-hidden="true" />
    );
    expect(typeof renderWithInvalidSize).toBe('function');
  });
});
