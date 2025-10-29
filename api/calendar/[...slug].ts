import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';

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
  
  // Debug logging
  console.log('Calendar route handler called:', {
    url: req.url,
    path: req.url?.split('?')[0],
    slug,
    route,
    method: req.method,
    querySlug: req.query.slug,
    queryKeys: Object.keys(req.query)
  });
  
  // Route to availability endpoint
  if (route === 'availability') {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    console.log('Calendar availability endpoint called', req.url);
    
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
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    console.log('Calendar events endpoint called', req.url);
    
    // Return empty array for calendar events (no bookings yet)
    return res.status(200).json([]);
  }
  
  // Route to check-conflicts endpoint
  if (route === 'check-conflicts') {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const { time_slots, calendar_id } = req.body;

      if (!Array.isArray(time_slots) || time_slots.length === 0) {
        return res.status(400).json({ 
          error: 'time_slots array is required and must not be empty' 
        });
      }

      // Check conflicts against existing sessions in the database
      let conflictingCount = 0;
      const conflicts: any[] = [];

      for (const slot of time_slots) {
        if (!slot.start_time || !slot.end_time) {
          continue; // Skip invalid slots
        }

        // Check if this time slot overlaps with any existing session
        const result = await query(
          `SELECT s.id, s.opportunity_id, s.start_time, s.end_time, o.title as opportunity_title
           FROM sessions s
           JOIN opportunities o ON s.opportunity_id = o.id
           WHERE s.start_time < $1 AND s.end_time > $2
           LIMIT 1`,
          [slot.end_time, slot.start_time]
        );

        if (result.rows.length > 0) {
          conflictingCount++;
          conflicts.push({
            slot: {
              start_time: slot.start_time,
              end_time: slot.end_time
            },
            conflicting_session: result.rows[0]
          });
        }
      }

      return res.status(200).json({
        has_conflicts: conflictingCount > 0,
        conflicting_slots: conflictingCount,
        conflicts: conflicts.length > 0 ? conflicts : undefined
      });
    } catch (error: any) {
      console.error('Error checking conflicts:', error);
      return res.status(500).json({
        error: 'Internal server error',
        details: error.message,
      });
    }
  }
  
  // Unknown route
  return res.status(404).json({ error: 'Calendar endpoint not found' });
}


