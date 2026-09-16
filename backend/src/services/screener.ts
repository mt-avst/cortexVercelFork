import type { Pool, PoolClient } from 'pg';

import type {
  Screener,
  ScreenerOutcome,
  ScreenerStatus,
} from '../../../shared/types';
import { ForbiddenError } from '../utils/errorHandler';

/**
 * The DB-touching half of the screener. The pure logic (validate, evaluate,
 * redact) lives in shared/screener.ts; this module holds the verdict store and
 * the enforcement gate the three apply chokepoints call.
 *
 * Every function takes a `Queryable` rather than reaching for the pool itself,
 * so the booking handler can run the gate inside its FOR UPDATE transaction on
 * the same client as its other checks, and the mint routes can pass the pool.
 */
type Queryable = Pool | PoolClient;

/**
 * The 403 sentence a chokepoint refuses with. Exported so tests assert the exact
 * message (errorHandler serialises AppError.message verbatim). One sentence for
 * both "never took the screener" and "was screened out": the participant UI
 * already knows which from screenerStatus, and the server gate only needs to
 * refuse.
 */
export const SCREENER_NOT_PASSED =
  'This study has a screener you need to pass before you can take part';

/** 400 when a participant submits answers to an opportunity that has no screener. */
export const SCREENER_NONE_TO_ANSWER = 'This study has no screener to answer';

/**
 * Whether an opportunity actually gates. A screener is present only when it has
 * at least one question - absence, null and an empty question list all mean "no
 * screener, anyone may take part".
 */
export function hasScreener(
  screener: Screener | null | undefined
): screener is Screener {
  return (
    !!screener &&
    Array.isArray(screener.questions) &&
    screener.questions.length > 0
  );
}

/** The participant's stored verdict, or null if they have not taken the screener. */
export async function readScreenerResponse(
  db: Queryable,
  opportunityId: string,
  userId: string
): Promise<{ outcome: ScreenerOutcome } | null> {
  const result = await db.query(
    `SELECT outcome
       FROM opportunity_screener_responses
      WHERE opportunity_id = $1 AND user_id = $2`,
    [opportunityId, userId]
  );
  if (result.rows.length === 0) {
    return null;
  }
  return { outcome: result.rows[0].outcome as ScreenerOutcome };
}

/**
 * The shared gate for the three apply chokepoints. A no-op when the opportunity
 * has no screener; otherwise refuses (403 ForbiddenError) anyone without a
 * stored 'qualified' verdict - whether they never took it or were screened out.
 *
 * FAILS CLOSED: any outcome other than the exact string 'qualified' refuses, so
 * a corrupt or unexpected row can never read as a pass.
 */
export async function assertScreenerPassed(
  db: Queryable,
  opportunityId: string,
  userId: string,
  screener: Screener | null | undefined
): Promise<void> {
  if (!hasScreener(screener)) {
    return;
  }
  const response = await readScreenerResponse(db, opportunityId, userId);
  if (!response || response.outcome !== 'qualified') {
    throw new ForbiddenError(SCREENER_NOT_PASSED);
  }
}

/**
 * Store the participant's verdict, latest answer wins (Nick's decision: a
 * screened-out participant may retake). questions_snapshot is the screener as it
 * was evaluated, so a later edit to the opportunity's screener cannot rewrite an
 * existing verdict.
 */
export async function upsertScreenerResponse(
  db: Queryable,
  args: {
    opportunityId: string;
    userId: string;
    outcome: ScreenerOutcome;
    answers: Record<string, string>;
    questionsSnapshot: unknown;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO opportunity_screener_responses
       (opportunity_id, user_id, outcome, answers, questions_snapshot)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (opportunity_id, user_id) DO UPDATE SET
       outcome = EXCLUDED.outcome,
       answers = EXCLUDED.answers,
       questions_snapshot = EXCLUDED.questions_snapshot,
       updated_at = NOW()`,
    [
      args.opportunityId,
      args.userId,
      args.outcome,
      JSON.stringify(args.answers),
      JSON.stringify(args.questionsSnapshot),
    ]
  );
}

/**
 * The signed-in participant's screener state for the opportunity payload.
 * Undefined when the opportunity has no screener (the field is then absent).
 */
export async function getScreenerStatus(
  db: Queryable,
  opportunityId: string,
  userId: string,
  screener: Screener | null | undefined
): Promise<ScreenerStatus | undefined> {
  if (!hasScreener(screener)) {
    return undefined;
  }
  const response = await readScreenerResponse(db, opportunityId, userId);
  return response
    ? { answered: true, outcome: response.outcome }
    : { answered: false };
}
