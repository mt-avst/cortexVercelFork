import React, { useMemo, useState } from 'react';
import { AlertTriangle, Lock, ShieldCheck } from 'lucide-react';

import {
  CUSTOM_CONSENT_TEMPLATE_ID,
  currentConsentTemplate,
  findConsentTemplate,
  namedConsentTemplate,
  resolveConsentTemplate,
  type ConsentKind,
  type ConsentTemplateVersion
} from '@shared/firsthand/consent-templates';
import type { StudyReadOnlyReason } from '../../lib/opportunity-authoring/hydrate-study';
import {
  describeConsentDiff,
  diffConsentText
} from '../../lib/opportunity-authoring/consent-diff';
import FieldError from './FieldError';


export interface ConsentSelection {
  text: string;
  templateId: string;
  templateVersion: number | null;
}

export interface ConsentStepProps {
  /** Revalidate the consent field on blur, by the same rules a save runs. */
  onBlur?: () => void;
  /** Which template family applies. Decided by the study, never by this step. */
  kind: ConsentKind;
  consentText: string;
  templateId: string;
  templateVersion: number | null;
  /** The form-state key, used as the control id so error routing can find it. */
  fieldId: string;
  validationError?: string;
  /**
   * The linked study may not be authored here. Consent inherits this from the
   * content step rather than deciding it again: it is the same study.
   */
  studyIsReadOnly: boolean;
  /** Why, so the sentence matches the cause. See `StudyReadOnlyReason`. */
  readOnlyReason: StudyReadOnlyReason;
  /**
   * The study could not be READ at all.
   *
   * Distinct from read-only, and the distinction is the whole of this step's
   * honesty: a study that loaded and may not be edited has wording to show,
   * while one that never loaded has none - the form is holding its DEFAULTS. A
   * step that could not tell the two apart would render the boilerplate under
   * an approved-template badge and present it as this study's own consent,
   * which is the exact false claim this feature exists to prevent.
   */
  contentUnavailable: boolean;
  /**
   * The author chose to start from an existing study and has not picked one
   * yet, so there is no content for this consent to be about.
   */
  awaitingContent: boolean;
  /** What the previous step is called, for the sentence that sends them back. */
  contentStepTitle: string;
  onGoToContent: () => void;
  onChange: (selection: ConsentSelection) => void;
}

/**
 * Consent, as its own step, locked to the approved wording by default.
 *
 * Consent used to be a four-row textarea at the bottom of the Questions step,
 * pre-filled with a default and freely editable, with nothing recording whether
 * a study ran on the wording the organisation stands behind or on something a
 * researcher typed over it. Every study looked identical from the outside, and
 * the sentence a participant accepted was the least governed field in the form
 * while being the only one with legal weight.
 *
 * Three deliberate calls here, all of which the alternative reading would get
 * wrong:
 *
 * - LOCKED, NOT DISABLED. The approved wording renders as text, not as a
 *   greyed-out textarea. A disabled input reads as an editing surface that
 *   happens to be switched off and invites a hunt for what switches it back on;
 *   text plus an explicit "Customise" control says what is going on. Same
 *   reasoning `ReadOnlyStudyContent` records.
 * - CUSTOMISING IS NEVER BLOCKED. A researcher who needs different wording has
 *   a real reason, and a product that refuses gets worked around somewhere it
 *   cannot see. What it does instead is record the deviation and say plainly
 *   that customised wording is not approved wording.
 * - `custom` IS SET BY THE TEXT, NOT BY THE BUTTON. Unlocking the field changes
 *   nothing about the classification; diverging from the template does. So an
 *   author who unlocks, reads, and changes nothing still runs on the approved
 *   template, and one who edits and then restores it exactly is back on the
 *   template rather than stuck on a `custom` flag they cannot clear.
 */
const ConsentStep: React.FC<ConsentStepProps> = ({
  kind,
  consentText,
  templateId,
  templateVersion,
  fieldId,
  validationError,
  studyIsReadOnly,
  readOnlyReason,
  contentUnavailable,
  awaitingContent,
  contentStepTitle,
  onGoToContent,
  onChange,
  onBlur
}) => {
  /**
   * The template this study started this editing session on, captured once.
   *
   * Captured rather than re-read from props because the props change as the
   * author types: the moment the wording diverges, `templateId` becomes
   * `custom` and carries no version, and both the diff and the Restore control
   * need to keep pointing at the wording that was actually there to begin with.
   * Re-deriving it would silently retarget them at the CURRENT version, which
   * is the same text today and will not be once a version 2 ships - restoring
   * "the approved wording" would then quietly upgrade a study nobody asked to
   * upgrade.
   */
  const [baseTemplate] = useState<ConsentTemplateVersion>(() => {
    const exact = findConsentTemplate(templateId, templateVersion);
    return exact && exact.kind === kind ? exact : currentConsentTemplate(kind);
  });

  const [unlocked, setUnlocked] = useState(
    () => templateId === CUSTOM_CONSENT_TEMPLATE_ID
  );

  const applyText = (text: string) => {
    // Resolved against the template this session STARTED on, not against
    // whatever the field currently claims. Passing the live claim would mean
    // that once the wording went custom, restoring the template's exact text
    // could only be recognised by comparison with the newest version - so an
    // author on version 1 who edited and undid their edit would be left marked
    // custom for wording that is verbatim approved wording.
    const resolved = resolveConsentTemplate({
      kind,
      consentText: text,
      claimedTemplateId: baseTemplate.id,
      claimedTemplateVersion: baseTemplate.version
    });

    onChange({
      text,
      templateId: resolved.id,
      templateVersion: resolved.version
    });
  };

  const heading = (
    <div className="mb-4">
      {/*
        The landing point for Review's "Edit Consent" link, and it has to be the
        HEADING rather than the consent textarea.
        The textarea carries `fieldId`, which is the obvious target and is
        wrong: consent is LOCKED to the approved wording by default since C1, and
        while it is locked that textarea is not rendered at all. Sending focus to
        an id that does not exist is silent - the step opens and focus stays on
        the button the author just left, two steps away, which is precisely the
        failure the Edit links exist to fix. Found by driving the form; no test
        had looked at where focus actually landed.

        Derived from `fieldId` rather than a constant so the two consent
        vocabularies stay distinguishable here as they are everywhere else: a
        recorded study and a survey never render at the same time, but a single
        shared id would make that a coincidence rather than a rule.
      */}
      <h2
        id={`${fieldId}-heading`}
        tabIndex={-1}
        className="h4 mb-1 section-title"
        style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: 600 }}
      >
        Consent
      </h2>
      <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
        {kind === 'survey'
          ? 'Shown before the first question. The participant must accept it to continue.'
          : 'Shown before recording starts. The participant must accept it to continue.'}
      </p>
    </div>
  );

  // FIRST, and before anything that could describe wording: the study could not
  // be read, so the form is holding its defaults and there is nothing truthful
  // to say about what this study's consent is.
  if (contentUnavailable) {
    return (
      <div className="form-section mb-5" data-testid="consent-step">
        {heading}
        <p className="text-muted" data-testid="consent-unavailable">
          This study&rsquo;s consent wording could not be loaded, so it is not
          shown here. Reload the page to try again.
        </p>
      </div>
    );
  }

  const refusal = validationError ? (
    <FieldError>{validationError}</FieldError>
  ) : null;

  if (studyIsReadOnly) {
    return (
      <div className="form-section mb-5" data-testid="consent-step">
        {heading}
        <p className="text-muted" style={{ fontSize: '0.9rem' }}>
          {readOnlyReason === 'not-representable'
            ? 'This study holds content this form cannot represent, so its consent wording is shown as it stands. Edit it in the Task Lists area instead.'
            : 'This study is not yours to change here, so its consent wording is shown as it stands.'}
        </p>
        <ConsentTemplateBadge
          kind={kind}
          templateId={templateId}
          templateVersion={templateVersion}
        />
        <blockquote
          className="mt-3 ps-3"
          data-testid="consent-read-only-text"
          style={{ borderLeft: '3px solid var(--border-color, #ced4da)' }}
        >
          {consentText}
        </blockquote>
      </div>
    );
  }

  if (awaitingContent) {
    return (
      <div className="form-section mb-5" data-testid="consent-step">
        {heading}
        {/* The refusal is rendered HERE too, not only beside the editor. The
            error summary routes the author to this step by field, and it can
            land them on this arm - clear the wording, then switch the source
            choice back to copy - where an unrendered error is a banner naming a
            field with nothing on screen to fix and no way to see why. */}
        {refusal}
        <div className="alert alert-info" role="status">
          <p className="mb-2">
            You have chosen to start from an existing study, but have not picked
            one yet. Its consent wording comes across with its content, so there
            is nothing to set here until you choose.
          </p>
          <button type="button" className="btn btn-link p-0" onClick={onGoToContent}>
            Go back to {contentStepTitle}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="form-section mb-5" data-testid="consent-step">
      {heading}

      <ConsentTemplateBadge
        kind={kind}
        templateId={templateId}
        templateVersion={templateVersion}
      />

      {refusal}

      {unlocked ? (
        <>
          <div className="form-group mt-3">
            <label
              htmlFor={fieldId}
              className="form-label mb-2"
              style={{ fontSize: '1rem', fontWeight: 600 }}
            >
              Consent text *
            </label>
            <textarea
              id={fieldId}
              className={`form-control ${validationError ? 'is-invalid' : ''}`}
              rows={6}
              value={consentText}
              onChange={(event) => applyText(event.target.value)}
              onBlur={onBlur}
            />
            <div className="form-text mt-1" style={{ fontSize: '0.875rem' }}>
              {templateId === CUSTOM_CONSENT_TEMPLATE_ID
                ? 'This wording has not been approved. It is recorded as custom, and shown as custom wherever this study appears.'
                : 'This still matches the approved wording, so the study is recorded as running on the template.'}
            </div>
          </div>

          <div className="mt-3">
            <ConsentDiffView
              approvedText={baseTemplate.text}
              currentText={consentText}
              templateName={baseTemplate.name}
            />
          </div>

          <button
            type="button"
            className="btn btn-outline-secondary btn-sm mt-3"
            onClick={() => {
              applyText(baseTemplate.text);
              setUnlocked(false);
            }}
          >
            Restore the approved wording
          </button>
        </>
      ) : (
        <>
          <blockquote
            className="mt-3 ps-3"
            data-testid="consent-locked-text"
            style={{ borderLeft: '3px solid var(--border-color, #ced4da)' }}
          >
            {consentText}
          </blockquote>
          <p className="text-muted" style={{ fontSize: '0.875rem' }}>
            <Lock size={14} className="me-1" aria-hidden="true" />
            Locked to the approved wording. Customise it only if this study needs
            to say something different.
          </p>
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            onClick={() => setUnlocked(true)}
          >
            Customise consent wording
          </button>
        </>
      )}
    </div>
  );
};

/**
 * What the study runs on, in one line.
 *
 * Icon AND words, never colour alone: "approved" and "not approved" is exactly
 * the distinction that must survive being read in greyscale, by somebody
 * colour-blind, or out loud.
 */
const ConsentTemplateBadge: React.FC<{
  kind: ConsentKind;
  templateId: string;
  templateVersion: number | null;
}> = ({ kind, templateId, templateVersion }) => {
  // Resolved here rather than by the caller so the badge can distinguish the
  // three answers it actually has. `describeConsentTemplate` collapses two of
  // them: it falls back to the CURRENT version when the id is known but the
  // version is not, and the badge would then print a version number the row
  // does not carry - asserting a specific approval that nothing recorded.
  const exact = findConsentTemplate(templateId, templateVersion);
  const named = exact ?? namedConsentTemplate(templateId);

  if (!named || named.kind !== kind) {
    return (
      <div className="alert alert-warning mb-0" role="status" data-testid="consent-template-state">
        <AlertTriangle size={16} className="me-2" aria-hidden="true" />
        <strong>Custom wording.</strong> This study does not run on approved
        consent wording, and that is recorded against it.
      </div>
    );
  }

  return (
    <div className="alert alert-secondary mb-0" role="status" data-testid="consent-template-state">
      <ShieldCheck size={16} className="me-2" aria-hidden="true" />
      <strong>
        {named.name}{' '}
        {exact ? `(version ${exact.version})` : '(version not recorded)'}
      </strong>
      <div style={{ fontSize: '0.875rem' }}>{named.summary}</div>
    </div>
  );
};

/**
 * The marked-up difference, plus the same fact in a sentence.
 *
 * The sentence is not a nicety. Strike-through and underline are the whole of
 * the visual encoding, and neither reaches a screen reader, so without it the
 * diff is decoration for a substantial share of the people this feature is
 * meant to protect.
 */
const ConsentDiffView: React.FC<{
  approvedText: string;
  currentText: string;
  templateName: string;
}> = ({ approvedText, currentText, templateName }) => {
  const diff = useMemo(
    () => diffConsentText(approvedText, currentText),
    [approvedText, currentText]
  );
  const summary = describeConsentDiff(diff);

  return (
    <div data-testid="consent-diff">
      <h3 className="h6 mb-1">Compared with {templateName}</h3>
      <p className="text-muted mb-2" style={{ fontSize: '0.875rem' }}>
        {summary}
      </p>
      {diff.addedWords > 0 || diff.removedWords > 0 ? (
        <p className="mb-0" style={{ lineHeight: 1.8 }}>
          {diff.segments.map((segment, index) => {
            if (segment.kind === 'same') {
              return <span key={index}>{segment.text}</span>;
            }

            // No opacity, and no colour. `opacity: 0.7` on the deleted run was
            // a serious axe colour-contrast failure - it dims the TEXT, and
            // this is the one place in the form where the words being read are
            // the point. A colour pair would have to be picked twice for the
            // two themes and would still be carrying meaning on its own; the
            // line-through and the underline already distinguish the two runs
            // without either problem, and the summary sentence above says which
            // is which in words.
            //
            // The padding is not decoration either: a deletion and an insertion
            // are frequently adjacent, and without it they render hard against
            // each other.
            const marked = { padding: '0 0.15em', borderRadius: '2px' };

            if (segment.kind === 'removed') {
              return (
                <del key={index} style={marked}>
                  {segment.text}
                </del>
              );
            }

            return (
              <ins key={index} style={{ ...marked, textDecoration: 'underline' }}>
                {segment.text}
              </ins>
            );
          })}
        </p>
      ) : null}
    </div>
  );
};

export default ConsentStep;
