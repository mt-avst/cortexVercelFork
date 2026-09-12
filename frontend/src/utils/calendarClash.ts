import { CalendarEvent } from '../api/types';
import { formatTimeRange } from './datetime';

/**
 * BK-2: one sentence naming the participant's own diary event a session
 * clashes with, e.g. "Clashes with 'Team standup', 10:00 – 10:30".
 *
 * Shared by the table view (OpportunityDetail) and the calendar view
 * (CalendarGrid) so a clash is named identically wherever it is shown. The
 * time range is the CLASHING EVENT's, not the session's - it is what tells the
 * participant why the slot is unavailable to them.
 */
export const describeCalendarClash = (event: CalendarEvent): string => {
  const name = event.title?.trim() || 'another event';
  const range = formatTimeRange(event.start, event.end);
  return range ? `Clashes with '${name}', ${range}` : `Clashes with '${name}'`;
};
