import React from 'react';
import { AlertCircle, AlertTriangle } from 'lucide-react';

import type { ReviewSection } from '../../lib/opportunity-authoring/review-summary';

export interface ReviewStepProps {
  sections: ReviewSection[];
  /** The publish refusal this opportunity would get, or null. */
  publishRefusal: { message: string; stepId: number; stepTitle: string } | null;
  /** Open a step, focusing a control when one is named. */
  onEdit: (stepId: number, focusFieldId?: string) => void;
  /**
   * Whether this is an edit of something that already exists.
   *
   * The only thing this component is told about the opportunity, and it earns
   * its place: the standing copy said "before the opportunity is created.
   * Nothing has been saved yet", and in edit mode BOTH sentences are false -
   * the opportunity exists, and every earlier step keeps a Save Changes
   * shortcut, so changes may already have been saved this session.
   */
  isEdit: boolean;
}

/**
 * The check-answers screen, and nothing that decides what is on it.
 *
 * Every fact this component shows - which sections exist, what each item
 * says, whether a value counts as missing - is decided in
 * `review-summary.ts` by walking the step list the form is actually
 * rendering. That split exists because this form's worst class of bug has
 * been two places agreeing about a shape by accident: a component that
 * re-derives "is this a survey" from `type` alongside a builder that derives
 * it from the step list is a component that can start disagreeing with its
 * own data the next time a type is added or a step is reordered, and nothing
 * would say so until an author saw the wrong section. So this file takes
 * `sections` as already-decided content and renders it; it does not import
 * `type`, `deliveryMode`, or any authoring types, and it must never grow a
 * conditional that reads one.
 */
const ReviewStep: React.FC<ReviewStepProps> = ({ sections, publishRefusal, onEdit, isEdit }) => (
  <div className="form-section mb-5" data-testid="review-step">
    <div className="mb-4">
      <h2 className="h4 mb-1 section-title">Review</h2>
      <p className="mb-0 section-description">
        {isEdit
          ? 'Check everything before you save. Any change you have not already saved is still only on this screen.'
          : 'Your last chance to check everything before the opportunity is created. Nothing has been saved yet.'}
      </p>
    </div>

    {publishRefusal && (
      <div className="alert alert-warning" role="alert">
        <AlertTriangle size={16} className="me-2" aria-hidden="true" />
        {publishRefusal.message}{' '}
        {/*
          Never disabled. The server is the authority on whether this
          opportunity may be published, and a disabled button that turns out
          to be wrong - because this preview drifted from the server's own
          rule, or because the author fixes the problem some other way first -
          is a control the author cannot recover from without leaving the
          page. A clickable link to the offending step costs nothing when the
          preview is right and loses nothing when it is not: the save itself
          still enforces the rule either way.
        */}
        <button
          type="button"
          className="btn btn-link p-0 align-baseline"
          onClick={() => onEdit(publishRefusal.stepId)}
        >
          Go to {publishRefusal.stepTitle}
        </button>
      </div>
    )}

    {sections.map((section) => (
      <div key={section.stepKey} className="border rounded p-3 mb-3">
        <div className="d-flex justify-content-between align-items-start mb-2">
          <h3 className="h6 mb-0">{section.title}</h3>
          {/*
            The accessible name is "Edit {title}", not a bare "Edit" -
            `getByRole` matches an accessible name as a SUBSTRING by default,
            so a screen with several bare "Edit" buttons is a screen where a
            test (or a screen-reader user scanning by role) cannot tell which
            one it has landed on.
          */}
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            onClick={() => onEdit(section.stepId, section.focusFieldId)}
          >
            Edit {section.title}
          </button>
        </div>
        <dl className="mb-0">
          {section.items.map((item) => (
            <React.Fragment key={item.label}>
              <dt>{item.label}</dt>
              <dd className={item.missing ? 'validation-error' : undefined}>
                {/*
                  Never colour alone: a missing value is marked by the icon
                  and the word, not only by whatever colour `validation-error`
                  resolves to, so the distinction survives greyscale, colour
                  blindness, and being read aloud.
                */}
                {item.missing && (
                  <AlertCircle size={14} className="me-1" aria-hidden="true" />
                )}
                {item.value}
                {item.note && <div className="form-text">{item.note}</div>}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      </div>
    ))}
  </div>
);

export default ReviewStep;
