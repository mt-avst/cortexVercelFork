import { describe, it, expect } from '@jest/globals';
import { isOpportunityOwner } from '../opportunityOwnership';

/**
 * MOST OF THE SHAPES BELOW ARE ONES THE TYPES FORBID, and that is the point.
 *
 * `OwnedOpportunityRow.owner_user_id` and `OwnershipCaller.id` are REQUIRED,
 * so that `isOpportunityOwner(user, row)` is a compile error. That makes an
 * absent field unsayable in TypeScript - while remaining perfectly sayable in
 * JavaScript, which is what every `pool.query` row actually is at runtime.
 *
 * So the absent cases are cast through `unknown`. Casting to reach a shape the
 * type forbids is usually a smell; here it is the only way to test the runtime
 * contract of a function whose whole job is refusing shapes the schema is not
 * supposed to be able to produce. Named rather than left looking careless.
 *
 * A NOTE FOR WHOEVER RUNS THE CHECKS: this file is invisible to
 * `tsc -p backend/tsconfig.json`, which excludes `__tests__`. Making these
 * fields required broke this suite while that command AND `npm run lint` both
 * stayed at exit 0, and jest reported "883 passed, 883 total" with the suite
 * failing to LOAD. `npm run typecheck` is the one that reads test files.
 */
const row = (value?: unknown) =>
  (value === undefined ? {} : { owner_user_id: value }) as Parameters<typeof isOpportunityOwner>[0];
const caller = (value?: unknown) =>
  (value === undefined ? {} : { id: value }) as Parameters<typeof isOpportunityOwner>[1];

/**
 * The predicate itself. The routes that USE it are pinned beside them - what
 * is pinned here is that it refuses the shapes a bare `===` admits, which is
 * the whole reason it exists rather than being inlined six times.
 */
describe('isOpportunityOwner', () => {
  it('accepts the owner', () => {
    expect(isOpportunityOwner({ owner_user_id: 'u1' }, { id: 'u1' })).toBe(true);
  });

  it('refuses a different admin', () => {
    expect(isOpportunityOwner({ owner_user_id: 'u1' }, { id: 'u2' })).toBe(false);
  });

  // THE CONTROL FOR EVERY CASE BELOW. Each of these pairs passes a bare
  // `row.owner_user_id === user.id`, so a helper that had simply moved the
  // bare comparison behind a function name would return true for all of them
  // and this block would be the only thing that noticed.
  it('refuses an ownerless row and an id-less caller, which a bare === pairs', () => {
    expect(isOpportunityOwner(row(), caller())).toBe(false);
    // Proving the arm above is about ABSENCE and not about the empty objects:
    // the same bare comparison these routes used returns true for that pair.
    const bare = (
      r: { owner_user_id?: string | null },
      u: { id?: string | null }
    ) => r.owner_user_id === u.id;
    expect(bare({}, {})).toBe(true);
  });

  it('refuses a null owner against a null caller id', () => {
    expect(isOpportunityOwner(row(null), caller(null))).toBe(false);
  });

  it('refuses two empty strings, which are equal and are not an identity', () => {
    expect(isOpportunityOwner(row(''), caller(''))).toBe(false);
  });

  it('refuses an id that merely coerces to the owner id', () => {
    // `===`, not `==`. The types forbid a numeric id, so this pair cannot
    // arrive through `SessionUser` today - but `==` survives every other
    // assertion in this file, and a comparison that accepts coercion is not
    // the one an authorisation gate should be built on. Cast through
    // `unknown` because the point is a shape the type does not describe.
    expect(isOpportunityOwner(row('0'), caller(0))).toBe(false);
  });

  it('refuses when only one side is present', () => {
    expect(isOpportunityOwner(row('u1'), caller())).toBe(false);
    expect(isOpportunityOwner(row(), caller('u1'))).toBe(false);
  });

  it('refuses a missing row or a missing caller outright', () => {
    expect(isOpportunityOwner(null, caller('u1'))).toBe(false);
    expect(isOpportunityOwner(undefined, caller('u1'))).toBe(false);
    expect(isOpportunityOwner(row('u1'), null)).toBe(false);
    expect(isOpportunityOwner(row('u1'), undefined)).toBe(false);
  });

  it('returns a real boolean, not the falsy operand', () => {
    // `row.owner_user_id && caller.id && ...` evaluates to `undefined` here,
    // and `undefined === false` is false. A caller comparing against `false`
    // would silently stop matching.
    expect(isOpportunityOwner(row(), caller('u1'))).toBe(false);
    expect(Object.is(isOpportunityOwner(row(), caller('u1')), false)).toBe(true);
  });
});
