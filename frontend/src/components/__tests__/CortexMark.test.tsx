import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import CortexMark from '../CortexMark';

/**
 * The tightened artboard, and the ink it frames. Both are literals on purpose:
 * `ARTBOARD` is what every asset carrying this mark must agree on (see
 * cortex-mark-assets.test.ts), and `INK` is the measured bounding box of the
 * shipped geometry - soma r6.5 at (24,24), satellites r4.2 at (24,9),
 * (12,31.5) and (36,31.5). Deriving either from the component would make the
 * checks below unable to see the thing they exist to watch.
 */
const ARTBOARD = '6.8 3.05 34.4 34.4';
const INK = { x0: 7.8, y0: 4.8, x1: 40.2, y1: 35.7 };

describe('CortexMark', () => {
  it('is decorative by default - hidden from assistive tech, no accessible name', () => {
    const { container } = render(<CortexMark className="logo-mark" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveClass('logo-mark');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(container.querySelector('title')).toBeNull();
  });

  it('carries an accessible name when given a title', () => {
    const { container, getByTitle } = render(<CortexMark title="Cortex" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).toHaveAttribute('aria-label', 'Cortex');
    expect(svg).not.toHaveAttribute('aria-hidden');
    expect(getByTitle('Cortex')).toBeInTheDocument();
  });

  it('draws the neuron with currentColor so it inherits ink or brand orange', () => {
    const { container } = render(<CortexMark />);
    const svg = container.querySelector('svg');
    const group = container.querySelector('g');
    const stems = container.querySelectorAll('path');
    const nodes = container.querySelectorAll('circle');
    // The mark: three limbs (stroked paths, weight on the group) + four filled
    // nodes (a central node and three satellites). All colour is currentColor.
    expect(svg).toHaveAttribute('viewBox', ARTBOARD);
    expect(stems).toHaveLength(3);
    expect(group).toHaveAttribute('stroke', 'currentColor');
    expect(nodes).toHaveLength(4);
    nodes.forEach((node) => expect(node).toHaveAttribute('fill', 'currentColor'));
  });

  it('frames the artboard on the ink, not on a 48x48 grid that is a third empty', () => {
    // The mark shipped inside viewBox "0 0 48 48" while its ink spans only
    // x 7.8-40.2 and y 4.8-35.7 - 32.4 x 30.9, so a THIRD of the artboard was
    // empty margin and the 30px header slot painted about 20px of mark against
    // an 18px cap height. Reframing onto the ink (Decision 1, Nick's pick
    // 2026-09-14: the shipped geometry, artboard tightened, nothing redrawn)
    // makes the same 30px slot paint about 28px.
    //
    // Pinned as a LITERAL rather than derived from the geometry: a test that
    // recomputes the bounding box it is checking cannot see the box change.
    const { container } = render(<CortexMark />);
    expect(container.querySelector('svg')).toHaveAttribute('viewBox', '6.8 3.05 34.4 34.4');

    const [minX, minY, w, h] = ARTBOARD.split(' ').map(Number);
    expect(w).toBe(h); // square, so the mark cannot skew in a non-square slot
    // The ink must FIT, with a margin small enough that the reframe was real.
    expect(minX).toBeLessThanOrEqual(INK.x0);
    expect(minY).toBeLessThanOrEqual(INK.y0);
    expect(minX + w).toBeGreaterThanOrEqual(INK.x1);
    expect(minY + h).toBeGreaterThanOrEqual(INK.y1);
    const fill = (100 * Math.max(INK.x1 - INK.x0, INK.y1 - INK.y0)) / w;
    expect(fill).toBeGreaterThan(90);
    expect(fill).toBeLessThan(99); // some optical margin, not edge-to-edge
  });

  it('keeps the shipped geometry exactly - this change reframes, it does not redraw', () => {
    // Every coordinate pinned as a literal. Nick reviewed four redraw
    // candidates on 2026-09-14 and chose NONE of them, so a geometry change
    // arriving here is a regression until he picks one.
    const { container } = render(<CortexMark />);
    const d = [...container.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    expect(d).toEqual(['M24 24 24 9', 'M24 24 12 31.5', 'M24 24 36 31.5']);

    const circles = [...container.querySelectorAll('circle')].map((c) => [
      c.getAttribute('cx'),
      c.getAttribute('cy'),
      c.getAttribute('r'),
    ]);
    expect(circles).toEqual([
      ['24', '9', '4.2'],
      ['12', '31.5', '4.2'],
      ['36', '31.5', '4.2'],
      ['24', '24', '6.5'],
    ]);
    expect(container.querySelector('g')).toHaveAttribute('stroke-width', '4.8');
    expect(container.querySelector('g')).toHaveAttribute('stroke-linecap', 'round');
  });
});
