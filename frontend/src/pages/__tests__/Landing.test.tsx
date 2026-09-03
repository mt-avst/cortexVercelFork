import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import Landing from '../Landing';
import { oidcLogin } from '../../api/client';

/**
 * The first viewport of the signed-out landing page.
 *
 * The page renders only while signed out (Home.tsx), so its whole audience is
 * cold. For a long time the hero showed a lockup, the mood line "Collective
 * Intelligence" and a sign-in button, with everything a cold visitor needed
 * behind a nine-point "See how it works" tab. These tests pin the shape that
 * replaced it: a proposition that says what Cortex is, and the two doors, one
 * per reader, inside the hero and ahead of the narrative.
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
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', isDarkMode: false }),
}));
vi.mock('../../components/OrganicNeuralBackground', () => ({ default: () => null }));

/** The hero copy in reading order. Literals, so a reworded line fails here. */
const HERO_LINES = [
  'Building new things is hard.',
  'Building the right things is harder.',
  'Cortex is where we find out.',
  'Where we ask the people who’ll use it.',
  'Where you say what you actually think.',
  'Our collective intelligence',
];

/** Both hero doors, by their stable id. A literal pair, so a door lost fails here. */
const OPENING_DOOR_IDS = ['access', 'take-part'] as const;

/** The hero's door buttons: the ones that come before the narrative's first section. */
const heroDoors = (container: HTMLElement): HTMLButtonElement[] => {
  const firstNarrativeSection = container.querySelector('[data-section]');
  expect(firstNarrativeSection).not.toBeNull();
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-cta]')).filter(
    (button) =>
      (button.compareDocumentPosition(firstNarrativeSection as Element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
};

describe('Landing hero', () => {
  beforeEach(() => {
    vi.mocked(oidcLogin).mockClear();
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
    // stays, but last, under lines that give it a reason.
    const { container } = render(<Landing />);

    const tagline = container.querySelector('.landing-tagline');
    expect(tagline).toHaveTextContent('Our collective intelligence');
    expect(tagline?.previousElementSibling).toHaveTextContent('Cortex is where we find out.');
  });

  it('does not bring back the scroll tab', () => {
    // The tab hid the only content a cold visitor needed. It does not come
    // back quietly.
    const { container } = render(<Landing />);
    const text = container.textContent ?? '';

    expect(text).not.toContain('See how it works');
    expect(text).not.toContain('New to Cortex?');
    expect(container.querySelector('.hero-scroll-tab')).toBeNull();
  });

  it('CONTROL: the hero-door finder can tell a hero door from a closing door', () => {
    const { container } = render(<Landing />);

    const allDoors = container.querySelectorAll('button[data-cta]');
    // Two in the hero, two in the closing section.
    expect(allDoors).toHaveLength(4);
    expect(heroDoors(container)).toHaveLength(2);
  });

  it('puts both doors in the hero, one per reader, ahead of the narrative', () => {
    const { container } = render(<Landing />);

    const doors = heroDoors(container);
    expect(doors.map((door) => door.textContent?.trim())).toEqual(['Run a study', 'Take part']);

    // Each door names its reader, so a visitor can pick without reading the body.
    const hero = container.querySelector('.landing-doors');
    expect(hero?.textContent).toContain('The people building it');
    expect(hero?.textContent).toContain('The people who’ll tell the truth about it');
    // The proposition does the explaining, so the doors carry no body copy.
    expect(hero?.querySelector('.sales-card-text')).toBeNull();
  });

  it('routes every hero door to the sign-in', () => {
    // Each door, in turn. A fresh render per door, because the first click
    // puts the sign-in in flight and disables the rest.
    OPENING_DOOR_IDS.forEach((ctaId) => {
      const { container, unmount } = render(<Landing />);
      const door = container.querySelector<HTMLButtonElement>(`.landing-doors button[data-cta="${ctaId}"]`);
      expect(door).not.toBeNull();

      fireEvent.click(door!);
      expect(oidcLogin).toHaveBeenCalledTimes(1);

      vi.mocked(oidcLogin).mockClear();
      unmount();
    });
  });

  it('offers a quiet sign-in for the returning visitor', () => {
    render(<Landing />);

    fireEvent.click(screen.getByRole('button', { name: /Already using Cortex\? Sign in/i }));
    expect(oidcLogin).toHaveBeenCalledTimes(1);
  });

  it('disables every route in once a sign-in is in flight', () => {
    const { container } = render(<Landing />);

    fireEvent.click(screen.getByRole('button', { name: /Already using Cortex\? Sign in/i }));

    const doors = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-cta]'));
    expect(doors).toHaveLength(4);
    doors.forEach((door) => {
      expect(door).toBeDisabled();
      // The click is answered where it landed: every route in says so.
      expect(door).toHaveTextContent('Connecting...');
      fireEvent.click(door);
    });
    // Four doors and the sign-in link.
    expect(screen.getAllByRole('button', { name: /Connecting/i })).toHaveLength(5);
    expect(oidcLogin).toHaveBeenCalledTimes(1);
  });
});
