import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createErrorResponse, createSafeErrorResponse } from '../utils/errors';

/**
 * GET /api/calendar/availability
 * Get calendar availability - generates time slots automatically
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
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
    currentDate.setUTCHours(0, 0, 0, 0); // Start at midnight UTC for each day
    
    while (currentDate <= end) {
      const dayOfWeek = currentDate.getUTCDay(); // Use UTC
      
      // Skip weekends if exclude_weekends is true
      if (excludeWeekends && (dayOfWeek === 0 || dayOfWeek === 6)) {
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        currentDate.setUTCHours(0, 0, 0, 0);
        continue;
      }
      
      // Generate slots for this day (7 AM to 11 PM UTC to match backend)
      const workingDayStartHour = 7; // 7 AM UTC
      const workingDayEndHour = 23; // 11 PM UTC
      const dayEnd = new Date(currentDate);
      dayEnd.setUTCHours(workingDayEndHour, 0, 0, 0);
      
      // Special handling for 45-minute slots: always start on the hour
      if (durationMinutes === 45) {
        // Generate slots starting every hour from 7 AM
        for (let hour = workingDayStartHour; hour < workingDayEndHour; hour++) {
          const slotStart = new Date(currentDate);
          slotStart.setUTCHours(hour, 0, 0, 0); // Always start on the hour (minute 0)
          
          const slotEnd = new Date(slotStart);
          slotEnd.setUTCMinutes(slotEnd.getUTCMinutes() + durationMinutes); // 45 minutes later
          
          // Only add slot if it ends before 11 PM
          if (slotEnd <= dayEnd && slotEnd.getUTCHours() <= workingDayEndHour) {
            available_slots.push({
              start: slotStart.toISOString(),
              end: slotEnd.toISOString(),
              available: true
            });
          }
        }
      } else {
        // Standard slot generation for other durations (15, 30, 60 minutes)
        // Calculate how many slots fit in the working day (7 AM to 11 PM = 16 hours)
        const slotDurationMs = durationMinutes * 60 * 1000;
        const workingDayDurationMs = (workingDayEndHour - workingDayStartHour) * 60 * 60 * 1000;
        const slotsPerDay = Math.floor(workingDayDurationMs / slotDurationMs);
        
        // Generate slots starting from 7 AM UTC, with consistent intervals
        for (let slotIndex = 0; slotIndex < slotsPerDay; slotIndex++) {
          const slotStart = new Date(currentDate);
          const slotStartTimeMs = workingDayStartHour * 60 * 60 * 1000 + (slotIndex * slotDurationMs);
          slotStart.setUTCHours(0, 0, 0, 0); // Reset to midnight
          slotStart.setTime(slotStart.getTime() + slotStartTimeMs); // Add the calculated time
          
          const slotEnd = new Date(slotStart.getTime() + slotDurationMs);
          
          // Skip if slot would go beyond the requested end time or working day
          if (slotStart >= end) break;
          if (slotEnd > end) break;
          if (slotStart.getUTCHours() >= workingDayEndHour) break;
          
          available_slots.push({
            start: slotStart.toISOString(),
            end: slotEnd.toISOString(),
            available: true
          });
        }
      }
      
      // Move to next day (UTC)
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
      currentDate.setUTCHours(0, 0, 0, 0);
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
  } catch (error: unknown) {
    console.error('Error in calendar availability handler:', error);
    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Internal server error' })
    );
  }
}

