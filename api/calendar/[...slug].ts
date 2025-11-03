import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { createErrorResponse, getErrorMessage } from '../utils/errors';

/**
 * Catch-all calendar endpoint - handles multiple calendar routes
 * GET /api/calendar/availability
 * GET /api/calendar/events  
 * POST /api/calendar/check-conflicts
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle catch-all route parameter - Vercel may provide it as array or string
  let slug: string[] = [];
  if (req.query.slug) {
    if (Array.isArray(req.query.slug)) {
      slug = req.query.slug;
    } else {
      slug = [req.query.slug as string];
    }
  }
  
  // If slug is empty, try to parse from URL path
  if (slug.length === 0 && req.url) {
    const urlPath = req.url.split('?')[0]; // Remove query string
    const match = urlPath.match(/\/calendar\/(.+)$/);
    if (match) {
      slug = match[1].split('/');
    }
  }
  
  const route = slug.join('/');
  
  // Route to availability endpoint
  if (route === 'availability') {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }
    
    const durationMinutes = parseInt(req.query.duration_minutes as string) || 30;
    const startTime = req.query.start_time as string;
    const endTime = req.query.end_time as string;
    const excludeWeekends = req.query.exclude_weekends === 'true';
    
    // Generate time slots if we have a date range
    let available_slots: Array<{ start: string; end: string; available: boolean }> = [];
    
    if (startTime && endTime) {
      const start = new Date(startTime);
      const end = new Date(endTime);
      
      // Generate slots for each day
      const currentDate = new Date(start);
      currentDate.setHours(9, 0, 0, 0); // Start at 9 AM
      
      while (currentDate <= end) {
        const dayOfWeek = currentDate.getDay();
        
        // Skip weekends if exclude_weekends is true
        if (excludeWeekends && (dayOfWeek === 0 || dayOfWeek === 6)) {
          currentDate.setDate(currentDate.getDate() + 1);
          currentDate.setHours(9, 0, 0, 0);
          continue;
        }
        
        // Generate slots for this day (9 AM to 5 PM)
        const dayEnd = new Date(currentDate);
        dayEnd.setHours(17, 0, 0, 0);
        
        // Special handling for 45-minute slots: always start on the hour
        if (durationMinutes === 45) {
          // Generate slots starting every hour from 9 AM
          for (let hour = 9; hour < 17; hour++) {
            const slotStart = new Date(currentDate);
            slotStart.setHours(hour, 0, 0, 0); // Always start on the hour (minute 0)
            
            const slotEnd = new Date(slotStart);
            slotEnd.setMinutes(slotEnd.getMinutes() + durationMinutes); // 45 minutes later
            
            // Only add slot if it ends before 5 PM
            if (slotEnd <= dayEnd) {
              available_slots.push({
                start: slotStart.toISOString(),
                end: slotEnd.toISOString(),
                available: true
              });
            }
          }
        } else {
          // Standard slot generation for other durations (15, 30, 60 minutes)
          while (currentDate < dayEnd) {
            const slotEnd = new Date(currentDate);
            slotEnd.setMinutes(slotEnd.getMinutes() + durationMinutes);
            
            // Only add slot if it ends before 5 PM
            if (slotEnd <= dayEnd) {
              available_slots.push({
                start: currentDate.toISOString(),
                end: slotEnd.toISOString(),
                available: true
              });
            }
            
            currentDate.setMinutes(currentDate.getMinutes() + durationMinutes);
          }
        }
        
        // Move to next day
        currentDate.setDate(currentDate.getDate() + 1);
        currentDate.setHours(9, 0, 0, 0);
      }
    }
    
    const response = {
      available_slots: available_slots,
      total_slots: available_slots.length,
      duration_minutes: durationMinutes,
      time_range: {
        start: startTime || '',
        end: endTime || ''
      }
    };
    
    return res.status(200).json(response);
  }
  
  // Route to events endpoint
  if (route === 'events') {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }
    
    // Return empty array for calendar events (no bookings yet)
    return res.status(200).json([]);
  }
  
  // Route to check-conflicts endpoint
  if (route === 'check-conflicts') {
    if (req.method !== 'POST') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    try {
      const { time_slots, calendar_id, opportunity_id } = req.body;

      if (!Array.isArray(time_slots) || time_slots.length === 0) {
        return res.status(400).json(createErrorResponse('time_slots array is required and must not be empty'));
      }

      // Performance optimization: Check all slots in a single batch query instead of loop
      // Filter out invalid slots first
      const validSlots = time_slots.filter(slot => slot.start_time && slot.end_time);
      
      if (validSlots.length === 0) {
        return res.status(400).json(createErrorResponse('No valid time slots provided'));
      }

      // Batch query to check all slot conflicts at once using array unnest
      // This is much more efficient than querying in a loop
      const queryParams: any[] = [];
      const startTimes = validSlots.map(s => s.start_time);
      const endTimes = validSlots.map(s => s.end_time);
      
      queryParams.push(startTimes, endTimes);
      
      let conflictQuery = `
        SELECT 
          slot.start_time as slot_start_time,
          slot.end_time as slot_end_time,
          s.id, s.opportunity_id, s.start_time, s.end_time, 
          o.title as opportunity_title
        FROM unnest($1::timestamptz[], $2::timestamptz[]) AS slot(start_time, end_time)
        CROSS JOIN LATERAL (
          SELECT s.id, s.opportunity_id, s.start_time, s.end_time
          FROM sessions s
          WHERE s.start_time < slot.end_time AND s.end_time > slot.start_time
      `;
      
      if (opportunity_id) {
        conflictQuery += ` AND s.opportunity_id != $3`;
        queryParams.push(opportunity_id);
      }
      
      conflictQuery += `
          LIMIT 1
        ) s
        JOIN opportunities o ON s.opportunity_id = o.id
      `;

      const result = await query(conflictQuery, queryParams);
      
      const conflictingCount = result.rows.length;
      const conflicts = result.rows.map(row => ({
        slot: {
          start_time: row.slot_start_time,
          end_time: row.slot_end_time
        },
        conflicting_session: {
          id: row.id,
          opportunity_id: row.opportunity_id,
          start_time: row.start_time,
          end_time: row.end_time,
          opportunity_title: row.opportunity_title
        }
      }));

      return res.status(200).json({
        has_conflicts: conflictingCount > 0,
        conflicting_slots: conflictingCount,
        conflicts: conflicts.length > 0 ? conflicts : undefined
      });
    } catch (error: unknown) {
      console.error('Error checking conflicts:', error);
      const errorMessage = getErrorMessage(error);
      return res.status(500).json(
        createErrorResponse('Internal server error', errorMessage)
      );
    }
  }

  // Route to my-events endpoint (user's calendar events)
  if (route === 'my-events') {
    if (req.method !== 'GET') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    try {
      const { parseSessionCookie } = require('../utils/auth');
      const user = parseSessionCookie(req);
      if (!user) {
        return res.status(401).json(createErrorResponse('Authentication required'));
      }

      const userId = user.id;
      const startTime = req.query.start_time as string;
      const endTime = req.query.end_time as string;

      if (!startTime || !endTime) {
        return res.status(400).json(createErrorResponse('start_time and end_time query parameters are required'));
      }

      // Validate date format
      const start = new Date(startTime);
      const end = new Date(endTime);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json(createErrorResponse('Invalid date format. Use ISO 8601 format.'));
      }

      if (start >= end) {
        return res.status(400).json(createErrorResponse('start_time must be before end_time'));
      }

      // In demo mode, always return mock events for Demo User 1 even without tokens
      const isDemoUser1 = userId === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      
      // Check if user has calendar tokens (connected) - but don't require it for Demo User 1
      let tokenResult;
      try {
        tokenResult = await query(
          'SELECT id FROM user_calendar_tokens WHERE user_id = $1',
          [userId]
        );
      } catch (dbError: any) {
        console.error('📅 my-events: Database query error (will still generate events for Demo User 1):', dbError);
        // For Demo User 1, continue even if query fails
        if (!isDemoUser1) {
          return res.status(500).json(createErrorResponse('Database error', getErrorMessage(dbError)));
        }
        tokenResult = { rows: [] };
      }
      
      if (tokenResult.rows.length === 0 && !isDemoUser1) {
        return res.status(404).json({
          error: 'Calendar not connected',
          connected: false
        });
      }

      console.log(`📅 my-events: User ${userId}${isDemoUser1 ? ' (Demo User 1 - will generate mock conflicts)' : ''}${tokenResult.rows.length > 0 ? ' (calendar connected)' : ' (no tokens, demo mode)'}`);

      // Generate mock calendar events for demo mode
      
      const events: Array<{
        id: string;
        title: string;
        start: string;
        end: string;
        startTime: Date;
        endTime: Date;
        status: string;
        location?: string;
        description?: string;
        attendees: Array<unknown>;
      }> = [];

      if (isDemoUser1) {
        // Create specific conflicts aligned with demo session times (10am, 2pm, 3pm)
        const conflictTimes = [
          { hour: 10, minute: 0, duration: 60, title: 'Team Standup' },
          { hour: 10, minute: 30, duration: 45, title: 'Client Call' },
          { hour: 14, minute: 0, duration: 60, title: 'Project Review Meeting' },
          { hour: 14, minute: 30, duration: 30, title: 'Sprint Planning' },
          { hour: 15, minute: 0, duration: 45, title: 'Code Review Session' },
          { hour: 15, minute: 15, duration: 30, title: 'One-on-One with Manager' },
        ];

        // Generate events for each day in the range
        let currentDate = new Date(start);
        currentDate.setUTCHours(0, 0, 0, 0); // Start at beginning of first day (UTC)
        let eventCount = 0;

        while (currentDate <= end && eventCount < 15) {
          const dayOfWeek = currentDate.getUTCDay();
          
          // Only add events on weekdays (Monday-Friday)
          if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            // Create 1-2 conflicts per day at the specific times
            const conflictsForDay = eventCount % 3 === 0 ? 2 : 1;
            
            for (let i = 0; i < conflictsForDay && eventCount < conflictTimes.length * 2; i++) {
              const conflict = conflictTimes[eventCount % conflictTimes.length];
              const eventStart = new Date(currentDate);
              eventStart.setUTCHours(conflict.hour, conflict.minute, 0, 0);
              
              const eventEnd = new Date(eventStart);
              eventEnd.setUTCMinutes(eventEnd.getUTCMinutes() + conflict.duration);

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

          // Move to next day (UTC)
          currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        // Also add a few random events for variety
        const randomTemplates = [
          { title: 'Lunch Break', duration: 60 },
          { title: 'Training Session', duration: 90 },
          { title: 'Department Meeting', duration: 45 },
        ];

        // Add random events
        currentDate = new Date(start);
        currentDate.setUTCHours(0, 0, 0, 0);
        let randomCount = 0;
        while (currentDate <= end && randomCount < 5) {
          const dayOfWeek = currentDate.getUTCDay();
          if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            const template = randomTemplates[randomCount % randomTemplates.length];
            const eventStart = new Date(currentDate);
            eventStart.setUTCHours(11 + Math.floor(Math.random() * 2), Math.floor(Math.random() * 4) * 15, 0);
            
            const eventEnd = new Date(eventStart);
            eventEnd.setUTCMinutes(eventEnd.getUTCMinutes() + template.duration);

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
          currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }
      } else {
        // For other users, generate fewer/random events
        const mockEventTemplates = [
          { title: 'Team Standup', duration: 30 },
          { title: 'Client Meeting', duration: 60 },
          { title: 'Lunch Break', duration: 60 },
        ];

        let currentDate = new Date(start);
        let eventCount = 0;
        const maxEvents = 5;

        while (currentDate <= end && eventCount < maxEvents) {
          const dayOfWeek = currentDate.getUTCDay();
          if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            const template = mockEventTemplates[eventCount % mockEventTemplates.length];
            const eventStart = new Date(currentDate);
            eventStart.setUTCHours(9 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 4) * 15, 0);
            
            const eventEnd = new Date(eventStart);
            eventEnd.setUTCMinutes(eventEnd.getUTCMinutes() + template.duration);

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
          currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }
      }

      console.log(`📅 Generated ${events.length} mock calendar events${isDemoUser1 ? ' with specific conflicts for Demo User 1' : ''}`);

      return res.status(200).json(events);
    } catch (error: unknown) {
      console.error('Error fetching user calendar events:', error);
      const errorMessage = getErrorMessage(error);
      return res.status(500).json(
        createErrorResponse('Failed to fetch calendar events', errorMessage)
      );
    }
  }
  
  // Unknown route
  return res.status(404).json(createErrorResponse('Calendar endpoint not found'));
}


