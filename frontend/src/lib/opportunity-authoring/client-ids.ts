/**
 * A stable client-side identity for one authored question or task.
 *
 * The list used to be keyed on the array index. Reordering re-keyed every card
 * below the one that moved, so React reused the DOM across different questions
 * and uncommitted keystrokes landed on the wrong one - the author typed into
 * question 3 and the text appeared under question 5's prompt.
 *
 * F2 PROMOTED IT. It used to be stated here that this id never leaves the
 * browser; it does now, as the payload's `step_key`, and it is what the stored
 * `study_steps.id` is derived from. The reasoning is the same reasoning
 * enlarged: an identity that survives a reorder in the DOM is exactly the
 * identity that has to survive a reorder in the database, and minting a second
 * one beside it would be two knobs for one fact. See
 * `shared/firsthand/step-identity.ts` for the stored half, and
 * `withStoredIdentity` in `hydrate-study.ts` for how an existing study's
 * identity is recovered into this field.
 *
 * The FIELD still never leaves the browser: `surveyQuestionSchema` is
 * `.strict()` and would refuse a question carrying `_clientId`, so the payload
 * builders in `hydrate-study.ts` list the fields they send rather than
 * spreading the item, and copy the value into `step_key` by hand. A test
 * mutates that mapper to a spread to prove the guard is the reason the field
 * stays behind, not an accident of shape.
 */

/** An authored item with the identity the list keys on. */
export type WithClientId<T> = T & { _clientId: string };

/**
 * A v4 uuid, with the same fallback `StudyEditor` mints study ids through.
 *
 * `crypto.randomUUID` is secure-context only, so it is absent over plain http -
 * a dev server reached from another machine by IP, or an http staging host.
 * Calling it unguarded would throw during render and take the whole authoring
 * surface down with it. The fallback uses `crypto.getRandomValues`, which is
 * available in insecure contexts, rather than `Math.random()`: this value
 * decides which DOM node an author's keystrokes belong to, and a generator that
 * collides would reintroduce exactly the defect the id exists to fix.
 */
export const mintClientId = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10x
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
};

const hasClientId = <T extends object>(item: T): item is WithClientId<T> =>
  typeof (item as { _clientId?: unknown })._clientId === 'string';

/** One item, given an identity it did not have. */
export const withClientId = <T extends object>(item: T): WithClientId<T> => ({
  ...item,
  _clientId: mintClientId()
});

/**
 * A hydrated list, given identities.
 *
 * Items that already carry one keep it. That branch is not reachable from
 * today's only two call sites - both pass freshly built objects - so it is a
 * property of the helper rather than a live guard, and it is tested as one.
 * It matters the moment anything hydrates twice: re-minting would break the
 * very thing the id is for, and would leave `hasChanges()` comparing two arrays
 * that differ only in ids the author cannot see.
 */
export const withClientIds = <T extends object>(items: readonly T[]): WithClientId<T>[] =>
  items.map((item) => (hasClientId(item) ? item : withClientId(item)));

/**
 * The same list with the ids taken back off, for comparing authored content.
 *
 * `hasChanges()` compares serialised form state against the baseline captured
 * at load. Both carry ids today because the baseline is cloned from the
 * hydrated array, but that is a coincidence of one call site: anything that
 * re-hydrates one side and not the other would pin the Save button on forever
 * with nothing to save.
 */
export const withoutClientIds = <T extends object>(
  items: readonly WithClientId<T>[]
): T[] =>
  items.map((item) => {
    const { _clientId: _ignored, ...rest } = item;
    return rest as unknown as T;
  });
