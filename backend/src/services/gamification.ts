/**
 * Backend wrapper around the portable gamification service in `shared/services/gamification`.
 *
 * This module exists so existing backend callers (Express routes) can keep importing
 * from `../services/gamification` without threading a `Pool` through every call site.
 * It binds the backend's shared `pool` (see `../config`) as the first argument of each
 * shared function and re-exports the same types.
 *
 * The actual implementation lives in `shared/services/gamification.ts` so it can also be
 * used by the Vercel `api/` functions (which use their own pool from `api/db.ts`).
 */
import { pool } from '../config';
import * as gamification from '../../../shared/services/gamification';
import type { OpportunityType } from '../../../shared/types';

export type {
  UserProfile,
  Achievement,
  UserAchievement,
  PointsTransaction,
  LeaderboardEntry,
} from '../../../shared/services/gamification';

export async function getUserProfile(userId: string) {
  return gamification.getUserProfile(pool, userId);
}

export async function awardPoints(
  userId: string,
  opportunityType: OpportunityType,
  opportunityId: string,
  sessionId: string
) {
  return gamification.awardPoints(pool, userId, opportunityType, opportunityId, sessionId);
}

export async function getUserAchievements(userId: string) {
  return gamification.getUserAchievements(pool, userId);
}

export async function getLeaderboard(limit: number = 10) {
  return gamification.getLeaderboard(pool, limit);
}

export async function getMonthlyLeaderboard(limit: number = 10) {
  return gamification.getMonthlyLeaderboard(pool, limit);
}

export async function resetMonthlyPoints() {
  return gamification.resetMonthlyPoints(pool);
}

export async function getPointsHistory(userId: string, limit: number = 20) {
  return gamification.getPointsHistory(pool, userId, limit);
}

export async function awardPointsAfterApproval(
  userId: string,
  opportunityType: OpportunityType,
  opportunityId: string,
  sessionId: string,
  approvedBy: string
) {
  return gamification.awardPointsAfterApproval(pool, userId, opportunityType, opportunityId, sessionId, approvedBy);
}
