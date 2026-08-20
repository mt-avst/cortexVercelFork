import { withoutClientIds } from './client-ids';

/**
 * The whole form as one comparable string, for the one question the exit
 * control asks: would leaving now throw something away.
 *
 * Every field, spread rather than enumerated, deliberately. The form's
 * `hasChanges` lists its comparisons because it decides whether to OFFER a
 * save, and that list has already been wrong twice - each time hiding the Save
 * button from an author who had changed something real. A list that must not
 * drift is a worse instrument than one that cannot: this compares the object,
 * so a field added tomorrow is covered on the day it is added.
 *
 * Client ids are stripped for the same reason `hasChanges` strips them: they
 * are minted per hydration, and the two sides match today only because both
 * came from one clone. Anything that re-hydrated one side and not the other
 * would report unsaved work forever, and the confirmation would become the
 * dialog everyone clicks through without reading.
 *
 * Typed structurally rather than against the form's state type, which is
 * declared inside the component and not exported.
 */
type AuthoredItem = Record<string, unknown> & { _clientId?: string };

export interface DirtyComparableForm {
  inline_survey_questions: readonly AuthoredItem[];
  inline_study_steps: readonly AuthoredItem[];
  [field: string]: unknown;
}

/**
 * `withoutClientIds` is typed for the arrays the form actually holds, where the
 * id is present. This comparison accepts items without one - a baseline built
 * by hand, or an array that has not been hydrated yet - and both cases strip to
 * the same thing, so the widening is safe rather than merely convenient.
 */
const strip = (items: readonly AuthoredItem[]): Record<string, unknown>[] =>
  withoutClientIds(items.map((item) => ({ _clientId: '', ...item })));

export const dirtySignature = (data: DirtyComparableForm): string =>
  JSON.stringify({
    ...data,
    inline_survey_questions: strip(data.inline_survey_questions),
    inline_study_steps: strip(data.inline_study_steps)
  });

/**
 * Whether two states of the form differ in anything worth warning about.
 */
export const hasUnsavedChanges = (
  current: DirtyComparableForm,
  baseline: DirtyComparableForm
): boolean => dirtySignature(current) !== dirtySignature(baseline);
