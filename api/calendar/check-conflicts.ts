import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';

/**
 * POST /api/calendar/check-conflicts
 * Checks if time slots conflict with existing sessions or bookings
 * 
 * Request body:
 * {
 *   time_slots: Array<{
 *     start_time: string,
 *     end_time: string,
 *     capacity?: number
 *   }>,
 *   calendar_id?: string (optional)
 * }
 * 
 * Response:
 * {
 *   has_conflicts: boolean,
 *   conflicting_slots: number,
 *   conflicts?: Array<{...}>
 * }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
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

    // For now, we'll check conflicts against existing sessions in the database
    // In a full implementation, you might also check against external calendar events
    let conflictingCount = 0;
    const conflicts: any[] = [];

    for (const slot of time_slots) {
      if (!slot.start_time || !slot.end_time) {
        continue; // Skip invalid slots
      }

      // Check if this time slot overlaps with any existing session
      // Overlap occurs when: slot_start < existing_end AND slot_end > existing_start
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

