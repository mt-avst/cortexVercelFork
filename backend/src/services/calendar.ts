import { google } from 'googleapis';
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

export class CalendarService {
  private auth: any;
  private calendar: any;
  private config: CalendarServiceConfig;

  constructor(config: CalendarServiceConfig) {
    this.config = config;
    this.initializeAuth();
  }

  private initializeAuth() {
    if (this.config.serviceAccountEmail && this.config.privateKey) {
      // Service account authentication
      this.auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: this.config.serviceAccountEmail,
          private_key: this.config.privateKey.replace(/\\n/g, '\n'),
        },
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
    } else {
      // For demo purposes, we'll use a mock implementation
      console.log('📅 Calendar service initialized in demo mode');
      this.auth = null;
    }

    if (this.auth) {
      this.calendar = google.calendar({ version: 'v3', auth: this.auth });
    }
  }

  async createEvent(event: CalendarEvent): Promise<{ success: boolean; eventId?: string; error?: string }> {
    try {
      if (!this.calendar) {
        // Demo mode - return mock success
        const mockEventId = `demo-event-${Date.now()}`;
        console.log(`📅 Demo: Created calendar event "${event.title}" for ${event.startTime.toISOString()}`);
        return { success: true, eventId: mockEventId };
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
        // Demo mode - return mock success
        console.log(`📅 Demo: Updated calendar event ${eventId} "${event.title}"`);
        return { success: true };
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
        // Demo mode - return mock success
        console.log(`📅 Demo: Deleted calendar event ${eventId}`);
        return { success: true };
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
        // Demo mode - return mock event
        return { 
          success: true, 
          event: { 
            id: eventId, 
            summary: 'Demo Event',
            status: 'confirmed'
          } 
        };
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

  async getCalendarEvents(
    startTime: Date, 
    endTime: Date, 
    calendarId?: string
  ): Promise<{ success: boolean; events?: any[]; error?: string }> {
    try {
      if (!this.calendar) {
        // Demo mode - return empty events for testing (no conflicts)
        const mockEvents: any[] = [];
        console.log(`📅 Demo: Fetched ${mockEvents.length} calendar events (conflict checking disabled for testing)`);
        return { success: true, events: mockEvents };
      }

      const response = await this.calendar.events.list({
        calendarId: calendarId || this.config.calendarId || 'primary',
        timeMin: startTime.toISOString(),
        timeMax: endTime.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 1000
      });

      return { success: true, events: response.data.items || [] };
    } catch (error: any) {
      console.error('Error fetching calendar events:', error);
      return { success: false, error: error.message };
    }
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
        
        // Generate consistent time slots for this day (9 AM to 11 PM) in UTC
        // Calculate how many slots fit in the working day (9 AM to 11 PM = 14 hours)
        const workingDayStartHour = 9; // 9 AM UTC
        const workingDayEndHour = 23; // 11 PM UTC
        const workingDayDurationMs = (workingDayEndHour - workingDayStartHour) * 60 * 60 * 1000; // 14 hours in ms
        const slotsPerDay = Math.floor(workingDayDurationMs / slotDurationMs);
        
        // Generate slots starting from 9 AM UTC, with consistent intervals
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
