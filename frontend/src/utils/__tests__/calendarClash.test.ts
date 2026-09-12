import { describe, it, expect } from 'vitest';

import { describeCalendarClash } from '../calendarClash';
import { CalendarEvent } from '../../api/types';

const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'evt-1',
  title: 'Team standup',
  start: '2026-09-15T09:00:00.000Z',
  end: '2026-09-15T09:30:00.000Z',
  startTime: new Date('2026-09-15T09:00:00.000Z'),
  endTime: new Date('2026-09-15T09:30:00.000Z'),
  status: 'confirmed',
  attendees: [],
  ...overrides,
});

describe('describeCalendarClash', () => {
  it('names the event and its own time range', () => {
    const result = describeCalendarClash(event({}));
    expect(result).toMatch(/^Clashes with 'Team standup', /);
    // The range is the event's, formatted by formatTimeRange (en-dash).
    expect(result).toMatch(/\d{2}:\d{2} – \d{2}:\d{2}$/);
  });

  it('falls back to a generic name when the event has no title', () => {
    expect(describeCalendarClash(event({ title: '' }))).toMatch(/^Clashes with 'another event', /);
    expect(describeCalendarClash(event({ title: '   ' }))).toMatch(/^Clashes with 'another event', /);
  });

  it('drops the range when the times cannot be formatted', () => {
    const result = describeCalendarClash(event({ start: '', end: '' }));
    expect(result).toBe("Clashes with 'Team standup'");
  });
});
