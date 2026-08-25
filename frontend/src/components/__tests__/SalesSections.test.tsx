import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import SalesSections from '../SalesSections';

/**
 * The below-the-fold landing copy went unedited from 7.1.2 to 7.55.x and drifted
 * into claims the product could not support: invented usage metrics, two
 * unattributed testimonials, a participant-matching engine that has never
 * existed, an "Insight trails" feature, and a Jira/Confluence integration.
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
  it('renders exactly the six sections, and no social proof section', () => {
    const { container } = renderSections();

    const sections = Array.from(container.querySelectorAll('[data-section]')).map((el) =>
      el.getAttribute('data-section')
    );

    // A literal list, so a section added or removed fails here until somebody
    // writes down a verdict for it.
    expect(sections).toEqual([
      'pitch',
      'how-it-works',
      'value-by-role',
      'features',
      'faq',
      'final-cta',
    ]);
    expect(sections).not.toContain('social-proof');
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

  it('tells participants that recorded studies capture screen and voice', () => {
    // The one disclosure on this page that is about the participant rather than
    // about the product. It is why the FAQ grew a fourth entry.
    renderSections();

    const answer = screen.getByText(/capture your screen and your voice/i);
    expect(answer).toBeInTheDocument();
    expect(answer.textContent).toMatch(/consent wording/i);
  });

  it('does not send a signed-out reader to a control that is behind the sign-in', () => {
    // "Submit Research Request" and the account menu both render only for a
    // signed-in user (Header.tsx), and this page is only ever shown signed out
    // (Home.tsx renders <Landing /> when !user). Naming them without saying to
    // sign in first describes a header the reader is not looking at.
    renderSections();

    const answer = screen.getByText(/Submit Research Request/i);
    expect(answer.textContent).toMatch(/sign in first/i);
  });

  it('says Submit Research Request leaves Cortex for the service desk', () => {
    // There is no in-app request form. Header.tsx renders this control as an
    // external anchor to the service desk portal with target="_blank"; the
    // in-app form that implied otherwise was unrouted dead code, deleted in
    // #46. Copy that says only "raises it with the research team" reads as an
    // in-app path, so the destination is asserted rather than the intent.
    renderSections();

    const answer = screen.getByText(/Submit Research Request/i);
    expect(answer.textContent).toMatch(/service desk/i);
    expect(answer.textContent).toMatch(/new tab/i);
  });

  it('says studies can be browsed without signing in', () => {
    renderSections();

    expect(screen.getByText(/browse published studies without signing in/i)).toBeInTheDocument();
  });

  it('runs the access handler from the final CTA', () => {
    const { onAccessCortex } = renderSections();

    fireEvent.click(screen.getByRole('button', { name: /Access Cortex/i }));

    expect(onAccessCortex).toHaveBeenCalledTimes(1);
  });

  it('disables the final CTA while a sign-in is in flight', () => {
    const onAccessCortex = vi.fn();
    renderSections(onAccessCortex, true);

    const cta = screen.getByRole('button', { name: /Access Cortex/i });
    expect(cta).toBeDisabled();

    fireEvent.click(cta);
    expect(onAccessCortex).not.toHaveBeenCalled();
  });

  it('keeps every section heading below the hero h1', () => {
    const { container } = renderSections();

    expect(container.querySelector('h1')).toBeNull();
    // One per section, including the CTA stripe.
    expect(container.querySelectorAll('h2').length).toBe(6);
  });
});
