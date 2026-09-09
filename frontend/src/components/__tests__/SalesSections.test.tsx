import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import SalesSections from '../SalesSections';

/**
 * The below-the-fold landing copy went unedited from 7.1.2 to 7.55.x and drifted
 * into claims the product could not support: invented usage metrics, two
 * unattributed testimonials, a participant-matching engine that has never
 * existed, an "Insight trails" feature, and a Jira/Confluence integration. It
 * has since been replaced with Dr Nick Fine's v11 narrative.
 *
 * These tests are the guard on that. The banned phrases are written as LITERALS
 * rather than derived from the component's data arrays, because an expectation
 * derived from the copy cannot see the copy change - it would simply move with
 * it and stay green.
 */

/** Every phrase that was on this page and was not true. Literals, deliberately. */
const BANNED_CLAIMS = [
  '200+',
  '1,000+',
  '3×',
  'completed studies',
  'contributors across teams',
  'Proven inside Adaptavist',
  'matches your requests',
  'Cortex finds the people',
  'matches your request to available participants',
  'Insight trails',
  'Jira',
  'Confluence',
  'prize draw',
  'days, not weeks',
];

/** Returns the banned phrases present in `text`. Case-insensitive. */
const bannedClaimsIn = (text: string): string[] =>
  BANNED_CLAIMS.filter((claim) => text.toLowerCase().includes(claim.toLowerCase()));

const renderSections = (onAccessCortex = vi.fn(), isLoading = false) => {
  const view = render(<SalesSections onAccessCortex={onAccessCortex} isLoading={isLoading} />);
  return { ...view, onAccessCortex };
};

describe('SalesSections', () => {
  it('renders exactly the six narrative sections, and no social proof section', () => {
    const { container } = renderSections();

    const sections = Array.from(container.querySelectorAll('[data-section]')).map((el) =>
      el.getAttribute('data-section')
    );

    // A literal list, so a section added or removed fails here until somebody
    // writes down a verdict for it. The opening doors and the proposition
    // moved into the hero (Landing.tsx), so there is no intro section here.
    expect(sections).toEqual([
      'loop',
      'audiences',
      'methods',
      'promises',
      'voice',
      'final-cta',
    ]);
    expect(sections).not.toContain('social-proof');
  });

  it('labels the loop section with the "See how it works" eyebrow', () => {
    // The counterpart to Landing.test.tsx's "not in the hero" assertion: the
    // label was moved here, not deleted. Deleting the eyebrow must fail a test.
    const { container } = renderSections();

    const loop = container.querySelector('[data-section="loop"]');
    expect(loop).not.toBeNull();
    const kicker = loop!.querySelector('.sales-loop-kicker');
    expect(kicker).not.toBeNull();
    expect(kicker).toHaveTextContent('See how it works');
  });

  it('makes no claim the product cannot support', () => {
    const { container } = renderSections();

    expect(bannedClaimsIn(container.textContent ?? '')).toEqual([]);
  });

  it('CONTROL: the banned-claim detector still finds every claim it watches for', () => {
    // Without this arm, the assertion above passes just as well when the
    // detector is broken as when the copy is clean. Each phrase is fed back in
    // to prove the check can still fail.
    const everyClaim = BANNED_CLAIMS.join(' | ');

    expect(bannedClaimsIn(everyClaim)).toEqual(BANNED_CLAIMS);
    expect(bannedClaimsIn('Proven INSIDE adaptavist')).toEqual(['Proven inside Adaptavist']);
    expect(bannedClaimsIn('nothing objectionable here')).toEqual([]);
  });

  it('discloses that recorded studies capture screen and voice', () => {
    // The one disclosure on this page that is about the participant rather than
    // the product: a recorded study captures screen and voice. It appears both
    // in the methods table and in the recorded-study explainer.
    const { container } = renderSections();

    expect(container.textContent?.toLowerCase()).toContain('screen and voice captured');
    expect(container.textContent?.toLowerCase()).toContain('screen and voice playback');
  });

  it('closes the loop: participants are told they hear what happened', () => {
    // The promise that makes the loop worth running twice. It is the reason the
    // narrative exists, so it is pinned rather than left to drift.
    renderSections();

    expect(screen.getByText(/You hear what happened/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Results are shared back to everyone who took part/i)
    ).toBeInTheDocument();
  });

  it('runs the access handler from every door', () => {
    const { onAccessCortex } = renderSections();

    // The two closing doors. The opening pair lives in the hero, see Landing.test.tsx.
    const doorButtons = screen.getAllByRole('button', { name: /Run a study|Take part/i });
    expect(doorButtons).toHaveLength(2);

    fireEvent.click(doorButtons[0]);
    expect(onAccessCortex).toHaveBeenCalledTimes(1);
  });

  it('disables every door while a sign-in is in flight', () => {
    const onAccessCortex = vi.fn();
    renderSections(onAccessCortex, true);

    // In flight, both doors say so instead of their label.
    const doorButtons = screen.getAllByRole('button', { name: /Connecting/i });
    expect(doorButtons).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Run a study|Take part/i })).toBeNull();
    doorButtons.forEach((button) => {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    });
    expect(onAccessCortex).not.toHaveBeenCalled();
  });

  it('keeps every section heading below the hero h1', () => {
    const { container } = renderSections();

    expect(container.querySelector('h1')).toBeNull();
    // loop, methods, promises and final-cta carry one h2 each; the audiences
    // section carries two (one per reader); voice carries none.
    // A literal count, so a heading gained or lost fails here.
    expect(container.querySelectorAll('h2').length).toBe(6);
  });
});
