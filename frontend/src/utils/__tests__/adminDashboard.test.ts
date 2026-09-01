import { describe, it, expect } from 'vitest';
import {
  getRecruitment,
  getNextSession,
  weekBounds,
  getSessionsThisWeek,
  getStudiesClosingSoon,
  isFullyBooked,
  needsRecruitment,
  matchesQuickFilter,
  getDisplayStatus,
  getNextMilestone,
  relativeDayLabel,
} from '../adminDashboard';
import { Opportunity, Session } from '../../api/types';

// A Wednesday, midday local time. Every time-based assertion is anchored here
// so it cannot drift with the wall clock.
const NOW = new Date('2026-08-19T12:00:00');

const session = (over: Partial<Session>): Session => ({
  id: 's',
  opportunity_id: 'opp',
  start_time: '2026-08-19T14:00:00',
  end_time: '2026-08-19T15:00:00',
  capacity: 3,
  booked_count: 0,
  remaining: 3,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  ...over,
});

const opp = (over: Partial<Opportunity>): Opportunity => ({
  id: 'opp',
  type: 'test',
  title: 'Study',
  purpose_one_liner: 'one liner',
  default_duration_minutes: 30,
  status: 'published',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  ...over,
});

describe('getRecruitment', () => {
  it('sums booked and capacity across sessions and rounds the percentage', () => {
    const r = getRecruitment(
      opp({ sessions: [session({ capacity: 3, booked_count: 2 }), session({ capacity: 7, booked_count: 4 })] }),
    );
    expect(r).toEqual({ booked: 6, capacity: 10, pct: 60 });
  });

  it('is null with no sessions (control: a study with sessions is not null)', () => {
    expect(getRecruitment(opp({ sessions: [] }))).toBeNull();
    expect(getRecruitment(opp({ sessions: undefined }))).toBeNull();
    expect(getRecruitment(opp({ sessions: [session({})] }))).not.toBeNull();
  });

  it('reports 0% when capacity is zero rather than dividing by zero', () => {
    expect(getRecruitment(opp({ sessions: [session({ capacity: 0, booked_count: 0 })] }))?.pct).toBe(0);
  });
});

describe('getNextSession', () => {
  it('picks the soonest session at or after now, ignoring past ones', () => {
    const past = session({ id: 'past', start_time: '2026-08-19T09:00:00' });
    const soon = session({ id: 'soon', start_time: '2026-08-19T14:00:00' });
    const later = session({ id: 'later', start_time: '2026-08-20T10:00:00' });
    const next = getNextSession(opp({ sessions: [later, past, soon] }), NOW);
    expect(next?.id).toBe('soon');
  });

  it('is null when every session is in the past (control: a future one is found)', () => {
    const past = session({ start_time: '2026-08-18T09:00:00' });
    expect(getNextSession(opp({ sessions: [past] }), NOW)).toBeNull();
    expect(getNextSession(opp({ sessions: [session({ start_time: '2026-08-19T14:00:00' })] }), NOW)).not.toBeNull();
  });
});

describe('weekBounds', () => {
  it('anchors the week to Monday 00:00 for a midweek now', () => {
    const { start, end } = weekBounds(NOW); // Wed 19 Aug 2026
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(7); // August
    expect(start.getDate()).toBe(17); // Monday
    expect(start.getHours()).toBe(0);
    expect(end.getDate()).toBe(24); // next Monday
  });

  it('keeps a Sunday inside the week that started the previous Monday', () => {
    const sunday = new Date('2026-08-23T20:00:00');
    const { start } = weekBounds(sunday);
    expect(start.getDate()).toBe(17); // still Monday 17 Aug, not the 24th
  });
});

describe('getSessionsThisWeek', () => {
  it('counts sessions in the current week and splits upcoming vs completed', () => {
    const opportunities = [
      opp({ sessions: [
        session({ start_time: '2026-08-17T10:00:00', end_time: '2026-08-17T11:00:00' }), // Mon, completed
        session({ start_time: '2026-08-19T14:00:00', end_time: '2026-08-19T15:00:00' }), // now-ish, upcoming
        session({ start_time: '2026-08-21T09:00:00', end_time: '2026-08-21T10:00:00' }), // Fri, upcoming
      ] }),
      opp({ sessions: [
        session({ start_time: '2026-08-10T10:00:00', end_time: '2026-08-10T11:00:00' }), // last week, excluded
      ] }),
    ];
    expect(getSessionsThisWeek(opportunities, NOW)).toEqual({ total: 3, upcoming: 2, completed: 1 });
  });

  it('excludes next week (control: same session one week earlier is counted)', () => {
    const nextWeek = [opp({ sessions: [session({ start_time: '2026-08-25T10:00:00', end_time: '2026-08-25T11:00:00' })] })];
    const thisWeek = [opp({ sessions: [session({ start_time: '2026-08-18T10:00:00', end_time: '2026-08-18T11:00:00' })] })];
    expect(getSessionsThisWeek(nextWeek, NOW).total).toBe(0);
    expect(getSessionsThisWeek(thisWeek, NOW).total).toBe(1);
  });
});

describe('getStudiesClosingSoon', () => {
  it('includes a published study closing within the window', () => {
    const closing = opp({ id: 'closing', status: 'published', end_date: '2026-08-21T17:00:00' });
    expect(getStudiesClosingSoon([closing], NOW, 3).map((o) => o.id)).toEqual(['closing']);
  });

  it('excludes drafts, already-closed deadlines, and far-off ones', () => {
    const draft = opp({ id: 'd', status: 'draft', end_date: '2026-08-21T17:00:00' });
    const past = opp({ id: 'p', status: 'published', end_date: '2026-08-18T17:00:00' });
    const far = opp({ id: 'f', status: 'published', end_date: '2026-09-30T17:00:00' });
    expect(getStudiesClosingSoon([draft, past, far], NOW, 3)).toEqual([]);
  });

  it('falls back to the last session end when there is no end_date', () => {
    const bookable = opp({
      id: 'b',
      status: 'published',
      end_date: undefined,
      sessions: [session({ start_time: '2026-08-20T09:00:00', end_time: '2026-08-20T10:00:00' })],
    });
    expect(getStudiesClosingSoon([bookable], NOW, 3).map((o) => o.id)).toEqual(['b']);
  });

  it('counts an imminent upcoming session even when end_date has already passed', () => {
    // Recruitment window closed yesterday, but a session runs today - the table
    // shows it as imminent, so this must too.
    const stillRunning = opp({
      id: 'r',
      status: 'published',
      end_date: '2026-08-18T17:00:00', // before NOW
      sessions: [session({ start_time: '2026-08-19T16:00:00', end_time: '2026-08-19T16:30:00' })], // today, future
    });
    expect(getStudiesClosingSoon([stillRunning], NOW, 3).map((o) => o.id)).toEqual(['r']);
  });

  it('excludes a study whose only session is beyond the window (control)', () => {
    const farSession = opp({
      id: 'f',
      status: 'published',
      end_date: undefined,
      sessions: [session({ start_time: '2026-08-30T09:00:00', end_time: '2026-08-30T10:00:00' })],
    });
    expect(getStudiesClosingSoon([farSession], NOW, 3)).toEqual([]);
  });
});

describe('isFullyBooked / needsRecruitment', () => {
  it('fully booked when every slot is at capacity', () => {
    expect(isFullyBooked(opp({ sessions: [session({ capacity: 3, booked_count: 3 })] }))).toBe(true);
    expect(isFullyBooked(opp({ sessions: [session({ capacity: 3, booked_count: 2 })] }))).toBe(false);
    expect(isFullyBooked(opp({ sessions: [] }))).toBe(false);
  });

  it('needs recruitment only for published studies with open slots', () => {
    expect(needsRecruitment(opp({ status: 'published', sessions: [session({ capacity: 3, booked_count: 1 })] }))).toBe(true);
    expect(needsRecruitment(opp({ status: 'draft', sessions: [session({ capacity: 3, booked_count: 1 })] }))).toBe(false);
    expect(needsRecruitment(opp({ status: 'published', sessions: [session({ capacity: 3, booked_count: 3 })] }))).toBe(false);
  });
});

describe('matchesQuickFilter', () => {
  it('routes each filter to its predicate', () => {
    const draft = opp({ status: 'draft' });
    const full = opp({ status: 'published', sessions: [session({ capacity: 2, booked_count: 2 })] });
    const open = opp({ status: 'published', sessions: [session({ capacity: 2, booked_count: 0 })] });
    const closing = opp({ status: 'published', end_date: '2026-08-20T12:00:00' });

    expect(matchesQuickFilter(draft, 'draft', NOW)).toBe(true);
    expect(matchesQuickFilter(open, 'draft', NOW)).toBe(false);
    expect(matchesQuickFilter(full, 'fully-booked', NOW)).toBe(true);
    expect(matchesQuickFilter(open, 'needs-recruitment', NOW)).toBe(true);
    expect(matchesQuickFilter(closing, 'closing-soon', NOW)).toBe(true);
  });
});

describe('getNextMilestone', () => {
  it('prefers the next upcoming session over any deadline', () => {
    const m = getNextMilestone(
      opp({ end_date: '2026-09-30T17:00:00', sessions: [session({ start_time: '2026-08-20T10:00:00' })] }),
      NOW,
    );
    expect(m).toEqual({ kind: 'session', date: new Date('2026-08-20T10:00:00') });
  });

  it('falls back to a future deadline when no session is upcoming', () => {
    const m = getNextMilestone(opp({ end_date: '2026-08-22T17:00:00', sessions: [] }), NOW);
    expect(m?.kind).toBe('deadline');
    expect(m?.date).toEqual(new Date('2026-08-22T17:00:00'));
  });

  it('reports completed once every session has ended', () => {
    const m = getNextMilestone(
      opp({ end_date: undefined, sessions: [session({ start_time: '2026-08-10T10:00:00', end_time: '2026-08-10T11:00:00' })] }),
      NOW,
    );
    expect(m?.kind).toBe('completed');
  });

  it('is null with nothing to anchor to (control: a dated study is not null)', () => {
    expect(getNextMilestone(opp({ end_date: undefined, sessions: [] }), NOW)).toBeNull();
    expect(getNextMilestone(opp({ end_date: '2026-08-22T17:00:00', sessions: [] }), NOW)).not.toBeNull();
  });
});

describe('relativeDayLabel', () => {
  it('reads calendar days forward, not 24h windows', () => {
    expect(relativeDayLabel(new Date('2026-08-19T20:00:00'), NOW)).toBe('Today');
    // Tomorrow morning is under 24h from NOW (noon) but still the next calendar day.
    expect(relativeDayLabel(new Date('2026-08-20T09:00:00'), NOW)).toBe('Tomorrow');
    expect(relativeDayLabel(new Date('2026-08-22T09:00:00'), NOW)).toBe('in 3 days');
  });

  it('returns null for a past day or one a week or more out (show the bare date)', () => {
    expect(relativeDayLabel(new Date('2026-08-18T09:00:00'), NOW)).toBeNull();
    expect(relativeDayLabel(new Date('2026-08-30T09:00:00'), NOW)).toBeNull();
  });
});

describe('getDisplayStatus', () => {
  it('maps raw status to the restyled label (published reads LIVE)', () => {
    expect(getDisplayStatus('draft')).toBe('DRAFT');
    expect(getDisplayStatus('published')).toBe('LIVE');
    expect(getDisplayStatus('closed')).toBe('CLOSED');
  });
});
