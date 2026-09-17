import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { QUESTION_CARRYING_TYPES } from '@shared/firsthand/delivery';
import FieldError from './FieldError';

type DeliveryMode = 'native' | 'external';

interface StudyTypePickerProps {
  /** The chosen study type, or '' before a choice is made. */
  type: string;
  /** The chosen delivery mode (only meaningful for the answer-based types). */
  deliveryMode: DeliveryMode;
  /** Set the type and delivery mode together from one card. */
  onSelect: (type: string, deliveryMode: DeliveryMode) => void;
  /**
   * Row 7: a published study locks its type. The picker shows a read-only
   * summary behind an explicit "Change study type" control that names what
   * detaches; a draft picks freely.
   */
  isPublished: boolean;
  /** The `type` validation error, shown against the group. */
  validationError?: string;
}

/**
 * The delivery copy is verbatim from the live UI (the "Where participants
 * answer" radios it replaces), so the two deliveries read exactly as they did
 * before D2 folded them into the card.
 */
const NATIVE_COPY =
  'You write the questions here and the answers come back in Cortex. Nothing is recorded - no screen, no microphone, no camera.';
const EXTERNAL_COPY =
  'You give Cortex the link. SurveyMonkey, Google Forms, Typeform and the rest - Cortex sends people there and counts the clicks, and the answers live in that tool.';

interface Card {
  /** Existing `type` enum value - never a new or renamed one. */
  type: string;
  /** Existing `delivery_mode` enum value the card commits. */
  delivery: DeliveryMode;
  title: string;
  /** The "In Cortex" / "In an external tool" line, on the answer-based cards. */
  deliveryLabel?: string;
  /** The type gloss, the same words the old select carried after the dash. */
  typeDesc: string;
  /** The delivery copy, on the answer-based cards. */
  deliveryDesc?: string;
  /** A concise, unique accessible name for the card's radio. */
  ariaLabel: string;
}

interface Group {
  label: string;
  cards: Card[];
}

const answerCards = (
  type: string,
  title: string,
  typeDesc: string
): [Card, Card] => [
  {
    type,
    delivery: 'native',
    title,
    deliveryLabel: 'In Cortex',
    typeDesc,
    deliveryDesc: NATIVE_COPY,
    ariaLabel: `${title}, in Cortex`
  },
  {
    type,
    delivery: 'external',
    title,
    deliveryLabel: 'In an external tool',
    typeDesc,
    deliveryDesc: EXTERNAL_COPY,
    ariaLabel: `${title}, in an external tool`
  }
];

const GROUPS: Group[] = [
  {
    label: 'Interactive sessions - you meet or record the participant',
    cards: [
      {
        type: 'interview',
        delivery: 'external',
        title: 'Interview',
        typeDesc: 'Research interview session',
        ariaLabel: 'Interview'
      },
      {
        type: 'test',
        delivery: 'external',
        title: 'Live session',
        typeDesc: 'Usability test you moderate, at a booked time',
        ariaLabel: 'Live session'
      },
      {
        type: 'unmoderated',
        delivery: 'external',
        title: 'Recorded session',
        typeDesc:
          'Usability test the participant runs alone, recorded in the browser',
        ariaLabel: 'Recorded session'
      }
    ]
  },
  {
    label: 'Answer-based - poll, one question or survey, in Cortex or an external tool',
    cards: [
      ...answerCards('poll', 'Quick poll', 'Quick opinion gathering'),
      ...answerCards('question', 'One question', 'Single question session'),
      ...answerCards('survey', 'Survey', 'Detailed feedback collection')
    ]
  }
];

/** Every card, flat, for looking one up by the chosen type and delivery. */
const ALL_CARDS: Card[] = GROUPS.flatMap((group) => group.cards);

/**
 * Whether a card is the current choice. The answer-based types match on both
 * type and delivery (they are two cards); the interactive types have one card
 * each, so type alone decides - delivery is not a choice they carry.
 */
const cardIsSelected = (
  card: Card,
  type: string,
  deliveryMode: DeliveryMode
): boolean => {
  if (card.type !== type) return false;
  if (QUESTION_CARRYING_TYPES.has(card.type)) {
    return card.delivery === deliveryMode;
  }
  return true;
};

/** The chosen card, or null before a choice is made. */
const selectedCard = (type: string, deliveryMode: DeliveryMode): Card | null =>
  ALL_CARDS.find((card) => cardIsSelected(card, type, deliveryMode)) ?? null;

/**
 * The study-type picker (D2): one choice of nine cards, definitions in view,
 * replacing the old "Research Study Type" select and the separate "Where
 * participants answer" delivery radios. Selecting a card commits the existing
 * `type` and `delivery_mode` values - no enum is invented or renamed - so
 * `getTabsForType` keeps deciding the step set off the chosen pair.
 */
const StudyTypePicker: React.FC<StudyTypePickerProps> = ({
  type,
  deliveryMode,
  onSelect,
  isPublished,
  validationError
}) => {
  // Row 7: a published study is locked until the author explicitly asks to
  // change the type, which names what that detaches.
  const [unlocked, setUnlocked] = useState(false);
  const locked = isPublished && !unlocked;
  const current = selectedCard(type, deliveryMode);

  if (locked) {
    return (
      <div className="form-section mb-4">
        <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>
          Study type
        </h2>
        <p className="mb-3 section-description" style={{ fontSize: '0.95rem' }}>
          {current
            ? `${current.title}${current.deliveryLabel ? ` - ${current.deliveryLabel}` : ''}`
            : 'Not set'}
        </p>
        <p className="form-text mb-2" style={{ fontSize: '0.875rem' }}>
          This study is published, so its type is fixed. Changing it detaches the
          questions, tasks and sessions you have already authored, and rebuilds
          the study's steps.
        </p>
        <button
          type="button"
          className="btn btn-outline-primary"
          onClick={() => setUnlocked(true)}
        >
          Change study type
        </button>
      </div>
    );
  }

  return (
    <div className="form-section mb-4">
      <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>
        Start a study
      </h2>
      <p className="mb-3 section-description" style={{ fontSize: '0.95rem' }}>
        Pick the one shape that fits what you are running. Each carries its own
        definition, and where the participant answers.
      </p>

      {isPublished && unlocked && (
        <div className="alert alert-warning" role="alert" style={{ fontSize: '0.9rem' }}>
          Changing the type detaches the questions, tasks and sessions already
          authored for this published study.
        </div>
      )}

      <FrontDoorPrompt />

      <div
        role="radiogroup"
        id="type"
        tabIndex={-1}
        aria-label="Study type"
        aria-invalid={validationError ? 'true' : 'false'}
        aria-describedby={validationError ? 'type-error' : undefined}
      >
        {GROUPS.map((group) => (
          <div key={group.label} className="mb-3">
            <h3
              className="form-label mb-2"
              style={{ fontSize: '0.875rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.03em' }}
            >
              {group.label}
            </h3>
            <div className="row g-2">
              {group.cards.map((card) => {
                const selected = cardIsSelected(card, type, deliveryMode);
                return (
                  <div className="col-md-4" key={card.ariaLabel}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={card.ariaLabel}
                      className={`study-type-card w-100 text-start h-100 p-3 ${selected ? 'is-selected' : ''}`}
                      onClick={() => onSelect(card.type, card.delivery)}
                    >
                      <span className="d-block" style={{ fontSize: '1rem', fontWeight: '600' }}>
                        {card.title}
                      </span>
                      {card.deliveryLabel && (
                        <span className="d-block" style={{ fontSize: '0.85rem', fontWeight: '600' }}>
                          {card.deliveryLabel}
                        </span>
                      )}
                      <span className="d-block form-text" style={{ fontSize: '0.8rem' }}>
                        {card.typeDesc}
                      </span>
                      {card.deliveryDesc && (
                        <span className="d-block form-text mt-1" style={{ fontSize: '0.8rem' }}>
                          {card.deliveryDesc}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {validationError && <FieldError id="type-error">{validationError}</FieldError>}
    </div>
  );
};

/**
 * D13 front-door AI shell, dormant. The agreed "What do you want to find out?"
 * prompt sits above the cards; W9 wires the real drafting. Nothing here saves
 * anything or calls a backend - the control is inert until then.
 */
const FrontDoorPrompt: React.FC = () => (
  <div className="form-section mb-3 p-3" data-testid="front-door-ai-prompt" style={{ border: '1px solid var(--fs-border, #d0d0d0)', borderRadius: '4px' }}>
    <label htmlFor="ai_study_prompt" className="form-label mb-1 d-flex align-items-center gap-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
      <Sparkles size={16} aria-hidden="true" />
      What do you want to find out?
    </label>
    <textarea
      id="ai_study_prompt"
      className="form-control"
      rows={2}
      style={{ fontSize: '0.95rem' }}
      placeholder="e.g. Do first-time admins understand the new board view well enough to set one up without help?"
    />
    <div className="mt-2">
      <button type="button" className="btn btn-outline-secondary btn-sm" disabled>
        Suggest a type
      </button>
    </div>
    <p className="form-text mt-2 mb-0" style={{ fontSize: '0.8rem' }}>
      Nothing here is saved, and typing creates no draft. When AI drafting lands
      it will suggest a type below - you still choose.
    </p>
  </div>
);

export default StudyTypePicker;
