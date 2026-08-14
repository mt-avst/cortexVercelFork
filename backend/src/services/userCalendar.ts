import { CalendarEvent } from '../../../shared/types';
import { logger } from '../utils/logger';
import { encrypt as secureEncrypt, decryptAuto as secureDecrypt } from '../utils/encryption';

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
   * Generate realistic mock calendar events for testing
   * Creates specific conflicts for Demo User 1 (demo@example.com) at common session times
   */
  private generateMockEvents(startTime: string, endTime: string, userId?: string): CalendarEvent[] {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const events: CalendarEvent[] = [];

    // Check if this is Demo User 1 - create specific conflicts for them
    const isDemoUser1 = userId === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' || 
                       !userId; // Default to Demo User 1 if no userId provided

    if (isDemoUser1) {
      // Create specific conflicts aligned with demo session times (10am, 2pm, 3pm)
      // These will overlap with the sessions created by reset-demo-data.ts
      const conflictTimes = [
        { hour: 10, minute: 0, duration: 60, title: 'Team Standup' },
        { hour: 10, minute: 30, duration: 45, title: 'Client Call' },
        { hour: 14, minute: 0, duration: 60, title: 'Project Review Meeting' },
        { hour: 14, minute: 30, duration: 30, title: 'Sprint Planning' },
        { hour: 15, minute: 0, duration: 45, title: 'Code Review Session' },
        { hour: 15, minute: 15, duration: 30, title: 'One-on-One with Manager' },
      ];

      let currentDate = new Date(start);
      let eventCount = 0;

      // Generate events for the next 7 days to ensure good coverage
      while (currentDate <= end && eventCount < 15) {
        const dayOfWeek = currentDate.getDay();
        
        // Only add events on weekdays (Monday-Friday)
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          // Create 1-2 conflicts per day at the specific times
          const conflictsForDay = eventCount % 3 === 0 ? 2 : 1;
          
          for (let i = 0; i < conflictsForDay && eventCount < conflictTimes.length * 2; i++) {
            const conflict = conflictTimes[eventCount % conflictTimes.length];
            const eventStart = new Date(currentDate);
            eventStart.setHours(conflict.hour, conflict.minute, 0, 0);
            
            const eventEnd = new Date(eventStart);
            eventEnd.setMinutes(eventEnd.getMinutes() + conflict.duration);

            // Only add if event is within the requested range
            if (eventStart >= start && eventEnd <= end) {
              events.push({
                id: `demo-conflict-${eventCount}-${eventStart.toISOString()}`,
                title: conflict.title,
                start: eventStart.toISOString(),
                end: eventEnd.toISOString(),
                startTime: eventStart,
                endTime: eventEnd,
                status: 'confirmed',
                location: i === 0 ? 'Meeting Room B' : undefined,
                description: `Existing calendar commitment for Demo User 1`,
                attendees: [],
              });
              eventCount++;
            }
          }
        }

        // Move to next day
        currentDate.setDate(currentDate.getDate() + 1);
      }

      // Also add a few random events for variety
      const randomTemplates = [
        { title: 'Lunch Break', duration: 60 },
        { title: 'Training Session', duration: 90 },
        { title: 'Department Meeting', duration: 45 },
      ];

      currentDate = new Date(start);
      let randomCount = 0;
      while (currentDate <= end && randomCount < 5) {
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          const template = randomTemplates[randomCount % randomTemplates.length];
          const eventStart = new Date(currentDate);
          eventStart.setHours(11 + Math.floor(Math.random() * 2), Math.floor(Math.random() * 4) * 15, 0);
          
          const eventEnd = new Date(eventStart);
          eventEnd.setMinutes(eventEnd.getMinutes() + template.duration);

          if (eventStart >= start && eventEnd <= end) {
            events.push({
              id: `demo-random-${randomCount}`,
              title: template.title,
              start: eventStart.toISOString(),
              end: eventEnd.toISOString(),
              startTime: eventStart,
              endTime: eventEnd,
              status: 'confirmed',
              location: undefined,
              description: `Demo ${template.title} event`,
              attendees: [],
            });
            randomCount++;
          }
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
    } else {
      // For other users, generate fewer/random events
      const mockEventTemplates = [
        { title: 'Team Standup', duration: 30 },
        { title: 'Client Meeting', duration: 60 },
        { title: 'Lunch Break', duration: 60 },
      ];

      const currentDate = new Date(start);
      let eventCount = 0;
      const maxEvents = 5;

      while (currentDate <= end && eventCount < maxEvents) {
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          const template = mockEventTemplates[eventCount % mockEventTemplates.length];
          const eventStart = new Date(currentDate);
          eventStart.setHours(9 + Math.floor(Math.random() * 8), 
                             Math.floor(Math.random() * 4) * 15, 0);
          
          const eventEnd = new Date(eventStart);
          eventEnd.setMinutes(eventEnd.getMinutes() + template.duration);

          if (eventStart >= start && eventEnd <= end) {
            events.push({
              id: `demo-event-${eventCount}`,
              title: template.title,
              start: eventStart.toISOString(),
              end: eventEnd.toISOString(),
              startTime: eventStart,
              endTime: eventEnd,
              status: 'confirmed',
              location: Math.random() > 0.5 ? 'Meeting Room A' : undefined,
              description: `Demo ${template.title} event for testing`,
              attendees: [],
            });
            eventCount++;
          }
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
    }
    
    logger.debug('Generated mock calendar events', { count: events.length, isDemoUser1 });

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

