import { describe, it, expect } from 'vitest';
import {
  CLOSING_SOON_DAYS,
  STATUS_RANK,
  getStatusRank,
  isStudyBroken,
  compareStudies,
  sortStudies,
  statusFilterToWire,
  matchesStatusFilter,
  getQuickFilterCounts,
  QUICK_FILTERS,
  isMilestoneSoon,
  getUpcomingMilestoneTime,
  getStudiesClosingSoon,
  isAutoClosed,
  canManageStudy,
  getPrimaryStudyAction,
  relativeDayLabel,
  matchesTypeFilter,
  getNextMilestone,
  isNextNoteWarned,
  matchesQuickFilter,
  StudySortField,
  SortDirection,
} from '../adminDashboard';
import { Opportunity, Session } from '../../api/types';

/**
 * Admin Research Studies table, Step 2 (MR B): the pure triage rules behind
 * the table - status rank and the one comparator, the Broken status filter's
 * wire mapping, the 3-day "soon" horizon, the auto-closed caption and the
 * row's next-verb button. Every policy number is pinned as a LITERAL here,
 * never read back from the module under test.
 */

// A Wednesday, midday UTC. Every time-based assertion is anchored here so it
// cannot drift with the wall clock.
const NOW = new Date('2026-08-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

const session = (startInDays: number, over: Partial<Session> = {}): Session => ({
  id: `s-${startInDays}`,
  opportunity_id: 'opp',
  start_time: inDays(startInDays),
  end_time: new Date(NOW.getTime() + startInDays * DAY + 60 * 60 * 1000).toISOString(),
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

// The four states the rank knows. A published moderated (`test`) study with
// no bookable slot is Broken (isPublishedButNotWorking); give it a session
// and it is published and working.
const broken = (over: Partial<Opportunity> = {}) => opp({ status: 'published', sessions: [], ...over });
const draft = (over: Partial<Opportunity> = {}) => opp({ status: 'draft', sessions: [], ...over });
const published = (over: Partial<Opportunity> = {}) =>
  opp({ status: 'published', sessions: [session(10)], ...over });
const closed = (over: Partial<Opportunity> = {}) => opp({ status: 'closed', sessions: [], ...over });

const ids = (list: Opportunity[]) => list.map((o) => o.id);

/**
 * "Equal" to Array.prototype.sort is `=== 0`, so -0 counts: a descending
 * comparison of equal keys is `-1 * 0`. Object.is-based toBe(0) would reject
 * that for no behavioural reason.
 */
const expectEqualKeys = (result: number) => {
  expect(Number.isNaN(result)).toBe(false);
  expect(Math.abs(result)).toBe(0);
};

describe('the triage fixtures mean what they say', () => {
  it('a published test study with no session is broken, and one with a session is not', () => {
    // Control for every rank test below: if these states did not read as
    // intended, a rank assertion could pass for the wrong reason.
    expect(isStudyBroken(broken())).toBe(true);
    expect(isStudyBroken(published())).toBe(false);
    expect(isStudyBroken(draft())).toBe(false);
    expect(isStudyBroken(closed())).toBe(false);
  });
});

describe('status rank (Petra 3.2, AC11)', () => {
  it('pins the rank literals: Broken 0, Draft 1, Published 2, Closed 3', () => {
    expect(STATUS_RANK).toEqual({ broken: 0, draft: 1, published: 2, closed: 3 });
  });

  it('ranks each state by those literals', () => {
    expect(getStatusRank(broken())).toBe(0);
    expect(getStatusRank(draft())).toBe(1);
    expect(getStatusRank(published())).toBe(2);
    expect(getStatusRank(closed())).toBe(3);
  });

  it('ranks Broken ahead of Draft, although both are "published or less"', () => {
    // Broken is not a stored status; it is a published study failing its own
    // readiness, and it outranks Draft because it is live and failing.
    expect(getStatusRank(broken())).toBeLessThan(getStatusRank(draft()));
  });
});

describe('compareStudies / sortStudies (the one comparator)', () => {
  const FIELDS: StudySortField[] = ['title', 'status', 'next', 'created_at'];
  const DIRECTIONS: SortDirection[] = ['asc', 'desc'];

  it('returns 0 for two studies with equal keys, on every field and in both directions', () => {
    // The comparator it replaced returned -1 for equal keys, so equal rows
    // swapped places on every sort. Different ids, identical sort keys.
    const a = published({ id: 'a', title: 'Same title' });
    const b = published({ id: 'b', title: 'Same title' });
    for (const field of FIELDS) {
      for (const direction of DIRECTIONS) {
        expectEqualKeys(compareStudies(a, b, field, direction, NOW));
        expectEqualKeys(compareStudies(b, a, field, direction, NOW));
      }
    }
  });

  it('returns 0 comparing a study with itself', () => {
    // Control for the helper: a non-equal pair is not reported equal.
    expect(Math.abs(compareStudies(broken({ title: 'A' }), closed({ title: 'A' }), 'status', 'asc', NOW))).toBeGreaterThan(0);
    const a = broken({ id: 'a', title: 'Alpha' });
    for (const field of FIELDS) {
      for (const direction of DIRECTIONS) {
        expectEqualKeys(compareStudies(a, a, field, direction, NOW));
      }
    }
  });

  it('is stable: equal-key rows keep their input order, so sorting twice gives the same order', () => {
    const a = published({ id: 'a', title: 'Same title' });
    const b = published({ id: 'b', title: 'Same title' });
    const c = published({ id: 'c', title: 'Same title' });
    for (const field of FIELDS) {
      for (const direction of DIRECTIONS) {
        const once = sortStudies([b, c, a], field, direction, NOW);
        expect(ids(once)).toEqual(['b', 'c', 'a']);
        expect(ids(sortStudies(once, field, direction, NOW))).toEqual(['b', 'c', 'a']);
        // Control: the input order really is what decides it.
        expect(ids(sortStudies([a, b, c], field, direction, NOW))).toEqual(['a', 'b', 'c']);
      }
    }
  });

  it('sorting a mixed list twice gives the same order', () => {
    const list = [
      closed({ id: 'c1', title: 'Closed one' }),
      published({ id: 'p1', title: 'Live one', sessions: [session(5)] }),
      broken({ id: 'b1', title: 'Broken one' }),
      draft({ id: 'd1', title: 'Draft one' }),
      published({ id: 'p2', title: 'Live two', sessions: [session(5)] }),
    ];
    for (const field of FIELDS) {
      for (const direction of DIRECTIONS) {
        const once = sortStudies(list, field, direction, NOW);
        expect(ids(sortStudies(once, field, direction, NOW))).toEqual(ids(once));
      }
    }
  });

  it('returns a sorted copy and leaves its input alone', () => {
    const list = [closed({ id: 'c' }), broken({ id: 'b' })];
    const out = sortStudies(list, 'status', 'asc', NOW);
    expect(ids(out)).toEqual(['b', 'c']);
    expect(ids(list)).toEqual(['c', 'b']);
    expect(out).not.toBe(list);
  });

  describe('status', () => {
    it('ascending: Broken, Draft, Published, Closed', () => {
      const list = [
        closed({ id: 'closed', title: 'A' }),
        published({ id: 'published', title: 'B' }),
        draft({ id: 'draft', title: 'C' }),
        broken({ id: 'broken', title: 'D' }),
      ];
      expect(ids(sortStudies(list, 'status', 'asc', NOW))).toEqual(['broken', 'draft', 'published', 'closed']);
      expect(ids(sortStudies(list, 'status', 'desc', NOW))).toEqual(['closed', 'published', 'draft', 'broken']);
    });

    it('breaks a rank tie by next milestone soonest, then title A-Z', () => {
      const list = [
        published({ id: 'later', title: 'Aardvark', sessions: [session(9)] }),
        published({ id: 'none', title: 'Aaa first by title', sessions: [], end_date: undefined, type: 'unmoderated' }),
        published({ id: 'soon-b', title: 'beta', sessions: [session(2)] }),
        published({ id: 'soon-a', title: 'Alpha', sessions: [session(2)] }),
      ];
      // Control: the no-milestone row is still Published rank, not Broken -
      // an unmoderated study is never broken by a missing slot.
      expect(getStatusRank(list[1])).toBe(2);
      expect(getUpcomingMilestoneTime(list[1], NOW)).toBeNull();

      // soon-a and soon-b tie on milestone, so title decides, case-insensitive
      // ("Alpha" before "beta"); the undated row goes last although its title
      // sorts first.
      expect(ids(sortStudies(list, 'status', 'asc', NOW))).toEqual(['soon-a', 'soon-b', 'later', 'none']);
    });

    it('keeps the milestone tie-break soonest-first when the rank runs descending', () => {
      const list = [
        published({ id: 'later', title: 'A', sessions: [session(9)] }),
        published({ id: 'soon', title: 'B', sessions: [session(2)] }),
        broken({ id: 'broken', title: 'C' }),
      ];
      expect(ids(sortStudies(list, 'status', 'desc', NOW))).toEqual(['soon', 'later', 'broken']);
    });
  });

  describe('next (AC13)', () => {
    const list = [
      published({ id: 'none-z', title: 'Zulu', sessions: [], type: 'unmoderated' }),
      published({ id: 'd5', title: 'Five', sessions: [session(5)] }),
      published({ id: 'none-a', title: 'Alpha', sessions: [], type: 'unmoderated' }),
      published({ id: 'd1', title: 'One', sessions: [session(1)] }),
      // A deadline, not a session: end_date in 3 days, every slot already past.
      published({ id: 'd3', title: 'Three', sessions: [session(-5)], end_date: inDays(3) }),
      // Completed: its closing time has passed, so it has no NEXT milestone.
      published({ id: 'done', title: 'Done', sessions: [session(-5)], end_date: inDays(-1) }),
    ];

    it('sorts soonest first ascending, with every no-milestone row last', () => {
      expect(ids(sortStudies(list, 'next', 'asc', NOW))).toEqual(['d1', 'd3', 'd5', 'none-a', 'done', 'none-z']);
    });

    it('sorts latest first descending, and still puts every no-milestone row LAST', () => {
      expect(ids(sortStudies(list, 'next', 'desc', NOW))).toEqual(['d5', 'd3', 'd1', 'none-a', 'done', 'none-z']);
    });

    it('treats a completed milestone as none', () => {
      expect(getUpcomingMilestoneTime(list[5], NOW)).toBeNull();
      // Control: a dated one is not null.
      expect(getUpcomingMilestoneTime(list[1], NOW)).toBe(new Date(inDays(5)).getTime());
    });
  });

  describe('title and created_at', () => {
    it('sorts titles A-Z case-insensitively, and reverses them descending', () => {
      const list = [
        published({ id: 'b', title: 'beta' }),
        published({ id: 'c', title: 'Charlie' }),
        published({ id: 'a', title: 'Alpha' }),
      ];
      expect(ids(sortStudies(list, 'title', 'asc', NOW))).toEqual(['a', 'b', 'c']);
      expect(ids(sortStudies(list, 'title', 'desc', NOW))).toEqual(['c', 'b', 'a']);
    });

    it('sorts created_at by instant, not by string', () => {
      const list = [
        published({ id: 'mar', created_at: '2026-03-01T00:00:00Z' }),
        published({ id: 'jan', created_at: '2026-01-01T00:00:00Z' }),
        published({ id: 'feb', created_at: '2026-02-01T00:00:00Z' }),
      ];
      expect(ids(sortStudies(list, 'created_at', 'asc', NOW))).toEqual(['jan', 'feb', 'mar']);
      expect(ids(sortStudies(list, 'created_at', 'desc', NOW))).toEqual(['mar', 'feb', 'jan']);
    });
  });
});

describe('the closing-soon horizon (3 days)', () => {
  it('is 3 days - pinned as a literal', () => {
    expect(CLOSING_SOON_DAYS).toBe(3);
  });

  it('colours a milestone inside 3 days, including exactly 3 days away', () => {
    expect(isMilestoneSoon({ kind: 'session', date: new Date(inDays(1)) }, NOW)).toBe(true);
    expect(isMilestoneSoon({ kind: 'deadline', date: new Date(NOW.getTime() + 3 * DAY) }, NOW)).toBe(true);
  });

  it('does not colour one a millisecond past 3 days, a completed one, or none', () => {
    expect(isMilestoneSoon({ kind: 'session', date: new Date(NOW.getTime() + 3 * DAY + 1) }, NOW)).toBe(false);
    expect(isMilestoneSoon({ kind: 'completed', date: new Date(inDays(1)) }, NOW)).toBe(false);
    expect(isMilestoneSoon(null, NOW)).toBe(false);
    // A past date is not "soon" either.
    expect(isMilestoneSoon({ kind: 'deadline', date: new Date(NOW.getTime() - 1) }, NOW)).toBe(false);
  });

  it('is the same default horizon the Closing soon card and chip use - floor(daysLeft) <= 3, so a few hours past 3 days still counts (D1)', () => {
    // isClosingSoon floors the days-left count (D1: "the close label reads 3
    // days or fewer"), so 3 days + 1 hour still floors to 3 and counts too -
    // only a full 4th day away falls outside. Through the default argument.
    const inside = published({ id: 'in', sessions: [], type: 'unmoderated', end_date: inDays(3) });
    const alsoInside = published({
      id: 'also-in',
      sessions: [],
      type: 'unmoderated',
      end_date: new Date(NOW.getTime() + 3 * DAY + 60 * 60 * 1000).toISOString(),
    });
    const outside = published({ id: 'out', sessions: [], type: 'unmoderated', end_date: inDays(4) });
    expect(ids(getStudiesClosingSoon([inside, alsoInside, outside], NOW))).toEqual(['in', 'also-in']);
  });

  // TESTLANE-C section 2: the D1 isClosingSoon boundary, probed at the four
  // named days.
  it('is true at 2.9, 3.2 and 3.99 days, and false at a full 4.0 days (D1 boundary probes: isClosingSoon floors, unlike isMilestoneSoon\'s exact 72h)', () => {
    const at = (days: number, id: string) =>
      published({ id, sessions: [], type: 'unmoderated', end_date: new Date(NOW.getTime() + days * DAY).toISOString() });
    const cases = [
      [2.9, true],
      [3.2, true],
      [3.99, true],
      [4.0, false],
    ] as const;
    for (const [days, expected] of cases) {
      const study = at(days, `d-${days}`);
      // isNextNoteWarned IS isClosingSoon (floor(daysLeft) <= 3) - not
      // isMilestoneSoon, which keeps its own exact 72h cutoff (see "does not
      // colour one a millisecond past 3 days" above): the two genuinely
      // disagree between 3 and 4 days, by design.
      expect(isNextNoteWarned(study, NOW)).toBe(expected);
      expect(ids(getStudiesClosingSoon([study], NOW))).toEqual(expected ? [study.id] : []);
    }
  });

  it('a draft or closed study is never closing soon, however close its date is (control)', () => {
    const soon = new Date(NOW.getTime() + DAY).toISOString();
    const draftSoon = { ...published({ id: 'd', sessions: [], type: 'unmoderated', end_date: soon }), status: 'draft' as const };
    const closedSoon = { ...published({ id: 'c', sessions: [], type: 'unmoderated', end_date: soon }), status: 'closed' as const };
    expect(getStudiesClosingSoon([draftSoon, closedSoon], NOW)).toEqual([]);
  });
});

describe('the Broken status filter (Petra 3.3)', () => {
  it("sends Broken to the server as 'published'", () => {
    expect(statusFilterToWire('broken')).toBe('published');
  });

  it('passes the stored statuses through and sends nothing for All Statuses', () => {
    expect(statusFilterToWire('draft')).toBe('draft');
    expect(statusFilterToWire('published')).toBe('published');
    expect(statusFilterToWire('closed')).toBe('closed');
    expect(statusFilterToWire('')).toBeUndefined();
  });

  it('narrows the published rows to the broken ones client-side', () => {
    expect(matchesStatusFilter(broken(), 'broken')).toBe(true);
    expect(matchesStatusFilter(published(), 'broken')).toBe(false);
    expect(matchesStatusFilter(draft(), 'broken')).toBe(false);
    // A broken study is still published for the Published option.
    expect(matchesStatusFilter(broken(), 'published')).toBe(true);
    expect(matchesStatusFilter(closed(), '')).toBe(true);
  });
});

describe('quick-filter chips', () => {
  it('orders the chips with Broken first', () => {
    expect(QUICK_FILTERS.map((c) => c.label)).toEqual([
      'Broken',
      'Needs recruitment',
      'Draft',
      'Closing soon',
      'Fully booked',
    ]);
  });

  it('counts what each chip would show, including zeros', () => {
    const list = [
      broken({ id: 'b1' }),
      broken({ id: 'b2', type: 'interview' }),
      draft({ id: 'd1' }),
      published({ id: 'recruit', sessions: [session(10, { capacity: 3, booked_count: 1 })] }),
      published({ id: 'full', sessions: [session(10, { capacity: 2, booked_count: 2 })] }),
      closed({ id: 'c1' }),
    ];
    expect(getQuickFilterCounts(list, NOW)).toEqual({
      broken: 2,
      'needs-recruitment': 1,
      draft: 1,
      'closing-soon': 0,
      'fully-booked': 1,
    });
  });
});

describe('isAutoClosed (the "Auto-closed" caption)', () => {
  it('does not caption a closed study whose response carries no auto_closed field (it says nothing about how)', () => {
    expect(isAutoClosed(closed())).toBe(false);
  });

  it('does not caption a closed study the server says closed by hand (auto_closed: false)', () => {
    expect(isAutoClosed({ ...closed(), auto_closed: false })).toBe(false);
  });

  it('captions auto_closed: true, and never a study that is not closed', () => {
    expect(isAutoClosed({ ...closed(), auto_closed: true })).toBe(true);
    expect(isAutoClosed(published())).toBe(false);
    expect(isAutoClosed({ ...draft(), auto_closed: true })).toBe(false);
  });
});

describe("the row's inline button (Petra 3.4)", () => {
  const OWNER = { id: 'me', role: 'researcher_admin' };
  const COLLEAGUE_VIEWER = { id: 'someone-else', role: 'researcher_admin' };
  const SUPER = { id: 'super', role: 'superadmin' };

  it('offers Fix on a broken study, to its edit page', () => {
    expect(getPrimaryStudyAction(broken({ id: 'x', owner_user_id: 'me' }), OWNER)).toEqual({
      label: 'Fix',
      to: '/admin/opportunities/x/edit',
    });
  });

  it('offers Edit on a draft, to its edit page', () => {
    expect(getPrimaryStudyAction(draft({ id: 'x', owner_user_id: 'me' }), OWNER)).toEqual({
      label: 'Edit',
      to: '/admin/opportunities/x/edit',
    });
  });

  it('offers Analytics on your own published or closed study', () => {
    for (const study of [published({ id: 'x', owner_user_id: 'me' }), closed({ id: 'x', owner_user_id: 'me' })]) {
      expect(getPrimaryStudyAction(study, OWNER)).toEqual({
        label: 'Analytics',
        to: '/admin/opportunities/x/analytics',
      });
    }
  });

  it("offers Preview on someone else's published study, to the participant page", () => {
    expect(getPrimaryStudyAction(published({ id: 'x', owner_user_id: 'me' }), COLLEAGUE_VIEWER)).toEqual({
      label: 'Preview',
      to: '/opportunities/x',
    });
  });

  it("offers a superadmin Analytics on anyone's published study", () => {
    expect(getPrimaryStudyAction(published({ id: 'x', owner_user_id: 'me' }), SUPER).label).toBe('Analytics');
  });

  it("offers Preview, not Fix or Edit, on someone else's broken study or draft (review P4)", () => {
    // The server refuses a non-owner's save, so Fix and Edit would lead to
    // an edit page that cannot save.
    expect(getPrimaryStudyAction(broken({ id: 'x', owner_user_id: 'me' }), COLLEAGUE_VIEWER)).toEqual({
      label: 'Preview',
      to: '/opportunities/x',
    });
    expect(getPrimaryStudyAction(draft({ id: 'x', owner_user_id: 'me' }), COLLEAGUE_VIEWER)).toEqual({
      label: 'Preview',
      to: '/opportunities/x',
    });
    // A superadmin still gets them.
    expect(getPrimaryStudyAction(broken({ id: 'x', owner_user_id: 'me' }), SUPER).label).toBe('Fix');
    expect(getPrimaryStudyAction(draft({ id: 'x', owner_user_id: 'me' }), SUPER).label).toBe('Edit');
  });

  it('never treats a missing viewer id as owning an ownerless study', () => {
    // undefined === undefined would otherwise hand every ownerless study to
    // an id-less viewer.
    expect(canManageStudy(published({ owner_user_id: undefined }), { role: 'researcher_admin' })).toBe(false);
    expect(canManageStudy(published({ owner_user_id: 'me' }), null)).toBe(false);
    expect(canManageStudy(published({ owner_user_id: 'me' }), OWNER)).toBe(true);
  });
});

describe('the Study Type filter, client-side (review P1)', () => {
  it('matches the chosen type, and everything for All Types', () => {
    expect(matchesTypeFilter(opp({ type: 'interview' }), 'interview')).toBe(true);
    expect(matchesTypeFilter(opp({ type: 'test' }), 'interview')).toBe(false);
    expect(matchesTypeFilter(opp({ type: 'test' }), '')).toBe(true);
  });
});

describe('day labels round DOWN; the colour horizon is 72 hours (round 3)', () => {
  // Session day labels count CALENDAR days in the local zone, so they are
  // pinned from a local 09:00 (a Wednesday, no clock change that week).
  const NINE_AM = new Date(2026, 8, 23, 9, 0, 0);
  const from9 = (days: number) => new Date(NINE_AM.getTime() + days * DAY);

  it('labels 2.9 and 3.2 days both "in 3 days" (calendar days, not rounded-up time)', () => {
    // Round 3 reverted the fix round's ceil(): 3.2 days is "in 3 days" again.
    expect(relativeDayLabel(from9(2.9), NINE_AM)).toBe('in 3 days');
    expect(relativeDayLabel(from9(3.2), NINE_AM)).toBe('in 3 days');
  });

  it('keeps Today, Tomorrow and the week cap', () => {
    expect(relativeDayLabel(from9(0.1), NINE_AM)).toBe('Today');
    expect(relativeDayLabel(from9(1), NINE_AM)).toBe('Tomorrow');
    expect(relativeDayLabel(from9(6), NINE_AM)).toBe('in 6 days');
    expect(relativeDayLabel(from9(7), NINE_AM)).toBeNull();
    expect(relativeDayLabel(from9(-1), NINE_AM)).toBeNull();
  });

  it('colours up to and including 72 hours, and not a millisecond after', () => {
    const soon = (ms: number) => isMilestoneSoon({ kind: 'deadline', date: new Date(NOW.getTime() + ms) }, NOW);
    expect(soon(2.9 * DAY)).toBe(true);
    expect(soon(72 * 60 * 60 * 1000)).toBe(true);
    expect(soon(72 * 60 * 60 * 1000 + 1)).toBe(false);
    expect(soon(3.2 * DAY)).toBe(false);
  });
});

describe('a closed study has no next milestone and is never coloured (round 3)', () => {
  const closedWithFuture = closed({
    id: 'c',
    sessions: [session(1)],
    end_date: new Date(NOW.getTime() + 2 * DAY).toISOString(),
  });

  it("reads its future closing date as 'closed', not as a deadline", () => {
    const milestone = getNextMilestone(closedWithFuture, NOW);
    expect(milestone?.kind).toBe('closed');
    expect(getUpcomingMilestoneTime(closedWithFuture, NOW)).toBeNull();
    expect(isMilestoneSoon(milestone, NOW)).toBe(false);
  });

  it('is never warned, where the same dates on a published study are (the control)', () => {
    expect(isNextNoteWarned(closedWithFuture, NOW)).toBe(false);
    expect(isNextNoteWarned({ ...closedWithFuture, status: 'published' }, NOW)).toBe(true);
  });

  it('reads a closed study with only a future slot as closed too', () => {
    expect(getNextMilestone(closed({ id: 'c2', sessions: [session(1)] }), NOW)?.kind).toBe('closed');
  });

  it('sorts last on Next in both directions, after the dated rows', () => {
    const list = [
      closedWithFuture,
      published({ id: 'p5', title: 'P5', sessions: [session(5)] }),
      published({ id: 'p1', title: 'P1', sessions: [session(1)] }),
    ];
    expect(ids(sortStudies(list, 'next', 'asc', NOW))).toEqual(['p1', 'p5', 'c']);
    expect(ids(sortStudies(list, 'next', 'desc', NOW))).toEqual(['p5', 'p1', 'c']);
  });
});

describe('the Next note colour is the Closing soon chip\'s own test (round 4)', () => {
  it('colours a study whose window ends inside 72h even though its next session is later - and the milestone ITSELF now names the close date (D1: getNextMilestone)', () => {
    const windowSoon = published({ id: 'w', sessions: [session(5)], end_date: new Date(NOW.getTime() + 2 * DAY).toISOString() });
    expect(matchesQuickFilter(windowSoon, 'closing-soon', NOW)).toBe(true);
    // D1: "a closing-soon study's note shows its close milestone" - unconditionally,
    // even though a session sits later - so getNextMilestone itself already
    // switches to the deadline kind/date, and that milestone is soon too.
    expect(getNextMilestone(windowSoon, NOW)).toEqual({ kind: 'deadline', date: new Date(NOW.getTime() + 2 * DAY) });
    expect(isMilestoneSoon(getNextMilestone(windowSoon, NOW), NOW)).toBe(true);
    expect(isNextNoteWarned(windowSoon, NOW)).toBe(true);
  });

  it('does not colour the same session with no window inside 72h (the control)', () => {
    const noWindow = published({ id: 'n', sessions: [session(5)] });
    expect(isNextNoteWarned(noWindow, NOW)).toBe(false);
  });
});
