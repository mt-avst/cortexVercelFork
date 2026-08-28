import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';

import { UserCalendarService, MAX_DEMO_CALENDAR_DAYS } from '../userCalendar';

/**
 * cto/AdaptaLabs#96 - the demo calendar must answer the same question the same
 * way twice.
 *
 * `generateMockEvents` chose its event times with `Math.random()` and ran fresh
 * on every `GET /api/calendar/my-events`. Nothing was seeded or cached, so a
 * researcher asking for the same week twice got different busy times, and the
 * slot picker reshuffled which slots it dimmed on every page load. Measured on
 * `10e4fc7`: three identical calls returned `08:30 12:15 09:15 10:45 14:00`,
 * then `15:15 10:45 15:00 14:30 08:00`, then `13:00 09:00 13:15 11:00 10:30`.
 *
 * The second half of the bug was who could see what. The documented 10am / 2pm
 * / 3pm conflicts lived behind
 *
 *     const isDemoUser1 = userId === 'a1b2c3d4-...' || !userId;
 *
 * and that id is the `/auth/demo-login` EMPLOYEE, who cannot reach the admin
 * Session Management picker at all. A `researcher_admin` - the only role that
 * can - fell to an `else` branch using `9 + Math.floor(Math.random() * 8)`. So
 * the behaviour `GOOGLE_CALENDAR_SETUP.md` promises was unreachable by anyone
 * in a position to look at it.
 *
 * These tests are written against the PUBLIC entry point rather than the
 * private generator, because "demo mode returns mock events" is the contract
 * that matters and the branch into the generator is part of it.
 */

// A window built in LOCAL time, because the generator uses `setHours` - a
// UTC-shaped fixture would pass or fail depending on the machine's timezone.
//
// IT DELIBERATELY SPANS A WEEKEND. An earlier version of this file ran Monday
// to Friday, and the "places no event on a Saturday" assertion below then
// survived a mutation that removed the weekday filter altogether: there was no
// weekend in range for the filter to exclude, so the test could not fail.
const RANGE_START = new Date(2026, 7, 28, 0, 0, 0, 0); // Fri 28 Aug 2026
const RANGE_END = new Date(2026, 8, 4, 23, 59, 59, 999); // Fri 4 Sep 2026

const A_RESEARCHER_ADMIN = '633608bc-4b0e-4d60-a498-e680ee97c252';
const DEMO_USER_1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const fetchEvents = (service: UserCalendarService, userId?: string) =>
  service.getUserCalendarEvents(
    'demo-access-token',
    RANGE_START.toISOString(),
    RANGE_END.toISOString(),
    userId
  );

/** Local hour:minute, so an assertion cannot be satisfied by a UTC coincidence. */
const localHhMm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Local calendar date, for the same reason `localHhMm` reads local hours. */
const localYmd = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fingerprint = (events: { start: string; end: string; title: string }[]) =>
  events
    .map(e => `${e.start}|${e.end}|${e.title}`)
    .sort()
    .join('\n');

describe('the demo calendar', () => {
  const savedId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  let service: UserCalendarService;

  beforeEach(() => {
    // Demo mode is decided in the constructor from these two variables being
    // absent. Deleting them here is what puts the service on the mock path.
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    service = new UserCalendarService();
  });

  afterEach(() => {
    if (savedId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = savedId;
    if (savedSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedSecret;
  });

  describe('is stable', () => {
    it('returns the identical set of events for the same user and window, ten times over', async () => {
      const first = fingerprint(await fetchEvents(service, A_RESEARCHER_ADMIN));

      for (let attempt = 2; attempt <= 10; attempt++) {
        const again = fingerprint(await fetchEvents(service, A_RESEARCHER_ADMIN));
        expect({ attempt, events: again }).toEqual({ attempt, events: first });
      }
    });

    it('is stable across a fresh service instance, not merely memoised on one', async () => {
      const first = fingerprint(await fetchEvents(service, A_RESEARCHER_ADMIN));
      const other = new UserCalendarService();

      expect(fingerprint(await fetchEvents(other, A_RESEARCHER_ADMIN))).toBe(first);
    });

    /**
     * The control for the two tests above. An empty array is trivially stable,
     * so determinism on its own would pass just as well against a generator
     * that had stopped generating anything - which is the whole point of the
     * demo calendar.
     */
    it('still produces events at all, so stability is not just an empty list', async () => {
      const events = await fetchEvents(service, A_RESEARCHER_ADMIN);

      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('shows the conflicts the documentation promises', () => {
    /**
     * GOOGLE_CALENDAR_SETUP.md: "mock busy time appears at 10am/2pm/3pm,
     * aligned with the demo sessions". Asserted as literal local times, not
     * derived from the implementation's own table, so moving an anchor has to
     * fail here by name.
     */
    it.each([
      ['a researcher admin - the only role that can see the picker', A_RESEARCHER_ADMIN],
      ['demo user 1', DEMO_USER_1],
      ['a caller that supplied no user id', undefined],
    ])('gives %s busy time at 10:00, 14:00 and 15:00', async (_label, userId) => {
      const starts = new Set((await fetchEvents(service, userId)).map(e => localHhMm(e.start)));

      expect(starts).toContain('10:00');
      expect(starts).toContain('14:00');
      expect(starts).toContain('15:00');
    });

    /**
     * Start times alone are not the contract. How LONG a conflict runs is what
     * decides how many 30-minute slots the picker dims, and an assertion on
     * starts survived a mutation that stretched the 15:00 conflict from 45
     * minutes to 105 - which would have blacked out the rest of the afternoon.
     * The windows are written out literally rather than derived from the
     * implementation's table, so changing one has to fail here by name.
     */
    it('blocks exactly three windows on a weekday, ends included', async () => {
      const events = await fetchEvents(service, A_RESEARCHER_ADMIN);
      const tuesday = events
        .filter(e => localYmd(e.start) === '2026-09-01')
        .map(e => `${localHhMm(e.start)}-${localHhMm(e.end)}`)
        .sort();

      expect(tuesday).toEqual(['10:00-11:00', '14:00-15:00', '15:00-15:45']);
    });

    it('leaves ordinary working time free, so the picker is not blocked end to end', async () => {
      const starts = new Set((await fetchEvents(service, A_RESEARCHER_ADMIN)).map(e => localHhMm(e.start)));

      expect(starts).not.toContain('09:00');
      expect(starts).not.toContain('16:00');
    });
  });

  describe('stays inside the boundaries it was given', () => {
    it('places no event on a Saturday or a Sunday', async () => {
      const events = await fetchEvents(service, A_RESEARCHER_ADMIN);
      const weekendDays = events
        .map(e => new Date(e.start))
        .filter(d => d.getDay() === 0 || d.getDay() === 6)
        .map(d => d.toISOString());

      expect(weekendDays).toEqual([]);
    });

    /**
     * The control for the weekend assertion, twice over: a filter that dropped
     * everything would satisfy it, and so would a window containing no weekend.
     * Naming the exact weekdays proves both that the generator populates days
     * and that Sat 29 and Sun 30 August were genuinely in range to be skipped.
     */
    it('populates exactly the weekdays in the window, so the weekend check has something to exclude', async () => {
      const events = await fetchEvents(service, A_RESEARCHER_ADMIN);
      const days = [...new Set(events.map(e => localYmd(e.start)))].sort();

      expect(days).toEqual([
        '2026-08-28', // Fri
        // Sat 29 and Sun 30 are in the window and must not appear
        '2026-08-31', // Mon
        '2026-09-01',
        '2026-09-02',
        '2026-09-03',
        '2026-09-04', // Fri
      ]);
    });

    /**
     * A window that CLIPS. The previous version of this test used a midnight-to-
     * midnight range, so every event was inside it whatever the code did, and
     * the assertion survived a mutation that deleted the bounds check entirely.
     *
     * 11:00 to 15:30 on a single weekday admits only the 14:00 conflict: the
     * 10:00 one starts before the window opens, and the 15:00 one runs to 15:45,
     * past the close.
     */
    it('drops an event whose start is before the window, or whose end is past it', async () => {
      const from = new Date(2026, 8, 1, 11, 0, 0, 0); // Tue 1 Sep, 11:00 local
      const to = new Date(2026, 8, 1, 15, 30, 0, 0); // 15:30 local

      const events = await service.getUserCalendarEvents(
        'demo-access-token',
        from.toISOString(),
        to.toISOString(),
        A_RESEARCHER_ADMIN
      );

      expect(events.map(e => `${localHhMm(e.start)}-${localHhMm(e.end)}`)).toEqual(['14:00-15:00']);
    });

    /**
     * `start_time` and `end_time` reach the generator as unvalidated strings,
     * so the window is whatever the caller asked for and the day-walk needs its
     * own ceiling. The number is asserted as a LITERAL: a test that read
     * `MAX_DEMO_CALENDAR_DAYS` to build its expectation would keep passing at
     * any value, including one high enough to be no ceiling at all.
     */
    it('holds the day ceiling at the number that was decided', () => {
      expect(MAX_DEMO_CALENDAR_DAYS).toBe(62);
    });

    it('stops walking at the ceiling rather than honouring a two-century window', async () => {
      const events = await service.getUserCalendarEvents(
        'demo-access-token',
        new Date(2026, 0, 1, 0, 0, 0, 0).toISOString(),
        new Date(2226, 0, 1, 0, 0, 0, 0).toISOString(),
        A_RESEARCHER_ADMIN
      );

      const days = new Set(events.map(e => localYmd(e.start)));

      // 62 days from Thu 1 Jan 2026 covers 44 weekdays, three conflicts each.
      expect(days.size).toBe(44);
      expect(events).toHaveLength(44 * 3);
      // The last day walked is 62 days on, and nothing beyond it appears.
      expect([...days].sort().at(-1)).toBe('2026-03-03');
    });

    it('never starts before the range or ends after it', async () => {
      const events = await fetchEvents(service, A_RESEARCHER_ADMIN);
      const outside = events.filter(
        e => new Date(e.start) < RANGE_START || new Date(e.end) > RANGE_END
      );

      expect(outside).toEqual([]);
    });
  });
});
