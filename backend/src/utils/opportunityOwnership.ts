/**
 * THE ONE PREDICATE ANSWERING "IS THIS CALLER THE OPPORTUNITY'S OWNER?".
 *
 * Six routes asked it with a bare `===` or `!==` against a row and a session
 * user (cto/AdaptaLabs#12). Each is a gate in front of participant data:
 * names, emails, business units, role titles, and a researcher's
 * `admin_notes` about a named colleague.
 *
 * WHAT THE BARE FORM ADMITS. `undefined !== undefined` is false, so a row
 * carrying no `owner_user_id` key and a session user carrying no `id` pass the
 * bare comparison TOGETHER, as owner. Not reachable through Postgres - every
 * call site names the column in its select list, so an ownerless row arrives
 * as `null` and `null !== undefined` refuses - and `SessionUser.id` is typed
 * non-optional. The database's shape and the type are the only two things
 * standing between that pair and a fail-open, and neither is a check.
 *
 * SO THIS IS DEFENCE IN DEPTH, NOT A BUG FIX, and it is written down as that.
 * No test can produce a row without the key while the query names it, so no
 * BEHAVIOURAL test can tell this predicate from the bare comparison at a call
 * site - a review gate reverted seven of them one at a time and every revert
 * passed all 884 tests. What the tests beside these routes pin is that the
 * gate is consulted at all, which is the failure that actually happened.
 *
 * THE SHAPE IS PINNED SEPARATELY, and it has to be, because that measurement
 * is exactly how a rule with twenty-five call sites and three canary anchors
 * comes quietly undone at the other twenty-two:
 * routes/__tests__/owner-comparisons-go-through-the-helper.test.ts scans the
 * route layer for a bare owner-to-caller comparison and fails by name if one
 * returns. It carries a control proving the scanner can still find one, and it
 * names what it does not read.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: the superadmin bypass. Every call site
 * that GRANTS one pairs this predicate with its own `isSuperadmin` term -
 * including `GET /api/bookings/opportunities/:id/bookings`, which refused a
 * superadmin until #79 widened it and moved its row under "the OPPORTUNITY
 * owner, or a superadmin" in the trust model in routes/firsthand.ts.
 *
 * `POST /api/bookings/:id/cancel` grants NONE, and that asymmetry survives:
 * it pairs this predicate with an `isAdmin` ROLE gate, so a superadmin who is
 * neither the participant nor the owner is refused. Named here because it is
 * now the only one, and an earlier version of this paragraph claimed the
 * roster was - a refute gate caught the replacement asserting there were none
 * at all. Pinned by `refuses a superadmin who does not own the opportunity`
 * in bookings.cancel-ownership.test.ts.
 *
 * Folding the bypass in here would make granting it a one-word edit in a file
 * no route review opens, and would hide from each call site the one decision
 * that site is making.
 *
 * Shaped as `(row, user)` rather than `(ownerId, callerId)` on purpose. Two
 * bare strings in the same order are exactly the pair a refactor swaps without
 * `tsc` noticing, and the types below make the swapped call a compile error
 * WHEN THE ROW IS TYPED. It is not when it comes straight off `pool.query`,
 * which returns `any` - so this is a guard rail, not a proof. It fails closed
 * either way: a `SessionUser` carries no `owner_user_id`, so a swapped call
 * returns false rather than granting.
 */

/**
 * Any query row that has selected `owner_user_id`.
 *
 * NAMED `OwnedOpportunityRow` AND NOT `OpportunityOwnerRow`, because
 * routes/opportunities.ts already declares a local type by that second name
 * with a different shape. Two structurally different contracts under one name,
 * one of them exported and one not, is how a future `import` silently widens
 * the row a gate is reading.
 *
 * `owner_user_id` is REQUIRED here, and nullable rather than optional: a row
 * that never selected the column is a caller bug, not a non-owner, and the
 * type is the only place that distinction can be made. It does not catch every
 * misuse - `pool.query` returns `any`, so an arbitrary row still satisfies it -
 * but it does make `isOpportunityOwner(req.user, row)` a compile error, since a
 * `SessionUser` has no `owner_user_id` at all.
 */
export interface OwnedOpportunityRow {
  owner_user_id: string | null;
}

/** The caller. Narrower than `SessionUser` so a partial stub still type-checks. */
export interface OwnershipCaller {
  id: string | null;
}

export function isOpportunityOwner(
  row: OwnedOpportunityRow | null | undefined,
  user: OwnershipCaller | null | undefined
): boolean {
  const ownerId = row?.owner_user_id;
  const callerId = user?.id;

  // "There is an owner, and it is the caller."
  //
  // NO SEPARATE `callerId &&` TERM, AND THAT IS DELIBERATE - it would be dead.
  // If `ownerId` is truthy and strictly equal to `callerId`, then `callerId`
  // is that same truthy value; there is no pair this catches that the two
  // terms below do not. Written down because the symmetric-looking form is
  // exactly what a later reader adds back "for safety", and because an
  // unreachable term is an unkillable mutation: the canary's own matrix
  // reported it SURVIVING every one of 883 tests, which is what a line no
  // input can distinguish looks like. Removed rather than documented as a
  // coverage gap it is not.
  //
  // `Boolean(...)` rather than returning the `&&` chain: the chain's value is
  // `undefined` or `''` on the absent paths, and a caller writing
  // `if (isOpportunityOwner(...) === false)` would then not match.
  return Boolean(ownerId && ownerId === callerId);
}
