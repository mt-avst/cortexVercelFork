import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import CortexMark from '../CortexMark';

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
    expect(svg).toHaveAttribute('viewBox', '0 0 48 48');
    expect(stems).toHaveLength(3);
    expect(group).toHaveAttribute('stroke', 'currentColor');
    expect(nodes).toHaveLength(4);
    nodes.forEach((node) => expect(node).toHaveAttribute('fill', 'currentColor'));
  });
});
