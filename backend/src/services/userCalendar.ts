import { CalendarEvent } from '../../../shared/types';
import { logger } from '../utils/logger';
import { encrypt as secureEncrypt, decryptAuto as secureDecrypt } from '../utils/encryption';

/**
 * THE CEILING ON A DEMO CALENDAR'S SPAN (cto/AdaptaLabs#96).
 *
 * `GET /api/calendar/my-events` validates `start_time` and `end_time` as plain
 * optional strings - there is no range bound on the query - so the window handed
 * to the mock generator is whatever the caller asked for. The generator walks
 * one day at a time, and the version this replaced happened to stop early only
 * because its `eventCount < 15` counter also sat in the loop condition. Take the
 * counter away and a request for `start_time=2000-01-01&end_time=2200-01-01`
 * walks 73,000 days and builds 200,000 event objects to serialise.
 *
 * Sixty-two days is a generous two months against a picker whose own default
 * window is seven, so no real use is clipped. This is a backstop that turns
 * "as long as you like" into "bounded", not a policy anybody should be reading
 * as the supported range.
 */
export const MAX_DEMO_CALENDAR_DAYS = 62;

/**
 * User Calendar Service
 *
 * Handles user Google Calendar integration with demo mode support.
 * Automatically switches between demo and production modes based on configuration.
 */
export class UserCalendarService {
  private isDemoMode: boolean;

  constructor() {
    // Auto-detect demo mode: if credentials missing, use demo mode
    this.isDemoMode = !process.env.GOOGLE_OAUTH_CLIENT_ID || 
                      !process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    
    if (this.isDemoMode) {
      logger.info('User Calendar service initialized in DEMO mode');
    } else {
      logger.info('User Calendar service initialized in PRODUCTION mode');
    }
  }

  /**
   * Generate OAuth consent URL
   * Demo mode: Returns placeholder URL
   * Production: Returns real Google OAuth URL
   */
  getAuthUrl(state?: string): string {
    if (this.isDemoMode) {
      // In demo mode, redirect to backend callback (which will handle demo tokens)
      const backendUrl = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3001';
      const callbackUrl = `${backendUrl}/api/calendar/auth/callback?code=demo&state=${state || 'demo'}`;
      return callbackUrl;
    }

    // Production mode - would use real Google OAuth
    // This will be implemented when credentials are available
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 
                        `${process.env.CORS_ORIGIN || 'http://localhost:3001'}/api/calendar/auth/callback`;
    
    const scopes = [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' ');

    return `https://accounts.google.com/o/oauth2/v2/auth?` +
           `client_id=${encodeURIComponent(clientId)}&` +
           `redirect_uri=${encodeURIComponent(redirectUri)}&` +
           `response_type=code&` +
           `scope=${encodeURIComponent(scopes)}&` +
           `access_type=offline&` +
           `prompt=consent&` +
           `state=${encodeURIComponent(state || '')}`;
  }

  /**
   * Exchange authorization code for tokens
   * Demo mode: Returns mock tokens
   * Production: Exchanges real code with Google
   */
  async getTokens(code: string): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiryDate: Date | null;
  }> {
    if (this.isDemoMode) {
      logger.debug('Demo mode: Returning mock tokens');
      return {
        accessToken: `demo-access-token-${Date.now()}`,
        refreshToken: `demo-refresh-token-${Date.now()}`,
        expiryDate: new Date(Date.now() + 3600 * 1000), // 1 hour from now
      };
    }

    // Production mode: Exchange code for tokens with Google
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 
                        `${process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3001'}/api/calendar/auth/callback`;

    // Exchange authorization code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('Google OAuth token exchange failed:', errorData);
      throw new Error(`Failed to exchange code for tokens: ${tokenResponse.status} ${tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiryDate: tokenData.expires_in 
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
    };
  }

  /**
   * Refresh access token using refresh token
   * Demo mode: Returns new mock token
   * Production: Refreshes real token with Google
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiryDate: Date | null;
  }> {
    if (this.isDemoMode) {
      logger.debug('Demo mode: Returning refreshed mock token');
      return {
        accessToken: `demo-access-token-refreshed-${Date.now()}`,
        expiryDate: new Date(Date.now() + 3600 * 1000), // 1 hour from now
      };
    }

    // Production mode: Refresh token with Google
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('Google OAuth token refresh failed:', errorData);
      throw new Error(`Failed to refresh token: ${tokenResponse.status} ${tokenResponse.statusText}`);
    }

    const tokenData = await tokenResponse.json() as {
      access_token: string;
      expires_in?: number;
    };

    return {
      accessToken: tokenData.access_token,
      expiryDate: tokenData.expires_in 
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null,
    };
  }

  /**
   * Get user's calendar events for a date range
   * Demo mode: Returns mock events
   * Production: Fetches real events from Google Calendar
   */
  async getUserCalendarEvents(
    accessToken: string,
    startTime: string,
    endTime: string,
    userId?: string
  ): Promise<CalendarEvent[]> {
    if (this.isDemoMode) {
      logger.debug('Demo mode: Returning mock calendar events');
      return this.generateMockEvents(startTime, endTime, userId);
    }

    // Production mode: Fetch real events from Google Calendar API
    try {
      const startTimeParam = encodeURIComponent(startTime);
      const endTimeParam = encodeURIComponent(endTime);
      
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${startTimeParam}&timeMax=${endTimeParam}&singleEvents=true&orderBy=startTime`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Calendar access token expired. Please reconnect.');
        }
        const errorData = await response.text();
        console.error('Google Calendar API error:', errorData);
        throw new Error(`Failed to fetch calendar events: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        items?: Array<{
          id: string;
          summary?: string;
          start: { dateTime?: string; date?: string };
          end: { dateTime?: string; date?: string };
          status?: string;
          location?: string;
          description?: string;
          attendees?: Array<{ email?: string; displayName?: string }>;
        }>;
      };

      const events: CalendarEvent[] = (data.items || [])
        .filter(event => {
          // Filter out all-day events (they use 'date' instead of 'dateTime')
          // All-day events shouldn't block booking since they don't occupy specific times
          if (!event.start.dateTime || !event.end.dateTime) {
            return false;
          }
          
          // Filter out declined and cancelled events
          if (event.status === 'cancelled' || event.status === 'declined') {
            return false;
          }
          
          return true;
        })
        .map(event => {
          const start = event.start.dateTime!;
          const end = event.end.dateTime!;
          
          return {
            id: event.id,
            title: event.summary || 'Untitled Event',
            start: start,
            end: end,
            startTime: new Date(start),
            endTime: new Date(end),
            status: event.status || 'confirmed',
            location: event.location,
            description: event.description,
            attendees: (event.attendees || []).map(attendee => ({
              email: attendee.email || '',
              name: attendee.displayName || attendee.email || '',
              responseStatus: 'accepted', // Default to accepted for fetched events
            })),
          };
        });

      logger.debug('Fetched calendar events from Google Calendar', { count: events.length });
      return events;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error fetching calendar events:', errorMessage);
      throw error;
    }
  }

  /**
   * Create a calendar event in the user's Google Calendar
   * Demo mode: Returns mock event ID
   * Production: Creates real event in user's calendar
   */
  async createUserCalendarEvent(
    accessToken: string,
    event: CalendarEvent
  ): Promise<{ success: boolean; eventId?: string; error?: string }> {
    if (this.isDemoMode) {
      logger.debug('Demo: Created calendar event in user calendar', { title: event.title, startTime: event.startTime.toISOString() });
      const mockEventId = `demo-user-event-${Date.now()}`;
      return { success: true, eventId: mockEventId };
    }

    // Production mode: Create real event in user's calendar
    try {
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
        attendees: event.attendees?.map(attendee => ({
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

      const response = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(calendarEvent),
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Calendar access token expired. Please reconnect.');
        }
        const errorData = await response.text();
        console.error('Google Calendar API error:', errorData);
        throw new Error(`Failed to create calendar event: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { id: string };
      logger.debug('Created calendar event in user calendar', { title: event.title, eventId: data.id });
      return { success: true, eventId: data.id };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error creating calendar event in user calendar:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Update a calendar event in the user's Google Calendar
   * Demo mode: Returns mock success
   * Production: Updates real event in user's calendar
   */
  async updateUserCalendarEvent(
    accessToken: string,
    eventId: string,
    event: CalendarEvent
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isDemoMode) {
      logger.debug('Demo: Updated calendar event in user calendar', { title: event.title, eventId });
      return { success: true };
    }

    // Production mode: Update real event in user's calendar
    try {
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
        attendees: event.attendees?.map(attendee => ({
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

      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(calendarEvent),
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Calendar access token expired. Please reconnect.');
        }
        if (response.status === 404) {
          throw new Error('Calendar event not found');
        }
        const errorData = await response.text();
        console.error('Google Calendar API error:', errorData);
        throw new Error(`Failed to update calendar event: ${response.status} ${response.statusText}`);
      }

      logger.debug('Updated calendar event in user calendar', { title: event.title, eventId });
      return { success: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error updating calendar event in user calendar:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Find calendar events in user's calendar by title and time range
   * Demo mode: Returns mock event ID
   * Production: Searches user's calendar for matching events
   */
  async findUserCalendarEvent(
    accessToken: string,
    title: string,
    startTime: Date,
    endTime: Date
  ): Promise<{ success: boolean; eventId?: string; error?: string }> {
    if (this.isDemoMode) {
      // In demo mode, return a mock event ID based on the title and time
      const mockEventId = `demo-user-event-${startTime.getTime()}`;
      return { success: true, eventId: mockEventId };
    }

    // Production mode: Search for matching events
    try {
      const timeMin = startTime.toISOString();
      const timeMax = endTime.toISOString();
      
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${encodeURIComponent(timeMin)}&` +
        `timeMax=${encodeURIComponent(timeMax)}&` +
        `singleEvents=true&orderBy=startTime`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Calendar access token expired. Please reconnect.');
        }
        const errorData = await response.text();
        console.error('Google Calendar API error:', errorData);
        throw new Error(`Failed to search calendar events: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        items?: Array<{
          id: string;
          summary?: string;
          start: { dateTime?: string; date?: string };
          end: { dateTime?: string; date?: string };
        }>;
      };

      // Find event matching title and time
      const matchingEvent = (data.items || []).find(event => {
        if (!event.start.dateTime || !event.end.dateTime) return false;
        const eventStart = new Date(event.start.dateTime);
        const eventEnd = new Date(event.end.dateTime);
        
        // Match if title contains our search title and times overlap
        const titleMatches = event.summary?.includes(title) || title.includes(event.summary || '');
        const timeMatches = Math.abs(eventStart.getTime() - startTime.getTime()) < 60000; // Within 1 minute
        
        return titleMatches && timeMatches;
      });

      if (matchingEvent) {
        return { success: true, eventId: matchingEvent.id };
      }

      return { success: false, error: 'Event not found in user calendar' };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error searching calendar events:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Delete a calendar event from the user's Google Calendar
   * Demo mode: Returns mock success
   * Production: Deletes real event from user's calendar
   */
  async deleteUserCalendarEvent(
    accessToken: string,
    eventId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isDemoMode) {
      logger.debug('Demo: Deleted calendar event from user calendar', { eventId });
      return { success: true };
    }

    // Production mode: Delete real event from user's calendar
    try {
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Calendar access token expired. Please reconnect.');
        }
        // 404 is acceptable - event might already be deleted
        if (response.status === 404) {
          logger.debug('Calendar event not found in user calendar (already deleted)', { eventId });
          return { success: true };
        }
        const errorData = await response.text();
        console.error('Google Calendar API error:', errorData);
        throw new Error(`Failed to delete calendar event: ${response.status} ${response.statusText}`);
      }

      logger.debug('Deleted calendar event from user calendar', { eventId });
      return { success: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error deleting calendar event from user calendar:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * THE DEMO CALENDAR IS A FIXTURE, SO IT MUST NOT MOVE (cto/AdaptaLabs#96).
   *
   * This used to pick its times with `Math.random()` and ran fresh on every
   * `GET /api/calendar/my-events`, so a researcher asking for the same week
   * twice got different busy time and the slot picker reshuffled which slots it
   * dimmed on every page load. Three identical calls measured on `10e4fc7`
   * returned `08:30 12:15 09:15 10:45 14:00`, then `15:15 10:45 15:00 14:30
   * 08:00`, then `13:00 09:00 13:15 11:00 10:30`. A moving fixture is
   * indistinguishable from a calendar that genuinely changed, which is the one
   * thing a demo must never be.
   *
   * IT ALSO USED TO DEPEND ON WHO WAS ASKING, and got that backwards. The
   * 10am/2pm/3pm conflicts `GOOGLE_CALENDAR_SETUP.md` promises sat behind an
   * `isDemoUser1` check keyed to `a1b2c3d4-e5f6-7890-abcd-ef1234567890` - the
   * `/auth/demo-login` EMPLOYEE, who cannot reach the admin Session Management
   * picker at all. A `researcher_admin`, the only role that can, fell to a
   * second branch built from `9 + Math.floor(Math.random() * 8)`. The
   * documented behaviour was unreachable by anyone in a position to see it.
   *
   * Both are now one table applied to every weekday for every user: same
   * caller, same window, same answer, every time, and the anchors are the ones
   * the documentation names.
   *
   * ponytail: every demo user sees an identical calendar
   *   -> a demo of two researchers whose availability differs cannot be staged.
   *      Deriving a per-user offset from a hash of the user id would fix it and
   *      stay deterministic; nothing has needed it yet, and a second axis here
   *      is a second thing that can drift away from the documentation.
   *
   * Demo mode is development-only - `calendarOAuthMode()` answers `real` or
   * `unavailable` in a deployed environment - so nothing here is ever served to
   * a real participant.
   */
  private generateMockEvents(startTime: string, endTime: string, userId?: string): CalendarEvent[] {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const events: CalendarEvent[] = [];

    /**
     * The times `GOOGLE_CALENDAR_SETUP.md` promises, written as literals so
     * that moving one has to fail a test by name rather than silently
     * redefining what the documentation means. These line up with the demo
     * sessions created by `reset-demo-data.ts`.
     */
    const dailyConflicts = [
      { hour: 10, minute: 0, durationMinutes: 60, title: 'Team Standup' },
      { hour: 14, minute: 0, durationMinutes: 60, title: 'Project Review Meeting' },
      { hour: 15, minute: 0, durationMinutes: 45, title: 'Code Review Session' },
    ];

    // Local time throughout, because `setHours` is local and the picker draws
    // in the researcher's own timezone. Iterating on a copy keeps `start`
    // usable for the range check below.
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);

    // Bounded, not merely terminating: see MAX_DEMO_CALENDAR_DAYS. An invalid
    // date makes every comparison false, so the loop does not run rather than
    // spinning.
    let daysWalked = 0;

    while (cursor <= end && daysWalked < MAX_DEMO_CALENDAR_DAYS) {
      daysWalked++;
      const dayOfWeek = cursor.getDay();
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

      if (isWeekday) {
        for (const conflict of dailyConflicts) {
          const eventStart = new Date(cursor);
          eventStart.setHours(conflict.hour, conflict.minute, 0, 0);

          const eventEnd = new Date(eventStart);
          eventEnd.setMinutes(eventEnd.getMinutes() + conflict.durationMinutes);

          // A window can begin mid-morning or end mid-afternoon, so a whole
          // day's worth of conflicts is not necessarily in range.
          if (eventStart >= start && eventEnd <= end) {
            events.push({
              id: `demo-conflict-${eventStart.toISOString()}`,
              title: conflict.title,
              start: eventStart.toISOString(),
              end: eventEnd.toISOString(),
              startTime: eventStart,
              endTime: eventEnd,
              status: 'confirmed',
              location: 'Meeting Room B',
              description: 'Existing calendar commitment (demo data)',
              attendees: [],
            });
          }
        }
      }

      cursor.setDate(cursor.getDate() + 1);
    }

    logger.debug('Generated mock calendar events', { count: events.length, userId });

    return events;
  }

  /**
   * Encrypt sensitive token data using AES-256-GCM.
   * Uses the secure encryption module.
   */
  encrypt(text: string): string {
    return secureEncrypt(text);
  }

  /**
   * Decrypt sensitive token data.
   * Automatically handles both legacy XOR and new AES-256-GCM formats.
   */
  decrypt(encryptedData: string): string {
    return secureDecrypt(encryptedData);
  }

  /**
   * Check if service is in demo mode
   */
  isInDemoMode(): boolean {
    return this.isDemoMode;
  }
}

// Create singleton instance
export const userCalendarService = new UserCalendarService();

