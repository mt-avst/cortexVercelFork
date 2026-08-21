import { z } from "zod";

/**
 * What identifies one authored question or task, for as long as it exists.
 *
 * Step ids used to be derived from array position - `${studyId}_step_${index +
 * 1}` - which meant they were not identity at all. Reordering four questions
 * regenerated exactly the same four ids against different prompts, so every
 * answer already collected moved to the question that now sat in its place.
 * Nothing surfaced it: there was no dangling reference to detect, and the
 * results view reported question 3's answers under question 1's prompt with a
 * mean, an NPS or a set of quotes that looked entirely ordinary.
 *
 * The fix is that identity is MINTED ONCE, by whoever creates the question, and
 * travels with it through every edit and every reorder. The authoring surface
 * already had such a value - B2's `_clientId`, minted per card so React could
 * key the list on something reordering does not change - and this module is
 * what promotes it from a rendering detail to the stored identity.
 *
 * Two halves, deliberately separated:
 *
 * - the KEY is what the author's client mints and sends. It is opaque to the
 *   server and means nothing outside its study.
 * - the ID is what is stored, and it is always `${studyId}_${key}`.
 *
 * The namespacing is not decoration and must not be dropped now that keys are
 * unique on their own. `firsthand.participant_responses.step_id` records which
 * question an answer was shown against, and a de-namespaced value would be
 * indistinguishable across studies without its session context - fine for
 * today's session-scoped reads, a footgun for any cross-study analysis. It is
 * also why the server namespaces rather than accepting a whole id from the
 * client: a caller cannot mint an id that claims to belong to another study.
 */

/**
 * The character set a key may use.
 *
 * Deliberately narrow. A key is concatenated into a stored id and compared as
 * plain text, so anything that could be confused with the `_` separator, or
 * that varies under normalisation, buys nothing and costs clarity. `crypto
 * .randomUUID()` - what the authoring surface mints - fits inside it, and so do
 * the positional ids studies already carry (`step_1`, `step_001`, `step_end`),
 * which is what lets an existing study keep every id it has.
 *
 * 64 characters is past a uuid with room to spare and far short of anything
 * that would make the composite primary key unwieldy.
 */
export const STEP_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const stepKeySchema = z
  .string()
  .regex(
    STEP_KEY_PATTERN,
    "A step key may use only letters, digits, hyphen and underscore, and must be 1 to 64 characters"
  );

/** The stored id for a question, given the study it belongs to and its key. */
export const stepIdFor = (studyId: string, stepKey: string): string =>
  `${studyId}_${stepKey}`;

/**
 * The key inside a stored id, or null when this id does not belong to this
 * study's namespace.
 *
 * Null is a real answer and callers must handle it rather than falling back to
 * the whole id: re-prefixing an id that was never namespaced would CHANGE it,
 * which is the one thing this module exists to prevent. The authoring form
 * treats a study containing one as not round-trippable and offers it read-only,
 * which is the same answer it already gives for anything else it cannot write
 * back unchanged.
 *
 * A study id is itself full of underscores (`study_<uuid>`), so this matches on
 * the prefix rather than splitting on the separator.
 */
export const stepKeyOf = (stepId: string, studyId: string): string | null => {
  const prefix = `${studyId}_`;

  if (!stepId.startsWith(prefix)) {
    return null;
  }

  const key = stepId.slice(prefix.length);

  return STEP_KEY_PATTERN.test(key) ? key : null;
};

/**
 * The id a step at this position will actually be stored under.
 *
 * The KEY is not the whole story, and that gap is what
 * `findDuplicateStepIdentity` exists to close. A list may mix keyed and
 * key-less items - a script, or a stale bundle, sends none - and a key-less
 * item falls back to `step_${index + 1}`. So `[{ no key }, { step_key:
 * "step_1" }]` derives `step_1` twice from two items whose KEYS do not collide
 * at all. `step_end` is the same trap against the completion marker every
 * expander appends.
 *
 * Kept here rather than in the two expanders so that the check and the
 * derivation cannot drift: if one changes how an id is formed, the other stops
 * detecting collisions in it, silently.
 */
const derivedKeyAt = (item: { step_key?: string }, index: number): string =>
  item.step_key ?? `step_${index + 1}`;

/**
 * The key the completion marker claims. Reserved, because `toSurveySteps` and
 * `toStudySteps` both append `${studyId}_step_end` after the authored list, and
 * an authored step claiming it would produce two rows with one primary key.
 */
const END_STEP_KEY = "step_end";

/**
 * Where a list of authored items would produce the same stored id twice.
 *
 * Two questions claiming one identity collapse to a single stored row - a saved
 * study quietly one question shorter, or an answer attached to whichever of the
 * two was written last. `validateSteps` in the repository already refuses
 * duplicate step ids, but it throws a bare Error that the routes answer as a
 * 500 with no field to point at. Reported here as well so the author gets a 400
 * naming the question.
 *
 * Over the DERIVED ids rather than over the keys, which is the correction a
 * review gate made to the first version of this: comparing keys alone missed
 * every collision between a key and a positional fallback, and those are the
 * ones a caller can actually construct.
 *
 * Returns the index of the SECOND occurrence, which is the one to point at.
 */
export const findDuplicateStepIdentity = (
  items: readonly { step_key?: string }[]
): { index: number; stepKey: string } | null => {
  const seen = new Set<string>([END_STEP_KEY]);

  for (const [index, item] of items.entries()) {
    const derived = derivedKeyAt(item, index);

    if (seen.has(derived)) {
      return { index, stepKey: derived };
    }

    seen.add(derived);
  }

  return null;
};

/**
 * Whether every authored item in this list carries a key.
 *
 * The question a write path has to answer before it decides whether the ids it
 * is about to store MEAN anything. A payload where every item carries one was
 * built by a client that tracks identity, so the ids it produces are
 * authoritative and a reorder is safe. A payload missing any of them came from
 * a client that cannot express identity - a script, or an SPA bundle older than
 * the backend serving it during a rolling deploy - and the ids it produces are
 * positional again, so the pre-F2 guards still apply to it.
 *
 * All-or-nothing rather than per-item, because a half-keyed list is a client
 * bug rather than a state worth supporting, and treating it as authoritative
 * would let the unkeyed half collide with whatever positional ids it derives.
 */
export const stepKeysAreComplete = (
  items: readonly { step_key?: string }[]
): boolean => items.length > 0 && items.every((item) => item.step_key !== undefined);

export const DUPLICATE_STEP_KEY_MESSAGE =
  "Two questions would be stored as one, because they share an identity. Reload the page and try again";
