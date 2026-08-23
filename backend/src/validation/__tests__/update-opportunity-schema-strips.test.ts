import { describe, it, expect } from '@jest/globals';
import { UpdateOpportunitySchema } from '../schemas';

/**
 * `PATCH /api/opportunities/:id` HAS THE SAME RAW-KEY INTERPOLATION THAT
 * `PATCH /api/sessions/:id` HAD.
 *
 * routes/opportunities.ts builds its SET clause the same way - the request
 * body's KEYS go into the statement and only the values are bound. That route
 * is safe today for one reason and one reason only: `validateRequest` does
 * `req.body = schema.parse(req.body)`, and a bare `z.object` STRIPS unknown
 * keys. The stripping is a side effect of the schema's default mode, not a
 * decision anyone recorded, and nothing asserted it.
 *
 * A security gate measured what that costs: changing the schema to
 * `.passthrough()` passed 958 of 958 tests AND reopened the injection - the
 * gate drove the real handler and captured
 *
 *   UPDATE opportunities
 *   SET title = (SELECT email FROM users ORDER BY created_at LIMIT 1), ...
 *
 * coming back through the handler's own `RETURNING *`.
 *
 * So this file exists to make that one word fail by name. `.passthrough()`,
 * `.catchall()`, or a migration away from zod all break these tests instead of
 * silently reopening a SQL injection on a live route.
 *
 * WHAT THIS IS NOT. It is not the fix. The fix is the runtime allow-list -
 * `UPDATABLE_OPPORTUNITY_COLUMNS` in routes/opportunities.ts, landed after this
 * file and pinned by `opportunities.patch-column-allowlist.test.ts`. A schema
 * is a parser, and relying on a parser's default mode to be a security control
 * is the same shape of mistake as relying on a TYPE annotation, which is what
 * made the sessions hole invisible.
 *
 * So this file is now the SECOND layer, not the only one, and it is still worth
 * having: the two fail for different reasons. Flip the schema to
 * `.passthrough()` and these tests fail; delete the allow-list and they do not,
 * which is exactly why the allow-list needed its own tests rather than this
 * one being counted as coverage of it.
 */
describe('UpdateOpportunitySchema strips unknown keys', () => {
  // THE CONTROL. If the schema stopped parsing altogether, or these tests were
  // pointed at the wrong export, every absence assertion below would pass by
  // having nothing to strip.
  it('parses and returns the fields it does know', () => {
    const parsed = UpdateOpportunitySchema.parse({ title: 'A study' }) as Record<string, unknown>;

    expect(parsed.title).toBe('A study');
  });

  it('drops a key carrying SQL, which is what keeps the SET clause safe', () => {
    const injected =
      'title = (SELECT email FROM users ORDER BY created_at LIMIT 1), purpose_one_liner';

    const parsed = UpdateOpportunitySchema.parse({
      title: 'A study',
      [injected]: 'x',
    }) as Record<string, unknown>;

    expect(Object.keys(parsed)).not.toContain(injected);
    // Asserted as the whole key set, not just the absence of that one string:
    // `.passthrough()` admits EVERY unknown key, so pinning one is pinning a
    // symptom.
    expect(Object.keys(parsed)).toEqual(['title']);
  });

  it('drops real columns the caller has no business setting', () => {
    const parsed = UpdateOpportunitySchema.parse({
      title: 'A study',
      owner_user_id: 'someone-else',
      id: 'another-opportunity',
      created_at: '1970-01-01',
    }) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual(['title']);
  });

  it('strips rather than throwing, which is the behaviour the route depends on', () => {
    // Worth pinning the DIRECTION too. If the schema were made `.strict()` it
    // would throw instead of stripping, and the route would start 400ing on
    // bodies it accepts today - a different break, but a break.
    expect(() => UpdateOpportunitySchema.parse({ title: 'A study', unknown_key: 1 })).not.toThrow();
  });
});
