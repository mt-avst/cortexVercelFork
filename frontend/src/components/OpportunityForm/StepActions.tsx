import React from 'react';
import { ArrowLeft, ArrowRight, CheckCircle, DoorOpen, Save } from 'lucide-react';

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
   * Save what is here and leave, on EVERY step.
   *
   * The row already had a Save shortcut and it was given only on an edit that
   * had changed something, which leaves the commonest unfinished-work case -
   * a create, halfway down step two - with no way out that keeps the work
   * except walking forward to Review. Passed in rather than derived here for
   * the same reason the labels are: this component does not get to decide
   * which controls a step has.
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
  onSaveAndExit,
  isEdit,
  saving,
  disabled,
  submitVariant = 'success',
  justSaved = false
}) => (
  <div className="border-top mt-4 pt-4">
    <div className="d-flex justify-content-between align-items-center gap-2">
      {onPrevious ? (
        <button
          type="button"
          className="btn btn-outline-secondary px-5 py-2 fw-semibold"
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

      {onSaveAndExit && (
        <button
          type="button"
          className="btn btn-outline-primary px-4 py-2 fw-semibold"
          onClick={onSaveAndExit}
          disabled={disabled}
          style={{ fontSize: '0.95rem' }}
        >
          <DoorOpen size={16} className="me-2" />
          Save and exit
        </button>
      )}

      {onNext ? (
        <button
          type="button"
          className="btn btn-primary px-5 py-2 fw-semibold"
          onClick={onNext}
          style={{ fontSize: '0.95rem' }}
        >
          {nextLabel}
          <ArrowRight size={16} className="ms-2" />
        </button>
      ) : (
        <button
          type="button"
          className={`btn btn-${submitVariant} px-5 py-2 fw-semibold`}
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
