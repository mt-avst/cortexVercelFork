import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StepMarker } from '../StepMarker';

/**
 * The recording rail used two different step-marker implementations: the
 * Journey list's tick (a fixed "✓" text node, hidden via `color: transparent`
 * until done) and the launch list's numbered circle (a ternary between a
 * digit string and a literal "✓"). One component now backs both, and neither
 * hardcodes the checkmark as a unicode character - it is a lucide glyph.
 */
describe('StepMarker', () => {
  it('shows the step number when not done, for the numbered variant', () => {
    const { getByText, container } = render(
      <StepMarker variant="numbered" index={2} done={false} />
    );
    expect(getByText('2')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows a lucide check glyph, not a unicode tick, once done', () => {
    const { container, queryByText } = render(
      <StepMarker variant="numbered" index={1} done />
    );
    expect(container.querySelector('svg')).not.toBeNull();
    expect(queryByText('✓')).toBeNull();
    expect(queryByText('1')).toBeNull();
  });

  it('renders no digit for the tick variant, done or not (the rail names the step in text beside it)', () => {
    const { container: notDone } = render(<StepMarker variant="tick" index={3} done={false} />);
    expect(notDone.textContent).toBe('');

    const { container: done, queryByText } = render(<StepMarker variant="tick" index={3} done />);
    expect(done.querySelector('svg')).not.toBeNull();
    expect(queryByText('✓')).toBeNull();
  });

  it('keeps the existing CSS hook class names so no stylesheet rule needs to move', () => {
    const { container: numbered } = render(<StepMarker variant="numbered" index={1} done={false} />);
    expect(numbered.querySelector('.journey-launch-num')).not.toBeNull();

    const { container: tick } = render(<StepMarker variant="tick" index={1} done={false} />);
    expect(tick.querySelector('.journey-vtick')).not.toBeNull();
  });

  it('is aria-hidden: the surrounding item already carries the accessible state', () => {
    const { container } = render(<StepMarker variant="numbered" index={1} done={false} />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});
