/**
 * Which opportunity shapes can ask a participant questions, and where they are
 * answered.
 *
 * One module with no dependencies, because the answer is needed by the publish
 * rule, the API boundary, the authoring wizard and the participant's own call
 * to action - and the version of it that existed before was
 * `(type === 'poll' || type === 'survey') && deliveryMode === 'native'`,
 * written out at fourteen sites that all had to agree and had no way to notice
 * when they stopped.
 *
 * #78 is the change that proved the point: adding `question` to that set meant
 * editing every one of those sites, and the cost of missing one is not a
 * compile error. It is a published opportunity whose author was told it was
 * ready and whose participant meets a control that does nothing.
 */

/**
 * The types whose participant can be asked questions at all.
 *
 * Not "the types that run natively": each of these can ALSO hand off to an
 * external tool, and which one it does is `delivery_mode`. A recorded study is
 * absent because its participant answers out loud into a capture, and the two
 * bookable types are absent because their questions are asked by a human on a
 * call.
 *
 * `question` joined this set in #78. Before that it was external by
 * construction rather than by choice - it kept the External Link step
 * unconditionally and there was no runner for it, so a "One question"
 * opportunity always sent its participant to a third party and Cortex got back
 * a click count.
 */
export const QUESTION_CARRYING_TYPES: ReadonlySet<string> = new Set([
  "poll",
  "survey",
  "question"
]);

export type QuestionCarryingType = "poll" | "survey" | "question";

/**
 * The same membership test, narrowing.
 *
 * Exists because a `Set<string>.has()` tells TypeScript nothing: the authoring
 * form reads its new type off a change handler typed as
 * `string | number | boolean | undefined`, and writing that into state needs
 * the literal union back. The alternative was a hardcoded
 * `value === 'poll' || value === 'survey' || value === 'question'` at the one
 * site that assigns - which is the drift this module exists to remove, in the
 * one place a missed edit is invisible until an author loses their work.
 */
export const isQuestionCarryingType = (
  value: unknown
): value is QuestionCarryingType =>
  typeof value === "string" && QUESTION_CARRYING_TYPES.has(value);

/**
 * Whether this opportunity is answered INSIDE Cortex, in SurveyRunner.
 *
 * Both halves are load-bearing and neither implies the other. A type outside
 * the set carrying `delivery_mode: 'native'` is not a native anything - the
 * column defaults per row and nothing clears it when the type changes - and a
 * poll set to external delivery keeps whatever study it once had linked, so
 * the mode alone would let a stale link run.
 *
 * Takes the mode as it comes off the row or the form: `undefined` and `null`
 * both mean external, which is the column default and every pre-#79 row.
 */
export const runsNativeSurvey = (
  type: string,
  deliveryMode: string | null | undefined
): boolean =>
  QUESTION_CARRYING_TYPES.has(type) && (deliveryMode ?? "external") === "native";
