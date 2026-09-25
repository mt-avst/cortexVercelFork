import React from 'react';
import { AlertCircle, AlertTriangle } from 'lucide-react';

import type { ReviewSection } from '../../lib/opportunity-authoring/review-summary';
import {
  PUBLISHED_NOT_WORKING_LABEL,
  PUBLISHED_NOT_WORKING_PREFIX,
  PUBLISHED_NOT_WORKING_DESCRIPTION,
  type ShareLinkUnstartableReason
} from '../../lib/opportunity-authoring/step-status';
import FieldError from './FieldError';
import ShareOpportunityLink from '../ShareOpportunityLink';
import StatusPods, { type StatusPodOption } from '../StatusPods';
import type { User } from '@shared/types';
import './review-step.css';

/**
 * Draft/Published (#167): the same two pods everywhere this choice is made -
 * see `StudyEditor.tsx`'s own three-pod list (it adds Archived) for the
 * sibling call site that shares this component.
 */
const STATUS_PODS: StatusPodOption<'draft' | 'published'>[] = [
  { value: 'draft', label: 'Draft', meaning: 'Not visible to users', tone: 'warning' },
  { value: 'published', label: 'Published', meaning: 'Visible to users', tone: 'success' }
];

/** One publish blocker, already resolved to the step that fixes it. */
interface PublishProblemPreview {
  message: string;
  stepId: number;
  stepTitle: string;
}

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
  publishRefusal: PublishProblemPreview | null;
  /**
   * Every unmet publish requirement, not just the first (audit row 4 / row
   * 16): a moderated study missing both its venue and its slots is told
   * about only one of them through `publishRefusal` above, and a moderated
   * author who fixed the first was sent back a screen later for the second.
   *
   * Optional and purely additive. When it holds one or more entries, it
   * replaces the single `publishRefusal` alert below with a checklist of
   * all of them; omitted, or empty, the single-alert behaviour is
   * unchanged. `OpportunityForm.tsx` does not build this yet - it still
   * only computes `publishRefusal` from `findPublishProblem` (singular) -
   * so wiring `findPublishProblems` (plural, `shared/firsthand/publish-
   * readiness.ts`) through to this prop is a follow-up outside this
   * component's own file. See `ReviewStep.test.tsx` for coverage of what
   * this component does once it has one.
   */
  publishProblems?: PublishProblemPreview[];
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
  /**
   * The status the study is SAVED with - null until it has been saved once.
   * `status` above is the unsaved choice in the Status control, so it cannot
   * say whether the study is live; this can (#157).
   */
  storedStatus: 'draft' | 'published' | null;
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
   * computed by the page the same way `OpportunityDetail` computes it (both
   * ask the SAME `findPublishProblems` for a live session or interview,
   * passing `hasBookableSlot: hasUpcomingSlot(sessions, now)` - the same
   * `end_time > now` rule cto/AdaptaLabs#164 pins for the "Broken" pill - and
   * `hasMeetingLocation`), so a published study missing its slot, its venue,
   * or both does not get told it is ready to share when a participant could
   * not actually start it. `OpportunityDetail` used to check only the slot
   * here, so a moderated study missing only its venue read Broken on the
   * Create & Manage table and unshareable on this screen while its own admin
   * detail page still offered a live, ready-to-share link.
   *
   * `unstartableReason`, also passed straight through, is what lets
   * `ShareOpportunityLink` name the RIGHT missing thing when `startable` is
   * false: a live session or interview can be unstartable for want of an
   * upcoming slot, a venue, or both independently, and neither is fixed by
   * supplying the other - so this is
   * `deriveShareLinkUnstartableReason(publishProblemCodes)`
   * (`lib/opportunity-authoring/step-status.ts`), not read from the type
   * alone. Optional, like `ShareOpportunityLink`'s own prop of the same
   * name: a caller that omits it gets that component's original generic
   * wording.
   */
  shareLink: {
    opportunityId: string;
    startable: boolean;
    unstartableReason?: ShareLinkUnstartableReason;
  } | null;
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
 * The standfirst under the "Review" heading, pinned per save model (audit
 * row 16).
 *
 * A create has no server baseline at all, so "Nothing has been saved yet" is
 * simply true. An edit is either autosaving (a draft - the timer already
 * persists every settled change) or it is not (a published study, which the
 * autosave guard deliberately leaves alone) - and only the second of those
 * two is where "Any change you have not already saved is still only on this
 * screen" is a TRUE claim. Before this, every edit read that sentence,
 * including an autosaving draft where it was false the moment the timer next
 * fired.
 *
 * Read from the live `status` rather than from the form's own
 * `autosaveApplies` (which OpportunityForm.tsx computes from the STORED
 * status, precisely so flipping this screen's own Status control does not
 * switch autosave off mid-sentence) because that value is not threaded to
 * this component. The one case they can disagree - the moment between
 * choosing Published here and that choice actually saving - reads the
 * published wording a beat early, which is the direction that undersells
 * autosave rather than overselling it.
 */
const reviewStandfirst = (isEdit: boolean, status: 'draft' | 'published'): string => {
  if (!isEdit) {
    return 'Your last chance to check everything before the study is created. Nothing has been saved yet.';
  }
  if (status === 'draft') {
    return 'Check everything before you save. Changes on this screen are saved automatically as you go.';
  }
  return 'Check everything before you save. Any change you have not already saved is still only on this screen.';
};

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
 * there is no other step to open for a choice that belongs here. It renders
 * last on the page, in a footer with the share block beneath it (audit row
 * 30): every section above is a fact about the CONFIGURATION, and this is
 * the one act the whole screen exists to lead up to.
 */
const ReviewStep: React.FC<ReviewStepProps> = ({
  sections,
  header,
  publishRefusal,
  publishProblems,
  onEdit,
  isEdit,
  status,
  storedStatus,
  onStatusChange,
  statusError,
  shareLink,
  role
}) => {
  // A published study can already be stored broken (row 6): a study minted
  // before a rule existed, or edited by a path that bypassed it. `Published`
  // alone would say nothing is wrong; `publishRefusal`/`publishProblems` here
  // are the SAME preview the alert below reads, so the pill cannot disagree
  // with the banner sitting a few lines under it.
  const hasPublishProblem =
    Boolean(publishRefusal) || Boolean(publishProblems && publishProblems.length > 0);

  return (
    <div className="form-section mb-5" data-testid="review-step">
      <div className="mb-4">
        <h2
          className="h4 mb-1 section-title"
          style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}
        >
          Review
        </h2>
        <p className="mb-0 section-description">{reviewStandfirst(isEdit, status)}</p>
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
          ) : hasPublishProblem ? (
            <span
              className="review-header__pill review-header__pill--broken"
              title={PUBLISHED_NOT_WORKING_DESCRIPTION}
            >
              <AlertTriangle size={14} className="me-1" aria-hidden="true" />
              {/* The pill is styled exactly like Draft, so "published" has to
                  be said: hidden for a screen reader, `title` for hover. */}
              <span className="visually-hidden">{PUBLISHED_NOT_WORKING_PREFIX}</span>
              <span>{PUBLISHED_NOT_WORKING_LABEL}</span>
            </span>
          ) : (
            <span className="review-header__pill review-header__pill--published">
              Published
            </span>
          )}
        </div>
      </div>

      {publishProblems && publishProblems.length > 0 ? (
        /* d-flex align-items-start (#167): the icon was an inline sibling of
           the block-level `<p>` below it, which forced it onto its own line
           above the sentence rather than beside it - the same shape the
           `studyConflict` banner in OpportunityForm.tsx needed the same fix
           for. align-items-start, not -center: a multi-line message centred
           against a 16px icon floats the icon into the message's middle
           instead of level with its first line. */
        <div className="alert alert-warning d-flex align-items-start" role="alert">
          <AlertTriangle size={16} className="me-2 flex-shrink-0" aria-hidden="true" />
          <div>
            {/* A study SAVED as published is already live, so "cannot be
                published yet" would tell its author the opposite of the truth
                (#157). Read from the saved status, never the Status control:
                choosing Published on an unsaved study does not publish it. */}
            <p className="mb-2">
              {storedStatus === 'published' ? 'This published study has problems:' : 'This study cannot be published yet:'}
            </p>
            <ul className="mb-0 ps-3">
              {publishProblems.map((problem) => (
                <li key={problem.stepId}>
                  {problem.message}{' '}
                  <button
                    type="button"
                    className="btn btn-link p-0 align-baseline"
                    onClick={() => onEdit(problem.stepId)}
                  >
                    Go to {problem.stepTitle}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        publishRefusal && (
          <div className="alert alert-warning d-flex align-items-start" role="alert">
            <AlertTriangle size={16} className="me-2 flex-shrink-0" aria-hidden="true" />
            <div>
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
          </div>
        )
      )}

      {/*
        Each section is a rule under a title, not a bordered box (audit row
        30): six identical boxes holding one row or twelve read as six
        equally-weighted cards regardless of how much any of them actually
        held. The Edit control is a fixed, short "Edit" rather than "Edit
        {title}" so every one sits at the same x position - the accessible
        name still carries the full "Edit {title}" via `aria-label`, so a
        screen reader (or a test scanning by role) still tells them apart.
      */}
      {sections.map((section) => (
        <section key={section.stepKey} className="review-section">
          <div className="review-section__header">
            <h3 className="review-section__title">{section.title}</h3>
            <button
              type="button"
              className="review-section__edit"
              aria-label={`Edit ${section.title}`}
              onClick={() => onEdit(section.stepId, section.focusFieldId)}
            >
              Edit
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
        </section>
      ))}

      {/*
        The footer (audit row 30): Status - the one live decision on this
        screen - and the share block it gates, both moved to the very end,
        after every read-only section. Every section above is a fact ABOUT
        the study; these two are the act of publishing it and the value that
        follows from doing so, so they read as what the screen builds up to
        rather than one more card among the summaries.
      */}
      <div className="review-footer">
        {/*
          `p-6` (1.5rem/24px, `--spacing-6`), not `p-3` (#167): the "Share
          this study" card beneath this box is a real `.card`, whose own
          padding is `--card-padding` (also 1.5rem) - `p-3` (0.75rem) sat
          this box's heading ~12px closer to its own edge than the heading
          below it, so the two boxes read as two different rhythms stacked
          on top of each other. Same value, both themes - no token invented.

          `review-status-box` (#167): this box is a plain div, not a `.card`,
          so `opportunity-form-mobile.css`'s own `<576px` trim - which
          matches `.opportunity-form .card` and so already reaches the Share
          card below - never reached it; the two went back out of rhythm
          below 576px even though they agree here. The class is the hook
          that file uses to bring this box down to the same padding at that
          width too.
        */}
        <div className="border rounded p-6 mb-3 review-status-box">
          <h3 id="status-heading" className="h6 mb-2">Status</h3>
          <div id="status-help" className="form-text mb-2">
            {status === 'draft' ? (
              <strong className="text-warning">
                <AlertTriangle size={14} className="status-help-icon me-1" aria-hidden="true" />
                DRAFT - Not visible to users. Change to Published to make visible.
              </strong>
            ) : (
              'Published studies are visible to all users'
            )}
          </div>
          <StatusPods
            name="status"
            legendId="status-heading"
            options={STATUS_PODS}
            value={status}
            onChange={onStatusChange}
            describedBy={statusError ? 'status-error status-help' : 'status-help'}
            invalid={Boolean(statusError)}
          />
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
            unstartableReason={shareLink.unstartableReason}
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
    </div>
  );
};

export default ReviewStep;
