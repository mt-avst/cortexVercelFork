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
  | { onNext: () => void; nextLabel: string; onSubmit?: never; submitVariant?: never }
  | {
      onSubmit: () => void;
      /**
       * The Questions step's final control is blue where every other step's is
       * green. That is an inconsistency rather than a decision, but changing it
       * here would be a visible change this step is not allowed to make.
       */
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
  isEdit: boolean;
  saving: boolean;
  /**
   * One value for every control on the row, computed once by the form, so the
   * save controls cannot drift apart on what disables them. A study that could
   * not be read is one of the reasons, and it is the one most easily dropped.
   */
  disabled: boolean;
};

/**
 * The one bottom action row, shared by every step of the opportunity form.
 *
 * There were five near-identical copies of this markup, each hard-coding its
 * own step numbers and rebuilding the same optional Save button. Every later
 * change to this chrome had to be made five times, and they had already drifted
 * apart in three ways.
 *
 * Every control here is `type="button"`. Nothing in the form submits it
 * implicitly, so Enter behaves the same way on every step, and the form's own
 * validation runs instead of the browser's.
 */
const StepActions: React.FC<StepActionsProps> = ({
  onPrevious,
  previousLabel,
  onNext,
  nextLabel,
  onSubmit,
  onSave,
  isEdit,
  saving,
  disabled,
  submitVariant = 'success'
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
          ) : (
            <>
              <Save size={16} className="me-2" />
              Save Changes
            </>
          )}
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
          ) : (
            <>
              <CheckCircle size={16} className="me-2" />
              {isEdit ? 'Update Opportunity' : 'Create Opportunity'}
            </>
          )}
        </button>
      )}
    </div>
  </div>
);

export default StepActions;
