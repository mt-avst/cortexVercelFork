import type { WithClientId } from './client-ids';

/**
 * Keeping per-question validation errors pointing at the question they are
 * about, across a reorder.
 *
 * Errors are keyed by POSITION - `inline_survey_questions.2.prompt` - because
 * that is the only identity a question has in the banner that lists them. So
 * any change to the array can make every key below it wrong, and the form's
 * previous answer was to delete all of them on any change at all. Moving a
 * question the author had not yet fixed silently cleared the reason they were
 * being sent back to it, and the next Save refused for the same thing again.
 *
 * With a stable client id per item, the mapping is derivable rather than
 * guessed: an error follows its question to wherever the question went, and is
 * dropped only when its question was removed or when the author has edited it.
 */

/**
 * Key order is not stable across a spread that adds a field, so two objects
 * with identical content can serialise differently. Sorting first means only a
 * real content difference reads as one.
 *
 * Recursive, because the nested object this is applied to in practice is a
 * question's `config`, and that IS rebuilt by spread - `{ ...config, scale_max }`
 * appends the key when it was not already there. Sorting only the top level
 * would read that as an edit and throw the author's unfixed error away.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== '_clientId')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, canonical(nested)]);
  }
  return value;
};

const canonicalContent = (item: Record<string, unknown>): string =>
  JSON.stringify(canonical(item));

/**
 * `errors`, rewritten for the new order of `next`.
 *
 * The list-level key (`prefix` with no index) is always dropped: it says
 * something about the list as a whole - "add at least one question" - which any
 * structural change may just have resolved, and leaving it up would refuse a
 * save the author has already fixed.
 */
export const remapAuthoringErrors = <T extends object>(
  errors: Record<string, string>,
  prefix: string,
  previous: readonly WithClientId<T>[],
  next: readonly WithClientId<T>[]
): Record<string, string> => {
  const nextIndexById = new Map(next.map((item, index) => [item._clientId, index]));
  const remapped: Record<string, string> = {};

  for (const [key, message] of Object.entries(errors)) {
    if (key !== prefix && !key.startsWith(`${prefix}.`)) {
      remapped[key] = message;
      continue;
    }

    const indexed = new RegExp(`^${prefix}\\.(\\d+)\\.(.+)$`).exec(key);
    if (!indexed) {
      // The list-level key. Dropped, as above.
      continue;
    }

    const before = previous[Number(indexed[1])];
    if (!before) {
      continue;
    }

    const movedTo = nextIndexById.get(before._clientId);
    if (movedTo === undefined) {
      // Its question was removed, so the error is about nothing.
      continue;
    }

    // Edited, so the author has acted on it. Keeping it would sit a stale
    // refusal beside a field they have just corrected.
    if (canonicalContent(before) !== canonicalContent(next[movedTo])) {
      continue;
    }

    remapped[`${prefix}.${movedTo}.${indexed[2]}`] = message;
  }

  return remapped;
};
