import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/calendar/availability
 * Get calendar availability - generates time slots automatically
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
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

