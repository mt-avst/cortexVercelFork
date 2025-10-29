/**
 * POST /api/sessions
 * Create sessions for an opportunity
 * 
 * Note: This uses in-memory storage for demo purposes
 * In production, this would use a database
 */
let inMemorySessions = [];

module.exports = async function handler(req, res) {
  try {
    console.log('Sessions endpoint called', req.method, req.url);
    
    if (req.method === 'POST') {
      const { opportunity_id, sessions } = req.body;
      
      console.log('Creating sessions for opportunity:', opportunity_id, 'sessions:', sessions);
      
      const createdSessions = sessions.map((session, index) => ({
        id: `session_${Date.now()}_${index}`,
        opportunity_id: opportunity_id,
        start_time: session.start_time,
        end_time: session.end_time,
        capacity: session.capacity || 1,
        booked_count: 0,
        location_or_meet_link_optional: session.location_or_meet_link_optional || '',
        created_at: new Date().toISOString()
      }));
      
      // Store in memory
      inMemorySessions.push(...createdSessions);
      console.log('Created', createdSessions.length, 'sessions. Total sessions:', inMemorySessions.length);
      
      return res.status(201).json(createdSessions);
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Error in sessions handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

