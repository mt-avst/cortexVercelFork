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
import { getClosingTime, getParticipantFacingType } from './opportunityUtils';
import { hasUpcomingSlot, isPublishedButNotWorking } from '../lib/opportunity-authoring/step-status';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * The one "soon" horizon on this page, in days: the Needs attention
 * closing-soon card, the Closing soon chip and the warning colour on the Next
 * / deadline note (`isNextNoteWarned`) all use it, over the same studies -
 * published ones whose next session or closing time falls inside it.
 */
export const CLOSING_SOON_DAYS = 3;

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

/**
 * What the Progress cell shows: the study's all-time booked / capacity when the
 * server sent the totals, else the recent-window sum `getRecruitment` makes.
 *
 * Deliberately NOT what the Needs recruitment and Fully booked chips read. Those
 * ask about open slots, and a slot that passed unfilled weeks ago is not one -
 * so they stay on `getRecruitment`. Progress asks how the study filled, which is
 * the only question a closed study can still answer.
 */
export const getStudyProgress = (opportunity: Opportunity): Recruitment | null => {
  const { total_booked: booked, total_capacity: capacity } = opportunity;
  if (booked === undefined || capacity === undefined) return getRecruitment(opportunity);

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
 * "Closing soon", the one predicate: a published study
 * whose closing time (end_date, or last session end via getClosingTime) is
 * still ahead and reads `withinDays` or fewer on the same round-down rule the
 * label itself uses (`Math.floor`, matching getTimeRemainingUntil's "N days
 * left"). This is deliberately about the CLOSE date alone, not a session -
 * the note colour, the Closing soon chip and the Needs attention card all
 * call this one function, so a label reading "3 days left" and its colour can
 * never disagree, and the note's colour and the milestone it names describe
 * the same date (getNextMilestone below).
 */
export const isClosingSoon = (
  opportunity: Opportunity,
  now: Date,
  withinDays = CLOSING_SOON_DAYS,
): boolean => {
  if (opportunity.status !== 'published') return false;
  const closesAt = getClosingTime(opportunity);
  if (!closesAt || closesAt.getTime() <= now.getTime()) return false;
  const daysLeft = Math.floor((closesAt.getTime() - now.getTime()) / MS_PER_DAY);
  return daysLeft <= withinDays;
};

/** Published studies closing within `withinDays` (see `isClosingSoon`). */
export const getStudiesClosingSoon = (
  opportunities: Opportunity[],
  now: Date,
  withinDays = CLOSING_SOON_DAYS,
): Opportunity[] => opportunities.filter((opp) => isClosingSoon(opp, now, withinDays));

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

/**
 * "Broken": published, but failing its own publish readiness - the dashboard's
 * reading of `isPublishedButNotWorking` from the fields the list response
 * carries. The one place the table, the chips, the status filter, the Needs
 * attention card and the status sort all ask, so they cannot disagree.
 *
 * `now` is passed to `hasUpcomingSlot` (cto/AdaptaLabs#164): a study is
 * Broken only when it has no slot that has not yet ended, matching the
 * server's own publish and session-delete guards (`end_time > NOW()`,
 * strictly, whatever its capacity) rather than merely having no sessions at
 * all.
 */
export const isStudyBroken = (opportunity: Opportunity, now: Date): boolean =>
  isPublishedButNotWorking(opportunity.status, {
    type: opportunity.type,
    deliveryMode: opportunity.delivery_mode,
    hasLinkedStudy: Boolean(opportunity.firsthand_study_id),
    externalLink: opportunity.external_link_optional,
    hasUpcomingSlot: hasUpcomingSlot(opportunity.sessions ?? [], now),
    meetingLocation: opportunity.meeting_location_optional,
  });

export const getBrokenStudies = (opportunities: Opportunity[], now: Date): Opportunity[] =>
  opportunities.filter((opportunity) => isStudyBroken(opportunity, now));

export type QuickFilter = 'broken' | 'needs-recruitment' | 'draft' | 'closing-soon' | 'fully-booked';

/** The chip row, in display order: Broken first (Petra 3.3). */
export const QUICK_FILTERS: readonly { key: QuickFilter; label: string }[] = [
  { key: 'broken', label: 'Broken' },
  { key: 'needs-recruitment', label: 'Needs recruitment' },
  { key: 'draft', label: 'Draft' },
  { key: 'closing-soon', label: 'Closing soon' },
  { key: 'fully-booked', label: 'Fully booked' },
];

export const matchesQuickFilter = (
  opportunity: Opportunity,
  filter: QuickFilter,
  now: Date,
): boolean => {
  switch (filter) {
    case 'broken':
      return isStudyBroken(opportunity, now);
    case 'needs-recruitment':
      return needsRecruitment(opportunity);
    case 'draft':
      return opportunity.status === 'draft';
    case 'closing-soon':
      return isClosingSoon(opportunity, now);
    case 'fully-booked':
      return isFullyBooked(opportunity);
    default:
      return false;
  }
};

/** How many of `opportunities` each chip would show - the count on the chip. */
export const getQuickFilterCounts = (
  opportunities: Opportunity[],
  now: Date,
): Record<QuickFilter, number> => {
  const counts: Record<QuickFilter, number> = {
    broken: 0,
    'needs-recruitment': 0,
    draft: 0,
    'closing-soon': 0,
    'fully-booked': 0,
  };
  for (const opportunity of opportunities) {
    for (const { key } of QUICK_FILTERS) {
      if (matchesQuickFilter(opportunity, key, now)) counts[key] += 1;
    }
  }
  return counts;
};

/**
 * The Status select's values. `broken` is not a status the server knows: it
 * goes over the wire as `published` (`statusFilterToWire`) and is narrowed to
 * the broken ones client-side (`matchesStatusFilter`).
 */
export type StatusFilter = '' | 'broken' | 'draft' | 'published' | 'closed';

export const statusFilterToWire = (filter: StatusFilter): Opportunity['status'] | undefined => {
  if (filter === '') return undefined;
  return filter === 'broken' ? 'published' : filter;
};

/** The Study Type select, applied client-side like the Status one. */
export const matchesTypeFilter = (opportunity: Opportunity, type: string): boolean =>
  type === '' || opportunity.type === type;

export const matchesStatusFilter = (
  opportunity: Opportunity,
  filter: StatusFilter,
  now: Date,
): boolean => {
  if (filter === '') return true;
  if (filter === 'broken') return isStudyBroken(opportunity, now);
  return opportunity.status === filter;
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
  | { kind: 'completed'; date: Date }
  /** Closed before its closing time (by hand): nothing is ahead of it any
   * more. `date` is the closing time it would have had. */
  | { kind: 'closed'; date: Date };

export const getNextMilestone = (opportunity: Opportunity, now: Date): NextMilestone | null => {
  const closesAt = getClosingTime(opportunity);

  // A closed study has no next milestone, whatever its dates say. Before a
  // manual Close existed a closed study had always passed its end date; now
  // one can be closed with its window, and even its slots, still ahead.
  if (opportunity.status === 'closed') {
    if (closesAt && closesAt.getTime() > now.getTime()) return { kind: 'closed', date: closesAt };
    if (closesAt) return { kind: 'completed', date: closesAt };
    const next = getNextSession(opportunity, now);
    return next ? { kind: 'closed', date: new Date(next.start_time) } : null;
  }

  // a closing-soon study's note names its CLOSE milestone,
  // even when a session sits later - the colour and the chip both come from
  // the close date (isClosingSoon), so the text has to describe that same
  // date or the two disagree (closesAt is guaranteed non-null and ahead by
  // isClosingSoon's own check). Every other study keeps the old session-first
  // priority.
  if (isClosingSoon(opportunity, now)) return { kind: 'deadline', date: closesAt as Date };

  const next = getNextSession(opportunity, now);
  if (next) return { kind: 'session', date: new Date(next.start_time) };

  if (!closesAt) return null;

  return closesAt.getTime() > now.getTime()
    ? { kind: 'deadline', date: closesAt }
    : { kind: 'completed', date: closesAt };
};

/** A milestone that is still ahead: an upcoming session or closing time. */
const isAhead = (milestone: NextMilestone | null): boolean =>
  milestone !== null && (milestone.kind === 'session' || milestone.kind === 'deadline');

/**
 * The instant a study's NEXT milestone falls on - an upcoming session or a
 * future closing time - or null when it has none. `completed` is in the past
 * and `closed` is a study that was closed early, so neither is a next
 * anything: both sort with the studies that have no milestone.
 */
export const getUpcomingMilestoneTime = (opportunity: Opportunity, now: Date): number | null => {
  const milestone = getNextMilestone(opportunity, now);
  return milestone && isAhead(milestone) ? milestone.date.getTime() : null;
};

/**
 * Whether a milestone is inside the closing-soon horizon: still ahead, and no
 * more than `withinDays` away. Drives the warning colour on the Next note.
 */
export const isMilestoneSoon = (
  milestone: NextMilestone | null,
  now: Date,
  withinDays = CLOSING_SOON_DAYS,
): boolean => {
  if (!milestone || !isAhead(milestone)) return false;
  const at = milestone.date.getTime();
  return at >= now.getTime() && at <= now.getTime() + withinDays * MS_PER_DAY;
};

/**
 * Whether a row's Next note takes the warning colour: exactly `isClosingSoon`
 * - the same one predicate the Closing soon chip and the
 * Needs attention card use, so a label reading "N days left" and its colour
 * can never disagree, and `getNextMilestone` already switches the milestone
 * itself to the close date whenever this is true.
 */
export const isNextNoteWarned = (opportunity: Opportunity, now: Date): boolean =>
  isClosingSoon(opportunity, now);

/**
 * Triage rank for the Status column (Petra 3.2): what needs a researcher
 * first sorts first. Broken is not a stored status - it is a published study
 * failing readiness - so it outranks Draft.
 */
export const STATUS_RANK = { broken: 0, draft: 1, published: 2, closed: 3 } as const;

export const getStatusRank = (opportunity: Opportunity, now: Date): number => {
  if (isStudyBroken(opportunity, now)) return STATUS_RANK.broken;
  switch (opportunity.status) {
    case 'draft':
      return STATUS_RANK.draft;
    case 'published':
      return STATUS_RANK.published;
    default:
      return STATUS_RANK.closed;
  }
};

/** Every field the Research Studies table sorts by, header and Sort-by alike. */
export type StudySortField = 'title' | 'status' | 'next' | 'created_at';
export type SortDirection = 'asc' | 'desc';

/** The table's own starting sort (Admin.tsx state init) - named here too so
 * the phone filter toolbar's "non-default filters and sort settings" badge
 * count can ask "is sort still at its default?"
 * without duplicating the literal values `Admin.tsx` initialises from. */
export const DEFAULT_SORT_FIELD: StudySortField = 'status';
export const DEFAULT_SORT_DIRECTION: SortDirection = 'asc';

interface StudySortKeys {
  title: string;
  rank: number;
  next: number | null;
  created: number;
}

const sortKeysFor = (opportunity: Opportunity, now: Date): StudySortKeys => ({
  title: opportunity.title,
  rank: getStatusRank(opportunity, now),
  next: getUpcomingMilestoneTime(opportunity, now),
  created: new Date(opportunity.created_at).getTime() || 0,
});

const compareTitles = (a: string, b: string): number =>
  a.localeCompare(b, 'en-GB', { sensitivity: 'accent' });

/** Soonest first; a study with no next milestone after every one that has. */
const compareMilestones = (a: number | null, b: number | null, direction: SortDirection): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === 'asc' ? a - b : b - a;
};

const compareKeys = (
  a: StudySortKeys,
  b: StudySortKeys,
  field: StudySortField,
  direction: SortDirection,
): number => {
  const flip = direction === 'asc' ? 1 : -1;
  switch (field) {
    case 'status':
      // Ties on rank: next milestone soonest, then title A-Z, whichever way
      // the rank itself runs.
      return (
        flip * (a.rank - b.rank) ||
        compareMilestones(a.next, b.next, 'asc') ||
        compareTitles(a.title, b.title)
      );
    case 'next':
      // No milestone sorts last in BOTH directions, so the direction flips
      // only the dated rows.
      return compareMilestones(a.next, b.next, direction) || compareTitles(a.title, b.title);
    case 'created_at':
      return flip * (a.created - b.created) || compareTitles(a.title, b.title);
    case 'title':
    default:
      return flip * compareTitles(a.title, b.title);
  }
};

/**
 * The table's comparator. Returns 0 for equal keys (the one it replaced
 * returned -1, so equal rows swapped places on every sort).
 */
export const compareStudies = (
  a: Opportunity,
  b: Opportunity,
  field: StudySortField,
  direction: SortDirection,
  now: Date,
): number => compareKeys(sortKeysFor(a, now), sortKeysFor(b, now), field, direction);

/**
 * A sorted COPY of `opportunities`. Keys are computed once per study rather
 * than once per comparison, and `Array.prototype.sort` is stable, so rows
 * with equal keys keep their input order and sorting twice gives the same
 * order.
 */
export const sortStudies = (
  opportunities: readonly Opportunity[],
  field: StudySortField,
  direction: SortDirection,
  now: Date,
): Opportunity[] =>
  opportunities
    .map((opportunity) => ({ opportunity, keys: sortKeysFor(opportunity, now) }))
    .sort((a, b) => compareKeys(a.keys, b.keys, field, direction))
    .map(({ opportunity }) => opportunity);

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
 * The TYPE-column label for the admin studies table. A DELIBERATE, admin-only
 * divergence from getParticipantFacingType (the one-name-everywhere source):
 * the two "... session" names are dropped to "Live" / "Recorded" so the type
 * pill does not crowd the status pill in this dense table. Every other type
 * keeps its canonical participant-facing name, and the participant browse still
 * shows the full "Live session" / "Recorded session" - the short form lives
 * only here.
 */
export const getAdminTypeLabel = (type: Opportunity['type']): string => {
  switch (type) {
    case 'test':
      return 'Live';
    case 'unmoderated':
      return 'Recorded';
    default:
      return getParticipantFacingType(type);
  }
};

/**
 * The badge label for a study. Deliberately the RAW status, restyled - not a
 * derived RECRUITING/RUNNING/ANALYSIS state, which the wireframe showed but
 * which no field supports without inventing lifecycle semantics.
 */
export const getDisplayStatus = (status: Opportunity['status']): 'DRAFT' | 'PUBLISHED' | 'CLOSED' => {
  switch (status) {
    case 'draft':
      return 'DRAFT';
    case 'published':
      return 'PUBLISHED';
    case 'closed':
      return 'CLOSED';
    default:
      return 'CLOSED';
  }
};

/**
 * Whether the Status cell captions a closed study "Auto-closed".
 *
 * `auto_closed` is the server's record of HOW a study closed (MR A, which
 * backfilled every earlier close as automatic). Only an explicit `true`
 * captions: a manual Close from this table writes false, and a response
 * without the field says nothing about how the study closed.
 */
export const isAutoClosed = (opportunity: Opportunity): boolean =>
  opportunity.status === 'closed' && opportunity.auto_closed === true;

/** The minimum of the signed-in user this page's owner gates read. */
export interface StudyViewer {
  id?: string;
  role?: string;
}

/**
 * Owner or superadmin: who the server lets see a study's analytics and change
 * its status. Anyone else gets a 403, so the table offers neither.
 */
export const canManageStudy = (opportunity: Opportunity, viewer: StudyViewer | null | undefined): boolean =>
  viewer?.role === 'superadmin' ||
  (Boolean(viewer?.id) && opportunity.owner_user_id === viewer?.id);

export const studyEditPath = (id: string): string => `/admin/opportunities/${id}/edit`;
export const studyAnalyticsPath = (id: string): string => `/admin/opportunities/${id}/analytics`;
export const studyPreviewPath = (id: string): string => `/opportunities/${id}`;

/**
 * Where a row goes - its title link and a click anywhere on the row: the edit
 * page for someone who can edit it, the participant page for anyone else
 * (the server refuses them the edit save).
 */
export const studyRowPath = (opportunity: Opportunity, viewer: StudyViewer | null | undefined): string =>
  canManageStudy(opportunity, viewer) ? studyEditPath(opportunity.id) : studyPreviewPath(opportunity.id);

/** The row's inline button: the next thing to do to the study in its state. */
export interface PrimaryStudyAction {
  label: 'Fix' | 'Edit' | 'Analytics' | 'Preview';
  to: string;
}

/**
 * Petra 3.4, gated on who can act: for the owner (or a superadmin) Broken -
 * Fix, Draft - Edit, published or closed - Analytics. Anyone else gets
 * Preview as a participant whatever the state, because the server refuses
 * them the edit save and the analytics read alike ("Only the owner can edit
 * this study"), so Fix or Edit would open a form they cannot save.
 */
export const getPrimaryStudyAction = (
  opportunity: Opportunity,
  viewer: StudyViewer | null | undefined,
  now: Date,
): PrimaryStudyAction => {
  if (!canManageStudy(opportunity, viewer)) {
    return { label: 'Preview', to: studyPreviewPath(opportunity.id) };
  }
  if (isStudyBroken(opportunity, now)) return { label: 'Fix', to: studyEditPath(opportunity.id) };
  if (opportunity.status === 'draft') return { label: 'Edit', to: studyEditPath(opportunity.id) };
  return { label: 'Analytics', to: studyAnalyticsPath(opportunity.id) };
};
