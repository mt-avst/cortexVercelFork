import type { Pool, PoolClient } from 'pg';
import { Router, Request, Response, IRouter } from 'express';
import { pool } from '../config';
import { requireAuth } from '../middleware/authenticate';
import { perUserLimiter } from '../middleware/per-user-rate-limit';
import { asyncHandler, AppError, NotFoundError } from '../utils/errorHandler';
import { isDatabaseAvailable } from '../utils/database';
import { PARTICIPANT_VISIBLE_OPPORTUNITY_SQL } from '../utils/participantVisibility';

const router: IRouter = Router();

/**
 * "New since your last visit" (cto/AdaptaLabs#168).
 *
 * How long a gap between two calls counts as the visit having ENDED, rather
 * than the same visit continuing (a refresh, or a trip into a study and back
 * via the browser's own navigation). Named per the decision (2026-09-24):
 * badges must survive a refresh, so the cutoff only moves once a visit has
 * genuinely finished, not on every call.
 *
 * ponytail: a single fixed gap for every caller, not configurable per user or
 *   per deployment.
 *   -> raise if a real session genuinely idles past 30 minutes mid-visit and
 *      loses its badges as a result; no report of that yet.
 *
 * ponytail: measured from the last POST /api/participate/visit call, which
 *   fires once per Participate mount, not from the participant's last
 *   activity anywhere on the site (cto/AdaptaLabs#168). A study session that
 *   runs longer than the gap and then returns to Participate reads as a
 *   30-minute-plus absence and rolls the cutoff forward, which can clear
 *   badges on OTHER studies the participant never opened. This is the
 *   literal spec ("30 minutes away" from Participate), kept as specified
 *   rather than widened pre-emptively.
 *   -> if that surfaces as a real complaint, the fix is a second signal
 *      (a heartbeat from the study-detail page, or from an in-flight
 *      session) touching `last_seen_at` without ending the visit.
 */
export const PARTICIPATE_VISIT_GAP_MINUTES = 30;

/**
 * POST /api/participate/visit - contract
 *
 * Auth: requireAuth (any signed-in user - participant or admin browsing
 * Participate). Body: none. Response 200:
 *   { newOpportunityIds: string[] }
 * Errors: 401 (no session), 429 (rate limit), 503 (no database), 500.
 *
 * ATOMICITY. One statement: a CTE wraps the INSERT ... ON CONFLICT DO UPDATE
 * that decides the cutoff, and the SELECT reading "new since" runs against
 * that CTE's own output rather than a value read back into JS and rebound
 * into a second query - one round trip, and the read cannot disagree with
 * the write that computed it. Two tabs calling this
 * within the same instant cannot each read a stale `last_seen_at` and both
 * decide the gap has elapsed - the row lock the upsert takes serialises them.
 * The CASE inside the DO UPDATE SET is what tells "just touch last_seen_at"
 * apart from "a visit just ended, roll previous_visit_end_at forward":
 *   - no row yet: insert last_seen_at = now(), previous_visit_end_at = null
 *   - row, and now() - last_seen_at > the gap: previous_visit_end_at takes
 *     the OLD last_seen_at (the moment the visit that just ended was last
 *     seen), then last_seen_at = now()
 *   - row, gap not elapsed: last_seen_at = now() only; previous_visit_end_at
 *     is left exactly where it was
 *
 * NEW LIST. A null cutoff (first-ever visit, or a visit that has never yet
 * ended) answers `[]` - the decision's "first visit: nothing is marked" and
 * "moves only once a visit has ended". Otherwise: every opportunity visible
 * to a participant on Participate (`PARTICIPANT_VISIBLE_OPPORTUNITY_SQL`,
 * utils/participantVisibility.ts - the SAME predicate GET /api/opportunities
 * applies for a non-admin caller, see that route's `else if (!isAdmin)`
 * branch; this endpoint does not widen it for an admin caller, because the
 * badge it feeds describes the Participate page, not an admin's own studies
 * table) with `published_at` after the cutoff and no
 * open recorded by this user (`participant_study_opens`, see
 * POST /opened/:opportunityId below) at or after `published_at` - opening a
 * study clears its badge, the decision's "Opening a study clears its badge".
 *
 * WITHIN ONE VISIT (before it ends), calling this again answers the SAME
 * list as the first call minus anything opened in between - not `[]`. `[]`
 * only comes back while `previous_visit_end_at` is still null, i.e. before
 * any gap has ever elapsed for this user.
 */

/**
 * The statement above, as a function so a test can run it inside one
 * transaction on a controlled connection instead of against the pool -
 * `db` accepts anything with a `.query` method (the pool itself, or a
 * `PoolClient` checked out of a `BEGIN`/`ROLLBACK` the caller owns), with
 * behaviour otherwise unchanged. The route below is the only production
 * caller, and it passes `pool`.
 */
export async function recordVisitAndListNew(
  db: Pick<Pool, 'query'> | PoolClient,
  userId: string
): Promise<string[]> {
  // ponytail: no LIMIT on the new-ids read.
  //   -> bounded today only by the same operational ceiling GET
  //   /api/opportunities enforces on itself (MAX_OPPORTUNITIES_RETURNED,
  //   1000): the platform never carries more published studies than that
  //   without the list route itself already refusing to serve them. If
  //   that ceiling is ever lifted, revisit this query too.
  const result = await db.query(
    `
    WITH v AS (
      INSERT INTO participate_visits (user_id, last_seen_at, previous_visit_end_at)
      VALUES ($1, NOW(), NULL)
      ON CONFLICT (user_id) DO UPDATE SET
        previous_visit_end_at = CASE
          WHEN NOW() - participate_visits.last_seen_at > make_interval(mins => $2)
            THEN participate_visits.last_seen_at
          ELSE participate_visits.previous_visit_end_at
        END,
        last_seen_at = NOW()
      RETURNING previous_visit_end_at AS cutoff
    )
    SELECT o.id
    FROM opportunities o, v
    WHERE v.cutoff IS NOT NULL
      AND ${PARTICIPANT_VISIBLE_OPPORTUNITY_SQL}
      AND o.published_at > v.cutoff
      AND NOT EXISTS (
        SELECT 1 FROM participant_study_opens pso
        WHERE pso.opportunity_id = o.id
          AND pso.user_id = $1
          AND pso.opened_at >= o.published_at
      )
    `,
    [userId, PARTICIPATE_VISIT_GAP_MINUTES]
  );

  return result.rows.map((row) => String(row.id));
}

router.post(
  '/visit',
  requireAuth,
  perUserLimiter(30, 'Too many visit checks in a short time. Wait a minute and try again.'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!(await isDatabaseAvailable())) {
      throw new AppError('Database not available.', 503);
    }

    const newOpportunityIds = await recordVisitAndListNew(pool, req.user.id);

    res.json({ newOpportunityIds });
  })
);

/**
 * POST /api/participate/opened/:opportunityId - contract
 *
 * Auth: requireAuth (any signed-in user). Params: opportunityId (a uuid -
 * see below). Body: none. Response 200: { ok: true }.
 * Errors: 401 (no session), 400 (opportunityId is not a well-formed uuid -
 *   the database rejects the literal with 22P02 and the shared error handler
 *   maps that to a 400, the same path GET /:id and POST /:id/click already
 *   rely on rather than a separate regex check here), 404 (no such study, or
 *   it exists but is not currently visible to a participant), 429 (rate
 *   limit), 503 (no database), 500.
 *
 * Records that THIS user has opened THIS study, clearing its "New" badge
 * (cto/AdaptaLabs#168). `opportunity_clicks` cannot serve this on its own:
 * POST /:id/click refuses a `view` click for every type except
 * poll/survey/unmoderated (opportunities.ts), so a test/interview/question
 * study's badge would never clear - and widening that gate was ruled out
 * because it would change what GET /:id/analytics counts for those types.
 * This route is a dedicated
 * record instead, called by the frontend on the same "study details opened"
 * event for every type, not only the three the click route accepts.
 *
 * ONE upsert. The SELECT feeding the INSERT is scoped to `o.id = $2` AND
 * `PARTICIPANT_VISIBLE_OPPORTUNITY_SQL` (utils/participantVisibility.ts, the
 * same "is this study currently visible to a participant" predicate as
 * /visit above), so existence and visibility are proven in the same statement
 * that records the open - zero rows means either the id does not exist or the
 * study is not currently published, and both answer 404 without this route
 * needing to tell them apart (a caller
 * who cannot see a draft or closed study by its id from GET /:id or the
 * list cannot infer it exists from this route's response either).
 * ON CONFLICT (user_id, opportunity_id) DO UPDATE so a study that is
 * unpublished and later republished clears its badge again the next time it
 * is opened, matching how `published_at` itself re-arms on a genuine
 * draft->published transition (see opportunities.ts).
 */
router.post(
  '/opened/:opportunityId',
  requireAuth,
  // Fires once per study a participant opens rather than once per Participate
  // mount (contrast /visit's 30/min above), so the ceiling is set higher: a
  // person scanning a page of "New" badges and opening several in a row is
  // real, ordinary use, and this is a single-row upsert with no fan-out - not
  // a quota, a backstop against a scripted loop. 60 a minute is still well
  // above anything a person clicking through cards can produce.
  perUserLimiter(60, 'Too many studies opened in a short time. Wait a minute and try again.'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!(await isDatabaseAvailable())) {
      throw new AppError('Database not available.', 503);
    }

    const { opportunityId } = req.params;

    const result = await pool.query(
      `
      INSERT INTO participant_study_opens (user_id, opportunity_id, opened_at)
      SELECT $1, o.id, NOW()
      FROM opportunities o
      WHERE o.id = $2 AND ${PARTICIPANT_VISIBLE_OPPORTUNITY_SQL}
      ON CONFLICT (user_id, opportunity_id) DO UPDATE SET opened_at = NOW()
      RETURNING opportunity_id
      `,
      [req.user.id, opportunityId]
    );

    if (result.rowCount === 0) {
      throw new NotFoundError('Study');
    }

    res.json({ ok: true });
  })
);

export default router;
