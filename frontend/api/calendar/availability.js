/**
 * GET /api/calendar/availability
 * Get calendar availability
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  console.log('Calendar availability endpoint called', req.url);
  
  // Return proper AvailabilityResponse structure with empty slots
  const response = {
    available_slots: [],
    total_slots: 0,
    duration_minutes: parseInt(req.query.duration_minutes) || 15,
    time_range: {
      start: req.query.start_time || '',
      end: req.query.end_time || ''
    }
  };
  
  return res.status(200).json(response);
};

