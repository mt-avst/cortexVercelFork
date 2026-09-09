import React from 'react';

/**
 * The two entry doors, one per reader: a kicker naming the reader, a title
 * and a button. They live only at the foot of the narrative now - the hero
 * offers a single way in, because signed out both doors route to the same
 * sign-in and the choice had no payoff before the pitch. Here, after the
 * pitch, the two-audience framing is the point: the reader picks the door that
 * is theirs. Signed out both still lead to the same sign-in, so the labels
 * carry the framing and nothing else.
 */

export type DoorId = 'access' | 'take-part';

export interface Door {
  who: string;
  title: string;
  cta: string;
  /** Stable hook for tests and analytics, independent of the button's copy. */
  ctaId: DoorId;
}

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
