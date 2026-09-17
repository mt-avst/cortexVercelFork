import React from 'react';
import { ArrowLeft, ArrowRight, CheckCircle, Save } from 'lucide-react';

/**
 * The forward control, which is one thing or the other and never both. Written
 * as a union so the compiler holds the contract: a step that continues must
 * name where it is continuing to, and a step that submits cannot also carry a
 * Continue label. Left as four independent optional props, the type permits a
 * row with a live-looking button wired to nothing.
 */
type ForwardControl =
  | {
      onNext: () => void;
      nextLabel: string;
      onSubmit?: never;
      submitLabel?: never;
      submitVariant?: never;
    }
  | {
      onSubmit: () => void;
      /**
       * What the terminal control says.
       *
       * Required, and passed in rather than decided here from `isEdit`. This
       * component used to hard-code "Create Opportunity" / "Update
       * Opportunity", which made it the only place in the form that chose
       * product copy - and after C3 there is exactly ONE step that submits, so
       * a label baked in here is a label with no reader. Naming it at the call
       * site is also what stops a second submitting step appearing later
       * wearing the wrong words.
       */
      submitLabel: string;
      submitVariant?: 'primary' | 'success';
      onNext?: never;
      nextLabel?: never;
    };

/**
 * The backward control, present or absent as a pair.
 *
 * Written as a union for the same reason the forward control is: a back
 * control that does not name its destination is the thing this step exists to
 * remove, and left as two independent optional props the type permits exactly
 * that. The compiler holds it instead of a comment asking nicely.
 */
type BackwardControl =
  | { onPrevious: () => void; previousLabel: string }
  | { onPrevious?: never; previousLabel?: never };

type StepActionsProps = ForwardControl &
  BackwardControl & {
  /** The green shortcut. Given only for an edit that has changed something. */
  onSave?: () => void;
  /**
   * D9: "Save and exit" is deleted from this row - drafts autosave, and
   * Exit to dashboard already covers leaving deliberately, so the row had
   * three ways to stop and two of them did the same job. This prop is kept,
   * unused, purely so a caller that still passes it (OpportunityForm.tsx,
   * which this build does not touch) keeps typechecking; nothing here reads
   * it any more. See run/W5.md, row 24, for the caller-side note.
   */
  onSaveAndExit?: () => void;
  isEdit: boolean;
  saving: boolean;
  /**
   * One value for every control on the row, computed once by the form, so the
   * save controls cannot drift apart on what disables them. A study that could
   * not be read is one of the reasons, and it is the one most easily dropped.
   */
  disabled: boolean;
  /**
   * True for a few seconds immediately after THIS row's save genuinely
   * persisted, so the button the author actually pressed says so - not just a
   * banner above the fold they may already have scrolled past.
   *
   * Driven by the form's `successMessage`, which is set once and only once
   * the save request has resolved successfully against the server (issue
   * #109: a save that gave no acknowledgement read as a dead end). Passed in
   * rather than decided here, for the same reason `disabled` is: this
   * component must not invent its own idea of when a save succeeded.
   */
  justSaved?: boolean;
};

/**
 * The one bottom action row, shared by every step of the opportunity form.
 *
 * There were five near-identical copies of this markup, each hard-coding its
 * own step numbers and rebuilding the same optional Save button. Every later
 * change to this chrome had to be made five times, and they had already drifted
 * apart in three ways.
 *
 * Every control here is `type="button"`, which means this form has no submit
 * button at all - and that is the CONDITION for implicit submission, not a
 * defence against it. This comment used to claim the opposite, and the claim
 * was load-bearing: it is the reason nobody looked, while pressing Return in a
 * step with a single text field created the opportunity from a step that was
 * not Review. The form's own `onSubmit` is what refuses that, in
 * `OpportunityForm.tsx`; these buttons only make it possible for it to.
 *
 * A nearly-right premise in a comment has now cost this plan several defects.
 * This one is corrected rather than deleted so the next reader knows which way
 * round the rule goes.
 */
const StepActions: React.FC<StepActionsProps> = ({
  onPrevious,
  previousLabel,
  onNext,
  nextLabel,
  onSubmit,
  submitLabel,
  onSave,
  isEdit,
  saving,
  disabled,
  /*
   * D9: one commit colour. This used to default to 'success', which painted
   * the Review step's terminal button green while every other step's Continue
   * was orange - the one control on the row that changes meaning (and now,
   * colour) is the last one an author presses, which is exactly the control
   * that should look the least surprising. No caller passes submitVariant
   * explicitly (grepped: only this default is ever in effect), so this one
   * line is the whole fix.
   */
  submitVariant = 'primary',
  justSaved = false
}) => (
  <div className="step-actions border-top mt-4 pt-4">
    <div className="d-flex justify-content-between align-items-center gap-2">
      {onPrevious ? (
        <button
          type="button"
          className="btn btn-outline-secondary step-actions__nav-button px-5 py-2 fw-semibold"
          onClick={onPrevious}
          style={{ fontSize: '0.95rem' }}
        >
          <ArrowLeft size={16} className="me-2" />
          Previous: {previousLabel}
        </button>
      ) : (
        <div style={{ flex: 1 }}></div>
      )}

      {onSave && (
        <button
          type="button"
          className="btn btn-success px-5 py-2 fw-semibold"
          onClick={onSave}
          disabled={disabled}
          style={{ fontSize: '0.95rem' }}
        >
          {saving ? (
            <>
              <span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
              Saving...
            </>
          ) : justSaved ? (
            <>
              <CheckCircle size={16} className="me-2" />
              Saved
            </>
          ) : (
            <>
              <Save size={16} className="me-2" />
              Save Changes
            </>
          )}
        </button>
      )}

      {/*
        D9: "Save and exit" is deleted. Drafts autosave (there is nothing
        this button saved that the next autosave tick would not have), and
        Exit to dashboard already covers leaving on purpose. It also used to
        sit as the middle child of this space-between row, so it drifted up
        to 74px between steps as its two neighbours resized - deleting it
        removes that drift along with the control.
      */}

      {onNext ? (
        <button
          type="button"
          className="btn btn-primary step-actions__nav-button px-5 py-2 fw-semibold"
          onClick={onNext}
          style={{ fontSize: '0.95rem' }}
        >
          {nextLabel}
          <ArrowRight size={16} className="ms-2" />
        </button>
      ) : (
        <button
          type="button"
          /* `step-actions__submit`: a stable hook for tests that need to find
             THIS control without matching on its colour class (D9 changed
             that) or its text (which is the very thing under test in some of
             those - "Save changes" / "Saved" / "Updating..."). */
          className={`btn btn-${submitVariant} step-actions__nav-button step-actions__submit px-5 py-2 fw-semibold`}
          onClick={onSubmit}
          disabled={disabled}
          style={{ fontSize: '0.95rem' }}
        >
          {saving ? (
            <>
              <span className="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
              {isEdit ? 'Updating...' : 'Creating...'}
            </>
          ) : justSaved ? (
            <>
              <CheckCircle size={16} className="me-2" />
              Saved
            </>
          ) : (
            <>
              <CheckCircle size={16} className="me-2" />
              {submitLabel}
            </>
          )}
        </button>
      )}
    </div>
  </div>
);

export default StepActions;
