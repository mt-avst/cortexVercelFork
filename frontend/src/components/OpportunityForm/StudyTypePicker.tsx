import React, { useState } from 'react';
import { QUESTION_CARRYING_TYPES } from '@shared/firsthand/delivery';
import FieldError from './FieldError';
import DescribeIt from './DescribeIt';
import type { DraftedOpportunity } from '../../api/client';

type DeliveryMode = 'native' | 'external';

interface StudyTypePickerProps {
  /** The chosen study type, or '' before a choice is made. */
  type: string;
  /** The chosen delivery mode (only meaningful for the answer-based types). */
  deliveryMode: DeliveryMode;
  /** Set the type and delivery mode together from one pod or the toggle. */
  onSelect: (type: string, deliveryMode: DeliveryMode) => void;
  /**
   * Row 7: a published study locks its type. The picker shows a read-only
   * summary behind an explicit "Change study type" control that names what
   * detaches; a draft picks freely.
   */
  isPublished: boolean;
  /** The `type` validation error, shown against the group. */
  validationError?: string;
  /**
   * D13: wires the live "Describe it" panel. Absent means the panel does not
   * render at all - the new-study route passes it, the edit route (and any
   * caller not ready for it) does not, which is what keeps the panel new-only
   * per the spec without a second flag.
   */
  onApplyDraft?: (draft: DraftedOpportunity) => void;
}

/**
 * The delivery copy is verbatim from the live UI (the "Where participants
 * answer" radios), so the two deliveries read exactly as they always have. The
 * D2 card fold put them inside each answer-based card; this reshape lifts them
 * back out into one toggle shown after an answer-based type is picked.
 */
const NATIVE_COPY =
  'You write the questions here and the answers come back in Cortex. Nothing is recorded - no screen, no microphone, no camera.';
const EXTERNAL_COPY =
  'You give Cortex the link. SurveyMonkey, Google Forms, Typeform and the rest - Cortex sends people there and counts the clicks, and the answers live in that tool.';

interface Pod {
  /** Existing `type` enum value - never a new or renamed one. */
  type: string;
  title: string;
  /** The type gloss, the same words the old cards carried after the title. */
  typeDesc: string;
}

interface Group {
  label: string;
  /** The scheduling fact shared by every pod in the group. */
  sub: string;
  pods: Pod[];
}

/**
 * Six pods, one per `type`, grouped by the scheduling fact an admin sorts on:
 * live studies need booked time, async studies run in the participant's own
 * time. Delivery (`native`/`external`) is NOT a pod any more - it is the toggle
 * below, shown only for the answer-based types that carry the choice.
 */
const GROUPS: Group[] = [
  {
    label: 'Live studies',
    sub: 'You specify calendar slots, participants self book',
    pods: [
      { type: 'interview', title: 'Interview', typeDesc: 'Research interview session' },
      { type: 'test', title: 'Live session', typeDesc: 'Usability test you moderate' }
    ]
  },
  {
    label: 'Async studies',
    sub: 'The participant runs it in their own time',
    pods: [
      {
        type: 'unmoderated',
        title: 'Recorded session',
        typeDesc: 'Remote unmoderated user test, recorded in the browser'
      },
      { type: 'poll', title: 'Quick poll', typeDesc: 'Quick opinion gathering' },
      { type: 'question', title: 'One question', typeDesc: 'Single question session' },
      { type: 'survey', title: 'Survey', typeDesc: 'Detailed feedback collection' }
    ]
  }
];

const ALL_PODS: Pod[] = GROUPS.flatMap((group) => group.pods);

/** The chosen pod, or null before a choice is made. */
const selectedPod = (type: string): Pod | null =>
  ALL_PODS.find((pod) => pod.type === type) ?? null;

/**
 * The delivery a pod commits when picked: answer-based types keep whatever
 * delivery is already set (so switching poll -> survey does not silently reset
 * it) and fall back to the system default; interactive types carry no delivery
 * choice, so they hold the default and never read it.
 */
const deliveryForPod = (podType: string, current: DeliveryMode): DeliveryMode =>
  QUESTION_CARRYING_TYPES.has(podType) ? current : 'external';

/**
 * The study-type picker: six pods (one per `type`) under two scheduling
 * eyebrows, plus a delivery toggle for the answer-based types - replacing the
 * nine-card D2 picker. Selecting a pod or the toggle commits the existing
 * `type` and `delivery_mode` values (no enum is invented or renamed), so
 * `getTabsForType` keeps deciding the step set off the chosen pair.
 */
const StudyTypePicker: React.FC<StudyTypePickerProps> = ({
  type,
  deliveryMode,
  onSelect,
  isPublished,
  validationError,
  onApplyDraft
}) => {
  // Row 7: a published study is locked until the author explicitly asks to
  // change the type, which names what that detaches.
  const [unlocked, setUnlocked] = useState(false);
  const locked = isPublished && !unlocked;
  const current = selectedPod(type);
  const isAnswerBased = current !== null && QUESTION_CARRYING_TYPES.has(type);

  if (locked) {
    const deliveryLabel = isAnswerBased
      ? deliveryMode === 'native'
        ? 'In Cortex'
        : 'In an external tool'
      : '';
    return (
      <div className="form-section mb-4">
        <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>
          Study type
        </h2>
        <p className="mb-3 section-description" style={{ fontSize: '0.95rem' }}>
          {current
            ? `${current.title}${deliveryLabel ? ` - ${deliveryLabel}` : ''}`
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
        Pick the study you're running. Live studies are scheduled - you set
        calendar slots and participants self book. Async studies run in the
        participant's own time.
      </p>

      {isPublished && unlocked && (
        <div className="alert alert-warning" role="alert" style={{ fontSize: '0.9rem' }}>
          Changing the type detaches the questions, tasks and sessions already
          authored for this published study.
        </div>
      )}

      {onApplyDraft && (
        <DescribeIt hints={{ type: type || undefined, delivery_mode: deliveryMode }} onApply={onApplyDraft} />
      )}

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
              className="form-label mb-1"
              style={{ fontSize: '0.875rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.03em' }}
            >
              {group.label}
            </h3>
            <p className="form-text mb-2" style={{ fontSize: '0.8rem' }}>
              {group.sub}
            </p>
            <div className="row g-2">
              {group.pods.map((pod) => {
                const selected = pod.type === type;
                return (
                  <div className="col-md-4" key={pod.type}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={pod.title}
                      className={`study-type-card w-100 text-start h-100 p-3 ${selected ? 'is-selected' : ''}`}
                      onClick={() => onSelect(pod.type, deliveryForPod(pod.type, deliveryMode))}
                    >
                      <span className="d-block" style={{ fontSize: '1rem', fontWeight: '600' }}>
                        {pod.title}
                      </span>
                      <span className="d-block form-text" style={{ fontSize: '0.8rem' }}>
                        {pod.typeDesc}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {validationError && <FieldError id="type-error">{validationError}</FieldError>}

      {isAnswerBased && (
        <div className="mt-4">
          <h3
            className="form-label mb-1"
            style={{ fontSize: '0.95rem', fontWeight: '600' }}
          >
            Where do participants answer
          </h3>
          <p className="form-text mb-2" style={{ fontSize: '0.8rem' }}>
            Polls, single questions and surveys only
          </p>
          <div role="radiogroup" aria-label="Where participants answer" className="row g-2">
            {(
              [
                { delivery: 'native' as DeliveryMode, label: 'In Cortex', desc: NATIVE_COPY },
                { delivery: 'external' as DeliveryMode, label: 'In an external tool', desc: EXTERNAL_COPY }
              ]
            ).map((option) => {
              const selected = deliveryMode === option.delivery;
              return (
                <div className="col-md-6" key={option.delivery}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={option.label}
                    className={`study-type-card w-100 text-start h-100 p-3 ${selected ? 'is-selected' : ''}`}
                    onClick={() => onSelect(type, option.delivery)}
                  >
                    <span className="d-block" style={{ fontSize: '0.95rem', fontWeight: '600' }}>
                      {option.label}
                    </span>
                    <span className="d-block form-text" style={{ fontSize: '0.8rem' }}>
                      {option.desc}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default StudyTypePicker;
