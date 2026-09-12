import React from 'react';
import { AlertCircle, AlertTriangle } from 'lucide-react';

import type { ReviewSection } from '../../lib/opportunity-authoring/review-summary';
import FieldError from './FieldError';
import ShareOpportunityLink from '../ShareOpportunityLink';
import type { User } from '@shared/types';
import './review-step.css';

interface ReviewStepProps {
  sections: ReviewSection[];
  /**
   * The identity that leads the screen (WZ-17): the study's title and the
   * participant-facing label for its type. Read-only orientation, computed by
   * `buildReviewHeader` from the same data the sections are built from - this
   * component still never reads `type` itself, only the label handed to it.
   */
  header: { title: string; typeLabel: string };
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
  /**
   * Draft vs published, moved here from Basic Information (#111).
   *
   * The tester's own framing - "when I'm done with the config, I should then
   * choose to publish or not" - is why this control sits after every summary
   * section rather than beside them: it is the LAST decision on the form, not
   * one more fact being checked. Nothing about how the choice is SAVED moves
   * with it - `formData.status` still flows into `handleSubmit` exactly as it
   * did on Basic Information, and the autosave guard (`forAutosave`,
   * `autosaveApplies`) already reads the stored status rather than the step
   * the author is standing on, so publishing stays an explicit act performed
   * only when this step's own submit button is pressed.
   */
  status: 'draft' | 'published';
  /** Change handler for the control above. */
  onStatusChange: (status: 'draft' | 'published') => void;
  /** A validation error for `status`, if the server or a future check ever raises one. */
  statusError?: string;
  /**
   * The participant link preview, or null while the study has no id at all.
   *
   * An opportunity only gets an id once it has been saved once - a brand new,
   * unsaved study has nothing to link to yet, so `null` here means "do not
   * render a share block", not "render a broken one". Once an id exists,
   * whether the link is actually LIVE for a participant is decided by
   * `status` above, which this component already holds.
   *
   * `startable` mirrors `ShareOpportunityLink`'s own prop of the same name -
   * computed by the page the same way `OpportunityDetail` computes it, so a
   * published study with e.g. no session slots yet does not get told it is
   * ready to share when a participant could not actually start it.
   */
  shareLink: { opportunityId: string; startable: boolean } | null;
  /**
   * The viewer's role, threaded straight through to `ShareOpportunityLink`'s
   * own admin gate. This form is already admin-only (see the redirect in
   * `OpportunityForm`), so the gate never actually hides anything here - it is
   * passed so this stays the one place that component's visibility rule is
   * decided, rather than a second copy of "isAdmin" living in this file too.
   */
  role?: User['role'];
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
 *
 * `status` is the one control on this screen that is not a summary of
 * something decided elsewhere - it IS the decision, and it lives directly on
 * this component rather than as a `ReviewSection` because a section is
 * read-only content with an "Edit" button that opens some other step, and
 * there is no other step to open for a choice that belongs here.
 */
const ReviewStep: React.FC<ReviewStepProps> = ({
  sections,
  header,
  publishRefusal,
  onEdit,
  isEdit,
  status,
  onStatusChange,
  statusError,
  shareLink,
  role
}) => (
  <div className="form-section mb-5" data-testid="review-step">
    <div className="mb-4">
      <h2 className="h4 mb-1 section-title">Review</h2>
      <p className="mb-0 section-description">
        {isEdit
          ? 'Check everything before you save. Any change you have not already saved is still only on this screen.'
          : 'Your last chance to check everything before the study is created. Nothing has been saved yet.'}
      </p>
    </div>

    {/*
      The identity card (WZ-17): the study's title as the largest text, then a
      row of two pills - the type label and the current draft/published state.
      Read-only orientation; the Status control below remains the one place the
      state is actually chosen, and this pill only reflects it. Anchoring the
      screen here is why the publish-refusal alert now sits directly beneath it.
    */}
    <div className="review-header" data-testid="review-header">
      <h3
        className={`review-header__title${header.title ? '' : ' review-header__title--empty validation-error'}`}
      >
        {/*
          A missing title is a REQUIRED field short of a value, not a stylistic
          blank - and title is not a publish-readiness code, so the refusal
          alert never mentions it. This is the one place it shows before Save,
          so it is flagged the way every other missing value on this screen is:
          an icon and the words "No title yet", never colour alone.
        */}
        {header.title || (
          <>
            <AlertCircle size={18} className="me-1" aria-hidden="true" />
            No title yet
          </>
        )}
      </h3>
      <div className="review-header__pills">
        <span className="review-header__pill review-header__pill--type">
          {header.typeLabel}
        </span>
        {status === 'draft' ? (
          <span className="review-header__pill review-header__pill--draft">
            <AlertTriangle size={14} className="me-1" aria-hidden="true" />
            Draft
          </span>
        ) : (
          <span className="review-header__pill review-header__pill--published">
            Published
          </span>
        )}
      </div>
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
        <dl className="review-dl">
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

    {/*
      The last decision on the form, deliberately last on the page too (#111).
      Every section above is a fact about the CONFIGURATION; this one is the
      act of publishing it, and it is not itself a fact being reviewed - there
      is nothing to "Edit" here, only a choice to make, so it renders as a live
      control rather than another read-only card with an Edit button.
    */}
    <div className="border rounded p-3 mb-3">
      <h3 id="status-heading" className="h6 mb-2">Status</h3>
      <div id="status-help" className="form-text mb-2">
        {status === 'draft' ? (
          <strong className="text-warning">
            <AlertTriangle size={14} className="me-1" aria-hidden="true" />
            DRAFT - Not visible to users. Change to Published to make visible.
          </strong>
        ) : (
          'Published studies are visible to all users'
        )}
      </div>
      <select
        id="status"
        className={`form-select ${statusError ? 'is-invalid' : ''}`}
        style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', maxWidth: '360px' }}
        value={status}
        onChange={(e) => onStatusChange(e.target.value as 'draft' | 'published')}
        aria-labelledby="status-heading"
        aria-describedby={statusError ? 'status-error status-help' : 'status-help'}
        aria-invalid={statusError ? 'true' : 'false'}
      >
        <option value="draft">Draft - Not visible to users</option>
        <option value="published">Published - Visible to users</option>
      </select>
      {statusError && <FieldError id="status-error">{statusError}</FieldError>}
    </div>

    {/*
      The tester's own words: "as a key action now, I'm looking to get a
      sharable link to send to participants... I've done the work of setting
      it up, now here's your value." Placed directly under Status because that
      is the decision this block is downstream of - draft shows a hint,
      published shows the live link, and nothing renders until the study has
      an id to link to at all.
    */}
    {shareLink && status === 'published' && (
      <ShareOpportunityLink
        opportunityId={shareLink.opportunityId}
        status={status}
        role={role}
        startable={shareLink.startable}
      />
    )}

    {shareLink && status === 'draft' && (
      <div className="card mb-4">
        <div className="card-body">
          <h2 className="h6 mb-2">Share this study</h2>
          <p className="text-muted mb-0" style={{ fontSize: '0.875rem' }}>
            Publish to share this link. Once this study is published,
            its participant link appears here to copy.
          </p>
        </div>
      </div>
    )}
  </div>
);

export default ReviewStep;
