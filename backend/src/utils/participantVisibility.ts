/**
 * "Visible to a participant" - the shared status predicate for THREE call
 * sites (cto/AdaptaLabs#168): the participant branch of
 * GET /api/opportunities, POST /api/participate/visit and
 * POST /api/participate/opened/:opportunityId (participate.ts), so the three
 * cannot drift apart.
 *
 * It is NOT "every non-admin query must share". Other non-admin status
 * checks stay inline, deliberately, including (not exhaustively - no claim
 * of full coverage is made here) opportunities.ts's no-database mock
 * fallback, GET /:id's own gate (ahead of the exemptions it handles itself),
 * the sessions list route, the booking routes, and stats.ts. Folding those
 * in is out of scope for this constant.
 *
 * A participant can see a study only once it is `published` - not `draft`
 * (not yet visible), not `closed` (no longer accepting responses, but still
 * reachable directly for the exemptions GET /:id itself handles).
 *
 * A plain exported string, not a function, because every call site interpolates
 * it into a hand-built SQL string rather than calling a query builder - the
 * same idiom `opportunities.ts` and `participate.ts` already use throughout.
 * The alias is fixed at `o`, matching every current call site; a caller that
 * aliases the table differently cannot use this constant as-is, which is a
 * compile-time-invisible constraint worth stating rather than guessing at.
 * Parenthesised so it composes safely if a call site ever ANDs or ORs it into
 * a larger expression rather than pushing it as its own AND-ed condition.
 */
export const PARTICIPANT_VISIBLE_OPPORTUNITY_SQL = `(o.status = 'published')`;
