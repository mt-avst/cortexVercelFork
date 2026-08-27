import { config } from '../config';
import { logger } from '../utils/logger';
import { CalendarEvent, AvailableSlot, AvailabilityResponse, ConflictCheckResponse } from '../../../shared/types';
import { CALENDAR_CONFIG } from '../../../shared/constants';

export interface CalendarServiceConfig {
  serviceAccountEmail?: string;
  privateKey?: string;
  calendarId?: string;
  domainWideDelegation?: boolean;
}

/**
 * What an unconfigured calendar answers.
 *
 * Exported because routes/bookings.ts branches on it in three places; three
 * copies of the string literal is three chances for one of them to drift.
 */
export const CALENDAR_NOT_CONFIGURED = 'Calendar is not configured';

export class CalendarService {
  private auth: any;
  private calendar: any;
  private config: CalendarServiceConfig;

  constructor(config: CalendarServiceConfig) {
    this.config = config;
    this.initializeAuth();
  }

  /**
   * cto/AdaptaLabs#89.
   *
   * This shared service-account client has NO implementation and there is no
   * value of any environment variable that turns one on. That was true before
   * this change too - `initializeAuth` was unconditional - but it was recorded
   * as "demo mode" at INFO while the constructor below read three GOOGLE_*
   * variables that nothing consumed. A deployment that looked configurable and
   * was not is the trap the issue is really about: setting those variables in
   * Kubera changed nothing at all.
   *
   * So the state is named honestly and reported at WARN when someone has
   * actually supplied credentials, because that is the case where a human is
   * expecting an effect and will not get one. Per-user calendars are the
   * direction being taken instead (services/userCalendar.ts, which does have a
   * real Google REST implementation).
   */
  private initializeAuth() {
    this.auth = null;
    this.calendar = null;

    const supplied = Boolean(this.config.serviceAccountEmail || this.config.privateKey || this.config.calendarId);
    if (supplied) {
      logger.warn(
        'Shared Google Calendar credentials were supplied but this service has no client: no events will be created. ' +
        'Per-user calendars are handled by services/userCalendar.ts (cto/AdaptaLabs#89).',
        { hasServiceAccountEmail: Boolean(this.config.serviceAccountEmail), hasCalendarId: Boolean(this.config.calendarId) }
      );
      return;
    }

    logger.info('Shared Google Calendar is not configured: calendar writes will be refused, not simulated');
  }

  async createEvent(event: CalendarEvent): Promise<{ success: boolean; eventId?: string; error?: string }> {
    try {
      if (!this.calendar) {
        // Refused, NOT simulated. This used to answer
        // `{ success: true, eventId: 'demo-event-<now>' }`, and the caller wrote
        // that fabricated id into `bookings.gcal_event_id` - so the database
        // recorded a Google event that had never existed and cancellation later
        // tried to delete it. Reporting the truth is cheaper than any of that.
        // Deliberately at DEBUG and deliberately WITHOUT the title.
        //
        // `event.title` is built by the booking route as
        // `<opportunity title> with <participant name>`, so a WARN here wrote a
        // participant's name and which study they are in to the production log
        // on EVERY booking. The caller logs this condition once at INFO with a
        // booking id, and initializeAuth warns once at boot if credentials were
        // supplied - between them the steady state is recorded without either
        // the personal data or the alert dilution.
        logger.debug('Refusing to create a calendar event: calendar is not configured', {
          startTime: event.startTime.toISOString(),
        });
        return { success: false, error: CALENDAR_NOT_CONFIGURED };
      }

      const calendarEvent = {
        summary: event.title,
        description: event.description,
        start: {
          dateTime: event.startTime.toISOString(),
          timeZone: 'UTC',
        },
        end: {
          dateTime: event.endTime.toISOString(),
          timeZone: 'UTC',
        },
        attendees: event.attendees.map(attendee => ({
          email: attendee.email,
          displayName: attendee.name,
        })),
        location: event.location,
        conferenceData: event.meetLink ? {
          createRequest: {
            requestId: `meet-${Date.now()}`,
            conferenceSolutionKey: {
              type: 'hangoutsMeet'
            }
          }
        } : undefined,
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 }, // 24 hours before
            { method: 'popup', minutes: 10 }, // 10 minutes before
          ],
        },
      };

      const response = await this.calendar.events.insert({
        calendarId: this.config.calendarId || 'primary',
        resource: calendarEvent,
        conferenceDataVersion: event.meetLink ? 1 : 0,
      });

      return { success: true, eventId: response.data.id };
    } catch (error: any) {
      console.error('Error creating calendar event:', error);
      return { success: false, error: error.message };
    }
  }

  async updateEvent(eventId: string, event: CalendarEvent): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.calendar) {
        logger.debug('Refusing to update a calendar event: calendar is not configured', { eventId });
        return { success: false, error: CALENDAR_NOT_CONFIGURED };
      }

      const calendarEvent = {
        summary: event.title,
        description: event.description,
        start: {
          dateTime: event.startTime.toISOString(),
          timeZone: 'UTC',
        },
        end: {
          dateTime: event.endTime.toISOString(),
          timeZone: 'UTC',
        },
        attendees: event.attendees.map(attendee => ({
          email: attendee.email,
          displayName: attendee.name,
        })),
        location: event.location,
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 }, // 24 hours before
            { method: 'popup', minutes: 10 }, // 10 minutes before
          ],
        },
      };

      await this.calendar.events.update({
        calendarId: this.config.calendarId || 'primary',
        eventId: eventId,
        resource: calendarEvent,
      });

      return { success: true };
    } catch (error: any) {
      console.error('Error updating calendar event:', error);
      return { success: false, error: error.message };
    }
  }

  async deleteEvent(eventId: string): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.calendar) {
        logger.debug('Refusing to delete a calendar event: calendar is not configured', { eventId });
        return { success: false, error: CALENDAR_NOT_CONFIGURED };
      }

      await this.calendar.events.delete({
        calendarId: this.config.calendarId || 'primary',
        eventId: eventId,
      });

      return { success: true };
    } catch (error: any) {
      console.error('Error deleting calendar event:', error);
      return { success: false, error: error.message };
    }
  }

  async getEvent(eventId: string): Promise<{ success: boolean; event?: any; error?: string }> {
    try {
      if (!this.calendar) {
        // This answered `{ summary: 'Demo Event', status: 'confirmed' }`, which
        // is an assertion that a particular event exists and is confirmed.
        return { success: false, error: CALENDAR_NOT_CONFIGURED };
      }

      const response = await this.calendar.events.get({
        calendarId: this.config.calendarId || 'primary',
        eventId: eventId,
      });

      return { success: true, event: response.data };
    } catch (error: any) {
      console.error('Error getting calendar event:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Busy events in a range.
   *
   * The DELIBERATE exception to #89's "refuse rather than pretend": an
   * unconfigured calendar succeeds with zero events, and reports
   * `configured: false` so a caller can tell "nothing is busy" from "we cannot
   * know". "No busy events are known" is a true statement, and refusing here
   * would take `checkTimeSlotAvailability` down with it - which is the slot
   * picker, i.e. the only way to author a bookable slot. The test
   * `still generates availability, so authoring survives an unconfigured
   * calendar` is what fails if a later tidy-up makes this refuse.
   */
  async getCalendarEvents(
    _startTime: Date,
    _endTime: Date,
    _calendarId?: string
  ): Promise<{ success: boolean; events?: any[]; error?: string; configured?: boolean }> {
    if (!this.calendar) {
      logger.debug('Calendar not configured: reporting no known busy events');
      return { success: true, events: [], configured: false };
    }

    // Unreachable while initializeAuth cannot build a client. Left as a refusal
    // rather than a silent empty read so that filling that in cannot ship a
    // read path that quietly answers "nothing is busy" for a real calendar.
    return { success: false, error: 'Calendar read is not implemented', configured: true };
  }

  async checkTimeSlotAvailability(
    startTime: Date,
    endTime: Date,
    durationMinutes: number,
    calendarId?: string,
    excludeWeekends?: boolean
  ): Promise<{ success: boolean; availableSlots?: Array<{start: Date, end: Date}>; error?: string }> {
    try {
      // Extend the time range to check for conflicts
      const bufferStart = new Date(startTime.getTime() - CALENDAR_CONFIG.QUERY_BUFFER_MS);
      const bufferEnd = new Date(endTime.getTime() + CALENDAR_CONFIG.QUERY_BUFFER_MS);

      const eventsResult = await this.getCalendarEvents(bufferStart, bufferEnd, calendarId);
      
      if (!eventsResult.success) {
        return { success: false, error: eventsResult.error };
      }

      const events = eventsResult.events || [];
      
      // Filter out declined events and focus time
      const busyEvents = events.filter(event => 
        event.status !== 'cancelled' && 
        event.status !== 'declined' &&
        !event.summary?.toLowerCase().includes('focus time') &&
        !event.summary?.toLowerCase().includes('focus')
      );

      // Generate available time slots
      const availableSlots: Array<{start: Date, end: Date}> = [];
      const slotDurationMs = durationMinutes * 60 * 1000;
      
      // Generate slots for each day in the range
      const currentDate = new Date(startTime);
      currentDate.setUTCHours(0, 0, 0, 0); // Start at midnight UTC for each day
      
      while (currentDate < endTime) {
        // Skip weekends if excludeWeekends is true
        if (excludeWeekends === true) {
          const dayOfWeek = currentDate.getUTCDay(); // 0 = Sunday, 6 = Saturday
          if (dayOfWeek === 0 || dayOfWeek === 6) {
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            continue; // Skip this day
          }
        }
        
        // Generate consistent time slots for this day (7 AM to 11 PM) in UTC
        // Calculate how many slots fit in the working day (7 AM to 11 PM = 16 hours)
        const workingDayStartHour = 7; // 7 AM UTC
        const workingDayEndHour = 23; // 11 PM UTC
        const workingDayDurationMs = (workingDayEndHour - workingDayStartHour) * 60 * 60 * 1000; // 16 hours in ms
        
        // Special handling for 45-minute slots: always start on the hour
        if (durationMinutes === 45) {
          // Generate slots starting every hour from 7 AM
          for (let hour = workingDayStartHour; hour < workingDayEndHour; hour++) {
            const slotStart = new Date(currentDate);
            slotStart.setUTCHours(hour, 0, 0, 0); // Always start on the hour (minute 0)
            
            const slotEnd = new Date(slotStart.getTime() + slotDurationMs); // 45 minutes later
            
            // Skip if slot would go beyond the requested end time or working day
            if (slotStart >= endTime) break;
            if (slotEnd > endTime) break;
            if (slotEnd.getUTCHours() > workingDayEndHour || (slotEnd.getUTCHours() === workingDayEndHour && slotEnd.getUTCMinutes() > 0)) continue;
            
            // Check if this slot conflicts with any busy events
            const hasConflict = busyEvents.some(event => {
              const eventStart = new Date(event.start.dateTime || event.start.date);
              const eventEnd = new Date(event.end.dateTime || event.end.date);
              
              // Check for overlap
              return (slotStart < eventEnd && slotEnd > eventStart);
            });
            
            if (!hasConflict) {
              availableSlots.push({ start: new Date(slotStart), end: new Date(slotEnd) });
            }
          }
        } else {
          // Standard slot generation for other durations (15, 30, 60 minutes)
          const slotsPerDay = Math.floor(workingDayDurationMs / slotDurationMs);
          
          // Generate slots starting from 7 AM UTC, with consistent intervals
          for (let slotIndex = 0; slotIndex < slotsPerDay; slotIndex++) {
            const slotStart = new Date(currentDate);
            const slotStartTimeMs = workingDayStartHour * 60 * 60 * 1000 + (slotIndex * slotDurationMs);
            slotStart.setUTCHours(0, 0, 0, 0); // Reset to midnight
            slotStart.setTime(slotStart.getTime() + slotStartTimeMs); // Add the calculated time
            
            const slotEnd = new Date(slotStart.getTime() + slotDurationMs);
            
            // Skip if slot would go beyond the requested end time or working day
            if (slotStart >= endTime) break;
            if (slotEnd > endTime) break;
            if (slotStart.getUTCHours() >= workingDayEndHour) break;
            
            // Check if this slot conflicts with any busy events
            const hasConflict = busyEvents.some(event => {
              const eventStart = new Date(event.start.dateTime || event.start.date);
              const eventEnd = new Date(event.end.dateTime || event.end.date);
              
              // Check for overlap
              return (slotStart < eventEnd && slotEnd > eventStart);
            });
            
            if (!hasConflict) {
              availableSlots.push({ start: new Date(slotStart), end: new Date(slotEnd) });
            }
          }
        }
        
        // Move to next day (UTC)
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
      }

      return { success: true, availableSlots };
    } catch (error: any) {
      console.error('Error checking time slot availability:', error);
      return { success: false, error: error.message };
    }
  }
}

// Create a singleton instance
const calendarService = new CalendarService({
  serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  privateKey: process.env.GOOGLE_PRIVATE_KEY,
  calendarId: process.env.GOOGLE_CALENDAR_ID,
});

export default calendarService;
