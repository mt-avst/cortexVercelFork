import React from 'react';
import { AlertCircle, CheckCircle, Circle, CircleDot, type LucideIcon } from 'lucide-react';
import type { FormStep } from '../../pages/OpportunityForm';
import {
  STEP_STATUS_LABEL,
  describeStepPosition,
  type StepStatus
} from '../../lib/opportunity-authoring/step-status';

const STATUS_ICON: Record<StepStatus, LucideIcon> = {
  needsAttention: AlertCircle,
  current: CircleDot,
  completed: CheckCircle,
  notStarted: Circle
};

interface StepNavProps {
  steps: FormStep[];
  activeStepId: number;
  statusOf: (step: FormStep) => StepStatus;
  onSelect: (stepId: number) => void;
}

/**
 * The form's step strip - a progress indicator, not a tab bar.
 *
 * These stay plain `<button>`s carrying `aria-current="step"`, and deliberately
 * do NOT take `role="tab"`. Three reasons, in order of weight:
 *
 * 1. It is honest. This is a wizard: the steps have an order, a completion
 *    state and a commit point at the end. `aria-current` is what the rest of
 *    this app already says for exactly that shape - see the journey nav in
 *    `ParticipantSessionFlow`, and `Admin`, `Settings` and `AdminManagement`
 *    for the real tab surfaces, which are a different thing.
 * 2. The tab role brings a roving tabindex with it, where one Tab press enters
 *    the strip and the arrow keys move within it. That is right for tabs and
 *    wrong here: it makes the strip a single stop, which is worse for an
 *    author walking a four-step form than one stop per step.
 * 3. `role="tab"` REPLACES the button role, and around a hundred test call
 *    sites and five Playwright specs address these by their button role or by
 *    `.nav-link`. Changing both the semantics and every caller in one step
 *    would mean the callers could no longer disagree with the change.
 *
 * D7 (Aicher-style step strip): the three-line stacked strip - position,
 * title, description, then state - ragged its top edge by up to 32px and
 * jumped 16px in total height between an odd and an even step (both from
 * `_components.css`, see the comments there). The fix drops the description
 * and swaps the "Step X of Y" position line for a plain numeral, so every
 * button holds exactly one line of title and one line of state on a single
 * fixed-height row.
 *
 * The accessible name still carries the position sentence past the visible
 * text - "Step 3 of 4 Task List Needs attention" - even though a sighted
 * author now sees a numeral where that sentence used to be visible:
 * `describeStepPosition` is still rendered, in a `.sr-only` span, so a screen
 * reader hears the same position it always did. The step DESCRIPTION ("What
 * the participant does" and so on) is not part of that any more - D7 drops
 * it from the DOM entirely, for every step, not just visually - so it is no
 * longer part of the accessible name either. Nothing here renders another
 * step's title, which is what would break the negative assertions.
 */
const StepNav: React.FC<StepNavProps> = ({ steps, activeStepId, statusOf, onSelect }) => (
  <nav className="nav nav-tabs border-0 nav-tabs-form" aria-label="Form steps">
    {steps.map((step, index) => {
      const status = statusOf(step);
      const isActive = step.id === activeStepId;
      const StatusIcon = STATUS_ICON[status];

      return (
        <button
          key={step.id}
          type="button"
          className={`nav-link border-0 px-4 opportunity-form-tab step-tab ${
            isActive ? 'active fw-bold' : 'fw-semibold'
          }`}
          /* `step`, not `page`: the strip moves within one page. */
          aria-current={isActive ? 'step' : undefined}
          onClick={() => onSelect(step.id)}
        >
          <div className="step-tab__content">
            {/* Decorative stand-in for the position sentence below: a sighted
                author reads the number, a screen reader reads the sentence. */}
            <span className="step-tab__index" aria-hidden="true">
              {index + 1}
            </span>
            <div className="step-tab__body">
              <span className="step-tab__position sr-only">
                {describeStepPosition(index, steps.length)}
              </span>
              <div className={`tab-title tab-title-dynamic step-tab__title ${isActive ? 'active' : ''}`}>
                {step.title}
              </div>
              {/*
                The icon is decorative and the words are not. A screen reader
                reads the label as part of the button's name; a sighted author
                gets the shape as well as the colour, which is the whole reason
                there is an icon at all.
              */}
              <span
                className={`step-tab__status step-tab__status--${status}${
                  /* The same token B2 gave the question cards, so a failing step
                     and a failing question inside it are one colour with one
                     definition rather than two that drift. */
                  status === 'needsAttention' ? ' validation-error' : ''
                }`}
              >
                <StatusIcon size={13} className="me-1" aria-hidden="true" />
                {STEP_STATUS_LABEL[status]}
              </span>
            </div>
          </div>
        </button>
      );
    })}
  </nav>
);

export default StepNav;
