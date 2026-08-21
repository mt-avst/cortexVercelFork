import React, { useEffect, useRef } from 'react';
import { Eye, X } from 'lucide-react';

import { SurveyRunner } from '../survey/SurveyRunner';
import type { SessionPayload } from '../../shared/firsthand/contract';
import {
  NO_OP_PREVIEW_TRANSPORT,
  type ParticipantPreview as ParticipantPreviewModel,
  type PreviewBlockedReason
} from '../../lib/opportunity-authoring/participant-preview';
import useDocumentTitle from '../../hooks/useDocumentTitle';

/**
 * The runner's own completion copy says the answers have been recorded, which
 * on this page is false - and it sat directly under a banner saying nothing is
 * recorded, so the screen contradicted itself. Passed with the no-op transport
 * because the two are one decision: what the transport did is what this
 * sentence reports.
 */
const PREVIEW_COMPLETION_MESSAGE =
  'That is the end of the survey. Nothing was saved - this was a preview.';

/**
 * Keyed on the union rather than on `string`, so a new reason is a compile
 * error here instead of a rendered `undefined` where the explanation should be.
 */
const BLOCKED_MESSAGES: Record<PreviewBlockedReason, string> = {
  'no-content':
    'There is nothing to preview yet. Add at least one question or task, then come back.',
  incomplete:
    'This cannot be previewed while something is unfinished - a prompt with no words in it, or an answer list with no answers. Fix what the form is flagging and try again.',
  /*
    A separate reason from `incomplete`, and it has to be. That message tells
    the author to fix what the form is flagging - true of their own draft, and
    false of somebody else's stored set, where nothing is flagged, the form is
    not showing the content, and there is nothing they can do from here. A
    remedy that does not exist on this path is worse than no remedy.
  */
  'stored-unreadable':
    'This set holds a question Cortex cannot show here. Open it in the Task Lists area to see what is in it.'
};

/**
 * The way in, from the authoring steps and from Review.
 *
 * One component for all three sites rather than three copies of the same
 * button: the label is a promise about what the next screen is, and three
 * hand-written copies is three chances for one of them to start promising
 * something else.
 *
 * NEVER disabled, on the same reasoning ReviewStep records for its publish
 * refusal. A disabled control cannot say why, and "there is nothing to preview
 * yet" is a sentence the preview itself delivers with the fix attached.
 */
export const PreviewParticipantButton: React.FC<{ onClick: () => void }> = ({
  onClick
}) => (
  <button
    className="btn btn-outline-primary mb-3"
    data-testid="preview-participant"
    /*
      Called with no arguments, deliberately. Wired as `onClick={onClick}` the
      handler receives a MouseEvent, and `openPreview`'s
      `(stored = null) => void` signature IS assignable to `() => void` - so
      `onClick={openPreview}` would type-check, put a SyntheticEvent into the
      stored-study slot, and throw on `steps.filter`.
    */
    onClick={() => onClick()}
    type="button"
  >
    <Eye size={16} aria-hidden="true" className="me-2" />
    Preview participant experience
  </button>
);

/**
 * What a participant will see, shown to the researcher who is writing it.
 *
 * The whole feature is one claim - **nothing here is saved and nothing is
 * recorded** - so the two things that make the claim true are both structural
 * rather than conventions to remember. The survey runs on
 * `NO_OP_PREVIEW_TRANSPORT`, which is the only transport this file knows about;
 * and the recorded study is a READ-THROUGH rather than a running recorder,
 * because a preview that asked for a screen share to look convincing would be
 * doing the exact thing it promises not to.
 *
 * Rendered as the whole page rather than as a modal over the form. The form
 * component stays mounted underneath - that is what preserves the unsaved edits
 * being previewed - but nothing of it is drawn, so there is no second surface
 * for a screen reader to wander into and no scroll or focus trap to maintain.
 */
const ParticipantPreview: React.FC<{
  preview: ParticipantPreviewModel;
  onClose: () => void;
}> = ({ preview, onClose }) => {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useDocumentTitle('Preview');

  /**
   * Focus moves to the heading because the URL changed but the browser did
   * not: in a client-side route change nothing tells a screen reader the page
   * is now something else, so focus left on the button that opened this would
   * leave a participant surface being read as part of a form.
   *
   * Focus is given BACK by the form, not by a cleanup here. That was the first
   * shape and it silently did nothing: React runs a deleted component's effect
   * cleanups during the mutation phase, before the sibling DOM updates land, so
   * the form was still `display: none` when `focus()` was called and the call
   * was a no-op - the browser dropped focus to `body`. The form owns the button
   * and knows when it is visible again, so the form restores it. See
   * `previewOpener` in OpportunityForm.
   */
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Escape leaves, matching every other take-the-page-over surface. Bound to
  // the document rather than to a wrapper: the runner takes focus as soon as
  // the participant starts answering, and a handler on an ancestor div would
  // then only fire because focus happened to still be inside it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="container py-4" data-testid="participant-preview">
      {/*
        Never only a colour and never only an icon: the word "Preview", the
        sentence saying what that means, and the icon all say the same thing,
        so the distinction survives greyscale and being read aloud. This is the
        one piece of chrome that must not be mistakable for the real page.
      */}
      <div className="alert alert-warning d-flex align-items-start gap-3" role="note">
        <Eye size={20} aria-hidden="true" className="flex-shrink-0 mt-1" />
        <div className="flex-grow-1">
          <h1 className="h5 mb-1" ref={headingRef} tabIndex={-1}>
            Preview: what a participant sees
          </h1>
          <p className="mb-0">
            Nothing on this page is saved and nothing is recorded. No answer you
            give here is stored, and no participant ever sees this preview.
          </p>
        </div>
        <button
          className="btn btn-outline-secondary btn-sm flex-shrink-0"
          onClick={onClose}
          type="button"
        >
          <X size={14} aria-hidden="true" className="me-1" />
          Close preview
        </button>
      </div>

      {!preview.previewable && (
        <div className="alert alert-info" role="status">
          {BLOCKED_MESSAGES[preview.reason]}
        </div>
      )}

      {preview.previewable && preview.kind === 'survey' && (
        /*
          The real runner, on a transport that goes nowhere - NOT a second
          renderer built to look like it. A copy would start drifting from the
          participant's actual experience the first time either changed, and a
          preview that has drifted is worse than none: it is a wrong answer to
          the only question the researcher asked.
        */
        <SurveyRunner
          completionMessage={PREVIEW_COMPLETION_MESSAGE}
          payload={preview.payload}
          transport={NO_OP_PREVIEW_TRANSPORT}
        />
      )}

      {preview.previewable && preview.kind === 'recorded' && (
        <RecordedReadThrough
          payload={preview.payload}
          startingUrlLabel={preview.startingUrlLabel}
        />
      )}
    </div>
  );
};

/**
 * A recorded study, read through rather than run.
 *
 * The participant experience of a recorded study IS the recording machinery -
 * a screen-share prompt, a microphone permission, a floating task pane and an
 * upload. None of that can be shown without either doing it for real or faking
 * it, and a fake recorder is the one thing a preview must never be: it would
 * teach the researcher that the flow works when the only thing proven is that
 * the imitation does.
 *
 * So this shows the parts that are actually authored content - the consent
 * wording, the starting page and the tasks in order - and says plainly what the
 * real session adds. That is the scope the plan set, and it is the honest one.
 */
const RecordedReadThrough: React.FC<{
  payload: SessionPayload;
  startingUrlLabel: string | null;
}> = ({ payload, startingUrlLabel }) => {
  const tasks = payload.steps.filter((step) => step.type !== 'end');

  return (
    <section className="survey-runner">
      <h2 className="h4">{payload.study.title}</h2>
      <p className="body-copy">{payload.study.intro_text}</p>

      <div className="border rounded p-3 mb-4">
        <h3 className="h6">Before they start</h3>
        <p className="body-copy mb-0">{payload.study.consent_text}</p>
      </div>

      <div className="alert alert-secondary" role="note">
        <strong>The real session records screen and microphone.</strong>{' '}
        <span>
          A participant is asked to share their screen and allow their
          microphone before the first task, and the recording runs until they
          stop sharing. This read-through asks for neither and records nothing.
        </span>
      </div>

      <h3 className="h6">
        Starting page:{' '}
        {startingUrlLabel ? (
          /*
            The host, not a link. A researcher checking their own study does
            not need to be sent to the page under test, and a live link here
            would open it outside the recorded task window - which is the one
            place a participant must not open it from.
          */
          <code>{startingUrlLabel}</code>
        ) : (
          <span className="text-muted fw-normal">not set yet</span>
        )}
      </h3>

      <h3 className="h6 mt-4">Tasks, in the order they are given</h3>
      <ol className="mb-0">
        {tasks.map((step) => (
          <li className="mb-3" key={step.step_id}>
            <div>{step.prompt}</div>
            {step.helper_text && (
              <div className="form-text">{step.helper_text}</div>
            )}
            {step.options && step.options.length > 0 && (
              <ul className="mt-1">
                {step.options.map((option) => (
                  <li key={option}>{option}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};

export default ParticipantPreview;
