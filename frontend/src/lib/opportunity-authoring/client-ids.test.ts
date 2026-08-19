import { describe, expect, it } from 'vitest';

import { mintClientId, withClientId, withClientIds, withoutClientIds } from './client-ids';

/**
 * The identity the question list keys on.
 *
 * Keyed on the array index, reordering re-keyed every card below the one that
 * moved, so React reused the DOM across different questions and uncommitted
 * keystrokes landed on the wrong one. These pin the two properties that fix
 * makes: an id is unique, and it survives everything except the item being
 * created.
 */
describe('mintClientId', () => {
  it('mints a different id every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintClientId()));

    expect(ids.size).toBe(200);
  });

  /**
   * `crypto.randomUUID` is secure-context only, so it is absent over plain
   * http - a dev server reached by IP, or an http staging host. The fallback
   * has to produce a real v4, not a `Math.random()` string: this value decides
   * which DOM node an author's keystrokes belong to.
   */
  it('falls back to getRandomValues when randomUUID is not there', () => {
    const insecure = crypto as { randomUUID?: () => string };
    const original = insecure.randomUUID;
    insecure.randomUUID = undefined;

    try {
      const id = mintClientId();

      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      insecure.randomUUID = original;
    }
  });

  /**
   * The shape assertion above is satisfied by a CONSTANT, and a constant is the
   * failure the fallback's own comment argues against - every card in the list
   * would share one identity, which is the index-keying defect wearing a uuid.
   * The uniqueness test beside it never reaches this branch, because
   * `crypto.randomUUID` exists in the test environment.
   */
  it('mints a different id every time on the fallback path too', () => {
    const insecure = crypto as { randomUUID?: () => string };
    const original = insecure.randomUUID;
    insecure.randomUUID = undefined;

    try {
      expect(new Set(Array.from({ length: 200 }, () => mintClientId())).size).toBe(200);
    } finally {
      insecure.randomUUID = original;
    }
  });
});

describe('withClientIds', () => {
  it('gives every item an id of its own', () => {
    const [first, second] = withClientIds([
      { type: 'open_text', prompt: 'Which tool slows you down?' },
      { type: 'rating', prompt: 'How happy are you with it?' }
    ]);

    expect(first._clientId).toEqual(expect.any(String));
    expect(second._clientId).toEqual(expect.any(String));
    expect(first._clientId).not.toBe(second._clientId);
  });

  /**
   * The one that matters. Re-minting on a second hydration would break exactly
   * what the id is for, and would make hasChanges() compare two arrays that
   * differ only in ids the author cannot see - a Save button that never leaves.
   */
  it('leaves an id that is already there alone', () => {
    const already = withClientId({ type: 'nps', prompt: 'Would you recommend us?' });

    expect(withClientIds([already])[0]._clientId).toBe(already._clientId);
  });
});

describe('withoutClientIds', () => {
  it('removes the id and nothing else', () => {
    const stripped = withoutClientIds([
      withClientId({
        type: 'single_choice',
        prompt: 'Which delivery option would you pick?',
        options: ['Standard', 'Next day'],
        is_required: true
      })
    ]);

    expect(stripped).toEqual([
      {
        type: 'single_choice',
        prompt: 'Which delivery option would you pick?',
        options: ['Standard', 'Next day'],
        is_required: true
      }
    ]);
    expect(Object.keys(stripped[0])).not.toContain('_clientId');
  });
});
