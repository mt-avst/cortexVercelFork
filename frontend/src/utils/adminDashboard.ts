/**
 * Derivations for the Admin dashboard (Admin.tsx).
 *
 * Every value here is computed from data the frontend already fetches -
 * `getOpportunities()` (which carries `sessions[]`) and `getDashboardStats()`.
 * Nothing here invents a field the backend does not return: the redesign
 * deliberately omits the recruitment-target, session-ordinal and overdue-count
 * ideas from the wireframe because no real data backs them yet.
 *
 * `now` is passed in rather than read from the clock so these stay pure and
 * unit-testable. The one exception is presentational countdown text at render
 * time, which reuses the existing `getTimeRemainingUntil` in opportunityUtils.
 */
import { Opportunity, Session } from '../api/types';
import { getClosingTime } from './opportunityUtils';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Booked vs capacity across a study's sessions. Null when it has no sessions. */
export interface Recruitment {
  booked: number;
  capacity: number;
  /** 0-100, rounded. 0 when capacity is 0. */
  pct: number;
}

export const getRecruitment = (opportunity: Opportunity): Recruitment | null => {
  const sessions = opportunity.sessions ?? [];
  if (sessions.length === 0) return null;

  const capacity = sessions.reduce((sum, s) => sum + s.capacity, 0);
  const booked = sessions.reduce((sum, s) => sum + (s.booked_count || 0), 0);
  const pct = capacity > 0 ? Math.round((booked / capacity) * 100) : 0;

  return { booked, capacity, pct };
};

/** The soonest session that starts at or after `now`. Null if none upcoming. */
export const getNextSession = (opportunity: Opportunity, now: Date): Session | null => {
  const upcoming = (opportunity.sessions ?? [])
    .filter((s) => {
      const start = new Date(s.start_time).getTime();
      return !isNaN(start) && start >= now.getTime();
    })
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  return upcoming[0] ?? null;
};

/**
 * Monday 00:00 (local) of the week containing `now`, and the Monday after.
 * "This week" is a calendar week, not a rolling 7 days, so the count matches
 * what an admin sees on a Monday-anchored calendar.
 */
export const weekBounds = (now: Date): { start: Date; end: Date } => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // getDay(): 0=Sun..6=Sat. Shift back to Monday.
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
};

export interface SessionsThisWeek {
  total: number;
  upcoming: number;
  completed: number;
}

/**
 * Sessions across all studies whose start falls in the current calendar week.
 * `upcoming` = not yet ended; `completed` = already ended. A session mid-run
 * (started, not ended) counts as upcoming, matching "still to deal with".
 */
export const getSessionsThisWeek = (
  opportunities: Opportunity[],
  now: Date,
): SessionsThisWeek => {
  const { start, end } = weekBounds(now);
  let total = 0;
  let completed = 0;

  for (const opp of opportunities) {
    for (const s of opp.sessions ?? []) {
      const startMs = new Date(s.start_time).getTime();
      if (isNaN(startMs) || startMs < start.getTime() || startMs >= end.getTime()) continue;
      total += 1;
      const endMs = new Date(s.end_time).getTime();
      if (!isNaN(endMs) && endMs < now.getTime()) completed += 1;
    }
  }

  return { total, upcoming: total - completed, completed };
};

/**
 * Published studies whose closing time is within `withinDays` and still in the
 * future. Uses `getClosingTime` (end_date, or last session end as fallback) so
 * a study sorts and warns on the same deadline it displays.
 */
export const getStudiesClosingSoon = (
  opportunities: Opportunity[],
  now: Date,
  withinDays = 3,
): Opportunity[] => {
  const horizon = now.getTime() + withinDays * MS_PER_DAY;
  return opportunities.filter((opp) => {
    if (opp.status !== 'published') return false;
    const closesAt = getClosingTime(opp);
    if (!closesAt) return false;
    const t = closesAt.getTime();
    return t > now.getTime() && t <= horizon;
  });
};

/** Every session slot is at or over capacity, and there is at least one. */
export const isFullyBooked = (opportunity: Opportunity): boolean => {
  const r = getRecruitment(opportunity);
  return r !== null && r.capacity > 0 && r.booked >= r.capacity;
};

/** Published, has session capacity, and not yet full. Open-slot semantics. */
export const needsRecruitment = (opportunity: Opportunity): boolean => {
  if (opportunity.status !== 'published') return false;
  const r = getRecruitment(opportunity);
  return r !== null && r.capacity > 0 && r.booked < r.capacity;
};

export type QuickFilter = 'needs-recruitment' | 'draft' | 'closing-soon' | 'fully-booked';

export const matchesQuickFilter = (
  opportunity: Opportunity,
  filter: QuickFilter,
  now: Date,
): boolean => {
  switch (filter) {
    case 'needs-recruitment':
      return needsRecruitment(opportunity);
    case 'draft':
      return opportunity.status === 'draft';
    case 'closing-soon':
      return getStudiesClosingSoon([opportunity], now, 3).length === 1;
    case 'fully-booked':
      return isFullyBooked(opportunity);
    default:
      return false;
  }
};

/**
 * What to show in the table's "Next session / deadline" column, chosen from
 * real data only:
 *  - `session`   the soonest upcoming slot's start
 *  - `deadline`  no upcoming slot, but a future closing time (end_date, or the
 *                last session end via getClosingTime)
 *  - `completed` a closing time that has already passed
 *  - null        nothing to anchor to (no sessions, no end_date)
 */
export type NextMilestone =
  | { kind: 'session'; date: Date }
  | { kind: 'deadline'; date: Date }
  | { kind: 'completed'; date: Date };

export const getNextMilestone = (opportunity: Opportunity, now: Date): NextMilestone | null => {
  const next = getNextSession(opportunity, now);
  if (next) return { kind: 'session', date: new Date(next.start_time) };

  const closesAt = getClosingTime(opportunity);
  if (!closesAt) return null;

  return closesAt.getTime() > now.getTime()
    ? { kind: 'deadline', date: closesAt }
    : { kind: 'completed', date: closesAt };
};

/**
 * A short forward-looking day label for an upcoming session: "Today",
 * "Tomorrow", "in N days", else null (show the bare date). Unlike
 * getTimeRemainingUntil this is start-oriented - a session starts, it does not
 * "end tomorrow" - and it counts calendar days, not 24h windows, so an evening
 * session tomorrow morning still reads "Tomorrow".
 */
export const relativeDayLabel = (date: Date, now: Date): string | null => {
  const startOfDay = (d: Date) => {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c.getTime();
  };
  const days = Math.round((startOfDay(date) - startOfDay(now)) / MS_PER_DAY);
  if (days < 0) return null;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `in ${days} days`;
  return null;
};

/**
 * The badge label for a study. Deliberately the RAW status, restyled - not a
 * derived RECRUITING/RUNNING/ANALYSIS state, which the wireframe showed but
 * which no field supports without inventing lifecycle semantics.
 */
export const getDisplayStatus = (status: Opportunity['status']): 'DRAFT' | 'LIVE' | 'CLOSED' => {
  switch (status) {
    case 'draft':
      return 'DRAFT';
    case 'published':
      return 'LIVE';
    case 'closed':
      return 'CLOSED';
    default:
      return 'CLOSED';
  }
};
