import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Landing from '../Landing';
import { oidcLogin } from '../../api/client';

/**
 * The first viewport of the signed-out landing page.
 *
 * The page renders only while signed out (Home.tsx), so its whole audience is
 * cold. The hero used to carry two audience "doors" side by side, but signed
 * out both routed to the same sign-in, so the choice had no payoff and the pair
 * read as a terminal "pick one" that discouraged the scroll. The hero now shows
 * a single primary way in; the audience split lives only in the closing doors at
 * the foot of the narrative, after the pitch. These tests pin that shape: the
 * proposition, one CTA, and nothing in the hero that forks or off-ramps the
 * reader before they have read a word.
 *
 * Copy is pinned by LITERAL, not imported from the component, because an
 * expectation derived from the copy moves with it and cannot see it change.
 */

vi.mock('../../api/client', () => ({
  oidcLogin: vi.fn(),
  demoLogin: vi.fn(),
  demoAdminLogin: vi.fn(),
  demoSuperadminLogin: vi.fn(),
}));
// Switchable so a single test can flip to dark; defaults light and is reset in
// beforeEach so every other test keeps the light assumption it was written for.
let mockTheme: 'light' | 'dark' = 'light';
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: mockTheme, isDarkMode: mockTheme === 'dark' }),
}));
// The animated node field is a heavy three.js canvas; stub it with a marker so a
// test can assert it mounts in dark (and only dark) without rendering WebGL.
vi.mock('../../components/OrganicNeuralBackground', () => ({
  default: () => <div data-testid="neural-bg" />,
}));

/** The hero copy in reading order. Literals, so a reworded line fails here. */
const HERO_LINES = [
  'Building new things is hard.',
  'Building the right things is harder.',
  'Cortex is where we find out.',
  'Where we ask the people who’ll use it.',
  'Where you say what you actually think.',
  'Cortex is our collective intelligence',
];

/** The hero stack - lockup, proposition and the single CTA. Scopes every
 *  hero-only assertion so it cannot accidentally read the narrative below. */
const hero = (container: HTMLElement): HTMLElement => {
  const stack = container.querySelector<HTMLElement>('.landing-hero-stack');
  expect(stack).not.toBeNull();
  return stack!;
};

describe('Landing hero', () => {
  beforeEach(() => {
    vi.mocked(oidcLogin).mockClear();
    mockTheme = 'light';
  });

  it('keeps the lockup as the one h1', () => {
    const { container } = render(<Landing />);

    const headings = container.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Cortex');
  });

  it('states the proposition under the lockup, line by line and in order', () => {
    const { container } = render(<Landing />);

    const proposition = container.querySelector('.landing-proposition');
    expect(proposition).not.toBeNull();
    // Each line is its own block, so the reading order is the DOM order.
    const lines = Array.from(proposition!.querySelectorAll('span, .landing-tagline')).map(
      (el) => el.textContent
    );
    expect(lines).toEqual(HERO_LINES);
  });

  it('keeps the tagline as the closing line, not the only line', () => {
    // "Collective Intelligence" on its own told a cold visitor nothing. It
    // stays, but last, under lines that give it a reason - now named so it
    // reads as a statement about Cortex rather than a mood.
    const { container } = render(<Landing />);

    const tagline = container.querySelector('.landing-tagline');
    expect(tagline).toHaveTextContent('Cortex is our collective intelligence');
    expect(tagline?.previousElementSibling).toHaveTextContent('Cortex is where we find out.');
  });

  it('offers a single primary way in, and routes it to the sign-in', () => {
    const { container } = render(<Landing />);

    // Exactly one call-to-action in the hero, and it is the "access" route.
    const ctaBlock = hero(container).querySelector('.landing-cta-single');
    expect(ctaBlock).not.toBeNull();
    const buttons = ctaBlock!.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('data-cta', 'access');
    expect(buttons[0]).toHaveTextContent('Access Cortex');

    fireEvent.click(buttons[0]);
    expect(oidcLogin).toHaveBeenCalledTimes(1);
  });

  it('does not fork or off-ramp the reader in the hero', () => {
    // The two-audience choice had no payoff signed out, the returning-user
    // sign-in link was a third control firing the same action, and the old
    // scroll tab hid content a cold visitor needed. None of them belong in the
    // hero. The audience split now lives only in the closing doors below.
    const { container } = render(<Landing />);
    const heroText = hero(container).textContent ?? '';

    expect(heroText).not.toContain('Run a study');
    expect(heroText).not.toContain('Take part');
    expect(heroText).not.toContain('Already using Cortex');
    expect(heroText).not.toContain('See how it works');
    expect(hero(container).querySelector('.landing-doors')).toBeNull();
    expect(hero(container).querySelector('.landing-signin-link')).toBeNull();
    expect(hero(container).querySelector('.landing-scroll-cue')).toBeNull();
    expect(container.querySelector('.hero-scroll-tab')).toBeNull();
  });

  it('keeps the audience split below the fold, not in the hero', () => {
    // Control for the assertion above: prove the split still exists on the page
    // (the closing doors), so "not in the hero" means moved, not deleted.
    const { container } = render(<Landing />);

    const allCtas = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-cta]'));
    // One hero CTA (access) plus the two closing doors (access, take-part).
    expect(allCtas.map((b) => b.getAttribute('data-cta')).sort()).toEqual([
      'access',
      'access',
      'take-part',
    ]);
    // The take-part door is one of the closing doors, never the hero.
    const takePart = container.querySelector('button[data-cta="take-part"]');
    expect(hero(container).contains(takePart)).toBe(false);
  });

  it('disables the hero CTA once a sign-in is in flight', () => {
    const { container } = render(<Landing />);

    const cta = hero(container).querySelector<HTMLButtonElement>('.landing-cta-single button')!;
    fireEvent.click(cta);

    // The click is answered where it landed.
    expect(cta).toBeDisabled();
    expect(cta).toHaveTextContent('Connecting...');
    // A second click cannot fire a second sign-in.
    fireEvent.click(cta);
    expect(oidcLogin).toHaveBeenCalledTimes(1);
  });
});

/**
 * The dark hero runs the animated node field; the light hero uses the compact
 * static node graphic beside the copy. They are mutually exclusive - the static
 * graphic would double up on the animated one - so pin which appears per theme.
 */
describe('Landing background by theme', () => {
  it('light: static node graphic, no animated field', () => {
    mockTheme = 'light';
    const { container, queryByTestId } = render(<Landing />);
    const img = container.querySelector<HTMLImageElement>('img.landing-node-graphic');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toContain('/images/landing-network-static.svg');
    expect(queryByTestId('neural-bg')).toBeNull();
  });

  it('dark: animated field, no static node graphic', () => {
    mockTheme = 'dark';
    const { container, getByTestId } = render(<Landing />);
    expect(getByTestId('neural-bg')).toBeInTheDocument();
    expect(container.querySelector('img.landing-node-graphic')).toBeNull();
  });
});
