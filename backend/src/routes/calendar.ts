import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/authenticate';
import calendarService from '../services/calendar';
import { logger } from '../utils/logger';

const router: Router = Router();

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
