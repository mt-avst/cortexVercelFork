import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/authenticate';
import calendarService from '../services/calendar';
import { pool } from '../config';
import { logger } from '../utils/logger';

const router: Router = Router();

/**
 * Ownership guard for a caller-supplied `calendar_id` (#18).
 *
 * These admin routes pass `calendar_id` straight from the request into
 * `calendarService`, which is a STUB today (`getCalendarEvents` returns
 * `{ events: [] }`) but makes real Google calls elsewhere in the same class
 * (`events.insert`). The moment the read stub is filled, an unguarded
 * `calendar_id` hands any researcher_admin the attendee names + emails, titles
 * and locations of ANY calendar id they name. The guard has to exist BEFORE the
 * stub is implemented - that ordering is the whole point of the ticket.
 *
 * The ownership model: the only place a calendar id is tied to a user is
 * `user_calendar_tokens` (per-user, UNIQUE on user_id, `calendar_id` column).
 * `userCalendar.ts` already treats "your calendar" as your own token row and
 * never trusts the query string. This mirrors that: a caller may only name a
 * `calendar_id` that equals their OWN stored calendar id.
 *
 * FAILS CLOSED. A supplied id with no matching token row - or any DB error - is
 * refused, never allowed. A request that supplies NO `calendar_id` is allowed:
 * the service then uses its configured default calendar, which is the service
 * principal's own, not another user's, so there is no cross-calendar access to
 * gate. That is also the only shape any current caller sends (no frontend
 * caller passes `calendar_id`).
 *
 * ponytail: the strictest guard the stubbed model can defend. When the Google
 * integration actually lands, revisit this predicate against the real model -
 * e.g. calendars owned via an opportunity/session the caller owns - rather than
 * assuming "your own token row" stays sufficient.
 */
async function callerOwnsCalendar(userId: string, calendarId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      'SELECT calendar_id FROM user_calendar_tokens WHERE user_id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      return false;
    }
    return result.rows[0].calendar_id === calendarId;
  } catch (error) {
    logger.error('Failed to verify calendar ownership', { userId, error });
    return false;
  }
}

// GET /api/calendar/events - Get calendar events for admin
router.get('/events', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { start_time, end_time, calendar_id } = req.query;
    
    if (!start_time || !end_time) {
      return res.status(400).json({ 
        error: 'start_time and end_time query parameters are required' 
      });
    }
    
    const startTime = new Date(start_time as string);
    const endTime = new Date(end_time as string);
    
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return res.status(400).json({ 
        error: 'Invalid date format. Use ISO 8601 format.' 
      });
    }
    
    if (startTime >= endTime) {
      return res.status(400).json({
        error: 'start_time must be before end_time'
      });
    }

    // #18: a caller-supplied calendar_id must be one the caller owns.
    if (calendar_id && !(await callerOwnsCalendar(req.session!.user!.id, calendar_id as string))) {
      return res.status(403).json({ error: 'Not authorized for the requested calendar' });
    }

    const result = await calendarService.getCalendarEvents(
      startTime,
      endTime,
      calendar_id as string
    );
    
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    
    // Format events for frontend
    const formattedEvents = result.events?.map(event => ({
      id: event.id,
      title: event.summary || 'Untitled Event',
      start: event.start.dateTime || event.start.date,
      end: event.end.dateTime || event.end.date,
      status: event.status,
      location: event.location,
      attendees: event.attendees?.map((att: any) => ({
        email: att.email,
        name: att.displayName,
        responseStatus: att.responseStatus
      })) || []
    })) || [];
    
    res.json(formattedEvents);
  } catch (error) {
    logger.error('Error fetching calendar events', { error });
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// GET /api/calendar/availability - Check time slot availability
router.get('/availability', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { start_time, end_time, duration_minutes, calendar_id, exclude_weekends } = req.query;
    
    if (!start_time || !end_time || !duration_minutes) {
      return res.status(400).json({ 
        error: 'start_time, end_time, and duration_minutes query parameters are required' 
      });
    }
    
    const startTime = new Date(start_time as string);
    const endTime = new Date(end_time as string);
    const durationMinutes = parseInt(duration_minutes as string);
    const excludeWeekends = exclude_weekends === 'true';
    
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime()) || isNaN(durationMinutes)) {
      return res.status(400).json({ 
        error: 'Invalid date or duration format' 
      });
    }
    
    if (startTime >= endTime) {
      return res.status(400).json({ 
        error: 'start_time must be before end_time' 
      });
    }
    
    if (durationMinutes < 15 || durationMinutes > 480) {
      return res.status(400).json({
        error: 'duration_minutes must be between 15 and 480 (8 hours)'
      });
    }

    // #18: same ownership guard - availability reads the calendar through the
    // same service and must not accept an arbitrary calendar_id either.
    if (calendar_id && !(await callerOwnsCalendar(req.session!.user!.id, calendar_id as string))) {
      return res.status(403).json({ error: 'Not authorized for the requested calendar' });
    }

    const result = await calendarService.checkTimeSlotAvailability(
      startTime,
      endTime,
      durationMinutes,
      calendar_id as string,
      excludeWeekends
    );
    
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    
    // Format available slots for frontend
    const formattedSlots = result.availableSlots?.map(slot => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString(),
      duration_minutes: durationMinutes
    })) || [];
    
    res.json({
      available_slots: formattedSlots,
      total_slots: formattedSlots.length,
      duration_minutes: durationMinutes,
      time_range: {
        start: startTime.toISOString(),
        end: endTime.toISOString()
      }
    });
  } catch (error) {
    logger.error('Error checking availability', { error });
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

// POST /api/calendar/check-conflicts - Check if specific time slots conflict with calendar
router.post('/check-conflicts', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { time_slots, calendar_id } = req.body;
    
    if (!time_slots || !Array.isArray(time_slots) || time_slots.length === 0) {
      return res.status(400).json({ 
        error: 'time_slots array is required' 
      });
    }
    
    // Validate time slots format
    for (const slot of time_slots) {
      if (!slot.start_time || !slot.end_time) {
        return res.status(400).json({ 
          error: 'Each time slot must have start_time and end_time' 
        });
      }
      
      const startTime = new Date(slot.start_time);
      const endTime = new Date(slot.end_time);

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        return res.status(400).json({
          error: 'Invalid date format in time slots'
        });
      }
    }

    // #18: check-conflicts fetches events through the same service; a
    // caller-supplied calendar_id (here in the body) must be one they own.
    if (calendar_id && !(await callerOwnsCalendar(req.session!.user!.id, calendar_id))) {
      return res.status(403).json({ error: 'Not authorized for the requested calendar' });
    }

    // Get the overall time range
    const allStartTimes = time_slots.map(slot => new Date(slot.start_time));
    const allEndTimes = time_slots.map(slot => new Date(slot.end_time));
    const minStart = new Date(Math.min(...allStartTimes.map(d => d.getTime())));
    const maxEnd = new Date(Math.max(...allEndTimes.map(d => d.getTime())));
    
    // Fetch calendar events for the entire range
    const eventsResult = await calendarService.getCalendarEvents(
      minStart,
      maxEnd,
      calendar_id
    );
    
    if (!eventsResult.success) {
      return res.status(500).json({ error: eventsResult.error });
    }
    
    const events = eventsResult.events || [];
    const busyEvents = events.filter(event => 
      event.status !== 'cancelled' && 
      event.status !== 'declined'
    );
    
    // Check each time slot for conflicts
    const conflicts = [];
    
    for (let i = 0; i < time_slots.length; i++) {
      const slot = time_slots[i];
      const slotStart = new Date(slot.start_time);
      const slotEnd = new Date(slot.end_time);
      
      const conflictingEvents = busyEvents.filter(event => {
        const eventStart = new Date(event.start.dateTime || event.start.date);
        const eventEnd = new Date(event.end.dateTime || event.end.date);
        
        // Check for overlap
        return (slotStart < eventEnd && slotEnd > eventStart);
      });
      
      if (conflictingEvents.length > 0) {
        conflicts.push({
          slot_index: i,
          start_time: slot.start_time,
          end_time: slot.end_time,
          conflicting_events: conflictingEvents.map(event => ({
            id: event.id,
            title: event.summary || 'Untitled Event',
            start: event.start.dateTime || event.start.date,
            end: event.end.dateTime || event.end.date
          }))
        });
      }
    }
    
    res.json({
      has_conflicts: conflicts.length > 0,
      conflicts: conflicts,
      total_slots_checked: time_slots.length,
      conflicting_slots: conflicts.length
    });
  } catch (error) {
    logger.error('Error checking conflicts', { error });
    res.status(500).json({ error: 'Failed to check conflicts' });
  }
});

export default router;
