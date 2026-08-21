/**
 * The error summary an author sees when a save or a Continue is refused.
 *
 * One entry per failing validation key, in the order the author would meet the
 * fields walking the form forwards, each carrying the id of the control it is
 * about so activating it can put the caret in the right box.
 *
 * Pure, and it takes `locate` as a parameter for the same reason
 * `stepsHoldingErrors` does: `FIELD_LOCATIONS` and `locateField` live in
 * `OpportunityForm.tsx`, and the dependency has to point one way only.
 */

export interface ErrorSummaryEntry {
  /**
   * The validation key. Rendered as a `data-field` attribute, which is the
   * only way a test can read the summary as a SET OF KEYS rather than as a set
   * of sentences - and the Continue/Submit agreement test is about the keys.
   */
  key: string;
  /**
   * The single message for this key. The same string the field itself shows,
   * because there is one vocabulary: a summary that paraphrases the field is
   * two vocabularies wearing one coat.
   */
  message: string;
  /** The step that renders the offending control. */
  stepId: number;
  /**
   * The DOM id of the control to focus. Optional because a handful of
   * sub-controls (a choice question's individual answer boxes) have no id of
   * their own; those entries still open the right step, they just cannot land
   * the caret.
   */
  controlId?: string;
}

export interface ErrorSummaryInput {
  errors: Record<string, string>;
  /** `locateField` from the page. */
  locate: (key: string) => { tab: number };
  /**
   * The control id for a key, or undefined when it has none. Passed in because
   * per-item controls are keyed by the item's client id, which only the page
   * holds.
   */
  resolveControl: (key: string) => string | undefined;
  /**
   * Field keys in the order the author meets them. Ties within a step are
   * broken by this, so the summary reads top-to-bottom down the step rather
   * than in whatever order the validator happened to assign.
   */
  order: readonly string[];
}

const INDEXED = /^(.+)\.(\d+)\./;

/**
 * The 1-based position a per-item message is about, resolved from the error KEY
 * at render time.
 *
 * The number used to be baked into the sentence when the validator ran:
 * `Enter the text for question ${index + 1}`. That froze it. `remapAuthoringErrors`
 * moves an error's KEY when its item moves and carries the MESSAGE through
 * verbatim, so after a reorder, a delete or a duplicate the card labelled "1."
 * showed "Enter the text for question 3", and the summary entry - sorted into
 * the right place by the very index it was contradicting - said the same.
 *
 * A test in this repo enshrined that as deliberate, on the grounds that
 * re-deriving the number "would need a save". It does not: the key holds the
 * live index, `rankWithinStep` below already parses it out to sort by, and both
 * renderers have it in hand. The stored message carries `{n}` and each renderer
 * substitutes.
 */
export const POSITION_PLACEHOLDER = '{n}';

export const positionOf = (key: string): number | null => {
  const indexed = INDEXED.exec(key);
  return indexed ? Number(indexed[2]) + 1 : null;
};

/**
 * The sentence as the author reads it, with the live position substituted in.
 *
 * Both the summary and the field call this, on the same stored string, so the
 * two cannot drift - which is the one-vocabulary rule the placeholder has to
 * respect to be worth having.
 */
export const resolveMessage = (key: string, message: string): string => {
  if (!message.includes(POSITION_PLACEHOLDER)) {
    return message;
  }
  const position = positionOf(key);
  return position === null
    ? message
    : message.split(POSITION_PLACEHOLDER).join(String(position));
};

/**
 * Where a key sorts within its step: which field, then which item.
 *
 * An unknown key sorts last rather than first. Sorting it first would put a
 * key nobody has mapped at the top of the list the author reads, which is the
 * one place a mapping bug should be least visible until it is fixed.
 */
const rankWithinStep = (
  key: string,
  order: readonly string[]
): [number, number] => {
  const indexed = INDEXED.exec(key);
  const base = indexed ? indexed[1] : key;
  const position = order.indexOf(base);
  return [
    position === -1 ? order.length : position,
    indexed ? Number(indexed[2]) : -1
  ];
};

export const buildErrorSummary = ({
  errors,
  locate,
  resolveControl,
  order
}: ErrorSummaryInput): ErrorSummaryEntry[] =>
  Object.entries(errors)
    .map(([key, message]) => ({
      key,
      // Resolved HERE rather than stored resolved, so a reorder that rewrites
      // the key rewrites the number the author reads with it.
      message: resolveMessage(key, message),
      stepId: locate(key).tab,
      controlId: resolveControl(key)
    }))
    .sort((a, b) => {
      if (a.stepId !== b.stepId) {
        return a.stepId - b.stepId;
      }
      const [aField, aItem] = rankWithinStep(a.key, order);
      const [bField, bItem] = rankWithinStep(b.key, order);
      return aField === bField ? aItem - bItem : aField - bField;
    });

/**
 * The step the author should be taken to: the earliest one holding a problem,
 * so they work forwards rather than being sent to the last failure and back.
 *
 * This replaced `describeValidationFailure`, which returned this number AND a
 * sentence - "Please fix these fields: Title, Consent text". That sentence was
 * a second vocabulary: it named fields by a label held in `FIELD_LOCATIONS`
 * while the field itself showed the validator's message, so the banner and the
 * box disagreed about what was wrong with the same value. The summary below
 * renders the validator's own messages, and this function keeps the only half
 * of the old one that was ever about routing.
 */
export const firstStepHoldingError = (
  errors: Record<string, string>,
  locate: (key: string) => { tab: number }
): number | null => {
  const steps = Object.keys(errors).map((key) => locate(key).tab);
  return steps.length === 0 ? null : Math.min(...steps);
};

/**
 * The errors a given step is answerable for.
 *
 * Continue validates the step the author is standing on and nothing else: a
 * forward control that refused over a field three steps ahead would be
 * unfixable from where they are. `type` is the one exception and it is not an
 * arbitrary one - the type decides which steps EXIST, so continuing without it
 * is continuing to a step the form cannot name.
 */
export const errorsForStep = (
  errors: Record<string, string>,
  stepId: number,
  locate: (key: string) => { tab: number }
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(errors).filter(
      ([key]) => key === 'type' || locate(key).tab === stepId
    )
  );

/**
 * The reported-error map with this step's slice replaced by `fresh`.
 *
 * A refused Continue used to `setValidationErrors(...)` its own narrow object
 * wholesale, which erased what every other step had already been told about.
 * Merging is not right either: a key this step has just fixed has to go, or
 * the step keeps saying "Needs attention" over a corrected field.
 *
 * Only this step's slice moves. Nothing is invented about a step the author
 * has not reached, which matters because the stepper paints a REPORTED error
 * as "Needs attention" whether or not the step has been visited.
 */
export const replaceStepErrors = (
  previous: Record<string, string>,
  fresh: Record<string, string>,
  stepId: number,
  locate: (key: string) => { tab: number }
): Record<string, string> => {
  const belongsHere = (key: string) => key === 'type' || locate(key).tab === stepId;
  return {
    ...Object.fromEntries(
      Object.entries(previous).filter(([key]) => !belongsHere(key))
    ),
    ...Object.fromEntries(
      Object.entries(fresh).filter(([key]) => belongsHere(key))
    )
  };
};
