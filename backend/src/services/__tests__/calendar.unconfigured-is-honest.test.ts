import { describe, expect, it } from '@jest/globals';

import { CalendarService } from '../calendar';

/**
 * cto/AdaptaLabs#89 part 1 - the shared calendar service must not report
 * success for work it did not do.
 *
 * `initializeAuth` was unconditional (`this.calendar = null`, "demo mode"), so
 * every write took a branch that returned `{ success: true, eventId:
 * 'demo-event-<now>' }`. A real production booking answered
 * `{"calendar":"success","calendarEventId":"demo-event-1787829699354"}` and no
 * event existed anywhere. A researcher books participants and reasonably
 * believes invites went out.
 *
 * The fabricated id was the worst part: it was WRITTEN TO `bookings
 * .gcal_event_id`, so the database recorded a Google event that had never been
 * created, and cancellation later tried to delete it.
 */

const anEvent = () => ({
  id: '',
  title: 'Research session with Ada',
  start: '2026-09-01T13:00:00.000Z',
  end: '2026-09-01T13:30:00.000Z',
  startTime: new Date('2026-09-01T13:00:00.000Z'),
  endTime: new Date('2026-09-01T13:30:00.000Z'),
  description: 'A session',
  status: 'confirmed' as const,
  attendees: [{ email: 'ada@example.com', name: 'Ada', responseStatus: 'needsAction' as const }],
});

describe('CalendarService - an unconfigured calendar refuses rather than pretending (#89)', () => {
  it('refuses createEvent instead of returning a fabricated event id', async () => {
    const service = new CalendarService({});

    const result = await service.createEvent(anEvent());

    expect(result.success).toBe(false);
    expect(result.eventId).toBeUndefined();
    expect(result.error).toBe('Calendar is not configured');
  });

  it('never returns an id that looks like a real Google event id', async () => {
    const service = new CalendarService({});

    const result = await service.createEvent(anEvent());

    // The specific string that reached production. Pinned as a literal because
    // a test that derives the expectation from the code cannot see the code
    // change back.
    expect(JSON.stringify(result)).not.toMatch(/demo-event-/);
  });

  it('refuses updateEvent and deleteEvent', async () => {
    const service = new CalendarService({});

    await expect(service.updateEvent('evt-1', anEvent())).resolves.toEqual({
      success: false,
      error: 'Calendar is not configured',
    });
    await expect(service.deleteEvent('evt-1')).resolves.toEqual({
      success: false,
      error: 'Calendar is not configured',
    });
  });

  it('refuses getEvent instead of answering with a fictional confirmed event', async () => {
    const service = new CalendarService({});

    const result = await service.getEvent('evt-1');

    expect(result.success).toBe(false);
    expect(result.event).toBeUndefined();
    // It used to answer `{ id, summary: 'Demo Event', status: 'confirmed' }`,
    // which is an assertion that a specific event exists and is confirmed.
    expect(JSON.stringify(result)).not.toMatch(/Demo Event/);
  });

  it('still reads zero events successfully, and says the calendar is unconfigured', async () => {
    const service = new CalendarService({});

    const result = await service.getCalendarEvents(
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-08T00:00:00.000Z')
    );

    // The DELIBERATE exception to the rule above, and the reason it is
    // deliberate is asserted in the next test. "No busy events are known" is a
    // true statement about an unconfigured calendar; refusing here would take
    // the slot picker down with it.
    expect(result.success).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.configured).toBe(false);
  });

  it('still generates availability, so authoring survives an unconfigured calendar', async () => {
    const service = new CalendarService({});

    const result = await service.checkTimeSlotAvailability(
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-02T00:00:00.000Z'),
      30
    );

    // The control for the exception above. If a future tidy-up makes
    // getCalendarEvents refuse when unconfigured, THIS is the test that fails -
    // and it fails describing the user-visible consequence (#89: "No available
    // slots" on every column, no way to author a bookable slot at all) rather
    // than an internal flag.
    expect(result.success).toBe(true);
    expect((result.availableSlots ?? []).length).toBeGreaterThan(0);
  });
});
