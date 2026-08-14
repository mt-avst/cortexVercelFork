import { describe, it, expect } from 'vitest';

import { buildNeuralConfig } from '../StaticNeuralBackground';

// The background animation is decorative, but honouring prefers-reduced-motion
// is not - it is an accessibility control for people who get motion sickness
// or vestibular symptoms from movement on screen.
//
// It was half-broken. `animate` depended on the preference so the frame rate
// was throttled, but the callbacks that build and move the nodes had empty
// dependency arrays, so they captured the config object from the FIRST render -
// built while the preference state was still its `false` default, before the
// media query had been read. Someone with reduce-motion set got 30fps of the
// full 180 nodes at full orbit speed and full wobble.
//
// These assert the values themselves rather than the wiring, so they stay
// meaningful if the component is restructured again.
describe('buildNeuralConfig', () => {
  it('cuts the amount of movement when reduced motion is preferred', () => {
    const full = buildNeuralConfig(false);
    const reduced = buildNeuralConfig(true);

    // Fewer things moving at all.
    expect(reduced.nodeCount).toBeLessThan(full.nodeCount);
    expect(reduced.ringLayers).toBeLessThan(full.ringLayers);

    // ...and what remains moves more slowly.
    expect(reduced.orbitSpeed).toBeLessThan(full.orbitSpeed);
    expect(reduced.wobbleAmount).toBeLessThan(full.wobbleAmount);
    expect(reduced.opacitySpeedMax).toBeLessThan(full.opacitySpeedMax);

    // Parallax variance narrows towards uniform.
    const fullSpread = full.orbitSpeedMax - full.orbitSpeedMin;
    const reducedSpread = reduced.orbitSpeedMax - reduced.orbitSpeedMin;
    expect(reducedSpread).toBeLessThan(fullSpread);
  });

  it('leaves the appearance alone - it is a motion preference, not a theme', () => {
    const full = buildNeuralConfig(false);
    const reduced = buildNeuralConfig(true);

    expect(reduced.nodeColor).toBe(full.nodeColor);
    expect(reduced.lineColor).toBe(full.lineColor);
    expect(reduced.lineWidth).toBe(full.lineWidth);
    expect(reduced.innerRingRadius).toBe(full.innerRingRadius);
    expect(reduced.outerRingRadius).toBe(full.outerRingRadius);
  });

  it('returns a fresh object per call, so no caller can mutate the next one', () => {
    const a = buildNeuralConfig(false);
    const b = buildNeuralConfig(false);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  // The defect this fix created, and the one the green matrix could not catch.
  //
  // Making prefers-reduced-motion actually work put the 60-node/2-layer config
  // on screen for the first time. Nodes are spread evenly around each ring
  // layer, so neighbour spacing is inversely proportional to nodes-per-layer -
  // halving that doubles the gap. connectionDistance stayed at 65, which is
  // less than the real spacing at every common viewport (69.5px at 1280x800,
  // 109.7px at 1920x1080), so no lines were drawn between neighbours and a
  // reduce-motion user saw disconnected dots instead of a mesh.
  it('scales the connection distance with the node density, so the mesh still draws', () => {
    const full = buildNeuralConfig(false);
    const reduced = buildNeuralConfig(true);

    const spacingRatio =
      (full.nodeCount / full.ringLayers) / (reduced.nodeCount / reduced.ringLayers);

    // Neighbour spacing grows by exactly this ratio, so the threshold has to
    // grow by at least as much or the lattice silently stops connecting.
    expect(reduced.connectionDistance / full.connectionDistance).toBeGreaterThanOrEqual(
      spacingRatio
    );
  });

  it('keeps the connection threshold above real neighbour spacing at common viewports', () => {
    // Reproduces the placement maths from initNodes rather than trusting a
    // magic number: nodes sit on ring layers between innerRingRadius and
    // outerRingRadius of the smaller viewport dimension.
    const worstCaseSpacing = (config: ReturnType<typeof buildNeuralConfig>, minDim: number) => {
      const innerRadius = minDim * config.innerRingRadius;
      const outerRadius = minDim * config.outerRingRadius;
      const ringWidth = outerRadius - innerRadius;
      const nodesPerLayer = Math.floor(config.nodeCount / config.ringLayers);

      let widest = 0;
      for (let layer = 0; layer < config.ringLayers; layer++) {
        const layerRadius = innerRadius + ringWidth * ((layer + 0.5) / config.ringLayers);
        widest = Math.max(widest, (2 * Math.PI * layerRadius) / nodesPerLayer);
      }
      return widest;
    };

    // min(width, height) for 1280x800, 1440x900, 1920x1080.
    for (const minDim of [800, 900, 1080]) {
      for (const reduced of [false, true]) {
        const config = buildNeuralConfig(reduced);
        expect(worstCaseSpacing(config, minDim)).toBeLessThan(config.connectionDistance);
      }
    }
  });
});
