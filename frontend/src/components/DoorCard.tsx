import React from 'react';

/**
 * The two entry doors, one per reader: a kicker naming the reader, a title
 * and a button. The hero shows the opening pair inside the first viewport, so
 * a cold visitor sees which door is theirs without scrolling; the proposition
 * above them does the explaining, so the doors carry no body copy. The closing
 * pair at the foot of the narrative is a short reprise. Signed out, both
 * routes lead to the same sign-in, so the labels carry the two-audience
 * framing and nothing else.
 */

export type DoorId = 'access' | 'take-part';

export interface Door {
  who: string;
  title: string;
  cta: string;
  /** Stable hook for tests and analytics, independent of the button's copy. */
  ctaId: DoorId;
}

export const OPENING_DOORS: ReadonlyArray<Door> = [
  {
    who: 'The people building it',
    title: 'Stop guessing what people need',
    cta: 'Run a study',
    ctaId: 'access',
  },
  {
    who: 'The people who’ll tell the truth about it',
    title: 'Shape what you’ll be using next year',
    cta: 'Take part',
    ctaId: 'take-part',
  },
];

export const CLOSING_DOORS: ReadonlyArray<Door> = [
  {
    who: 'The people building it',
    title: 'Write the question. Cortex does the rest',
    cta: 'Run a study',
    ctaId: 'access',
  },
  {
    who: 'The people who’ll tell the truth about it',
    title: 'See what’s open this week and book a slot',
    cta: 'Take part',
    ctaId: 'take-part',
  },
];

export interface DoorCardProps {
  door: Door;
  onAccessCortex: () => void;
  isLoading: boolean;
}

export const DoorCard: React.FC<DoorCardProps> = ({ door, onAccessCortex, isLoading }) => (
  <div className="sales-door">
    <span className="sales-door-who">{door.who}</span>
    <h3 className="sales-card-title">{door.title}</h3>
    <button
      className={`btn-power ${isLoading ? 'disabled' : ''}`}
      onClick={onAccessCortex}
      disabled={isLoading}
      aria-busy={isLoading}
      data-cta={door.ctaId}
    >
      {isLoading ? (
        // The doors are the main way in, so the click is answered where it landed.
        <span className="d-flex align-items-center gap-2">
          <span className="spinner-border spinner-border-sm" aria-hidden="true" />
          Connecting...
        </span>
      ) : (
        <>
          {door.cta}
          <span className="btn-arrow" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M5 12H19M19 12L12 5M19 12L12 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </>
      )}
    </button>
  </div>
);
