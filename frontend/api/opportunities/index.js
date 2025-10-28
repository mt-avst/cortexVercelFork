/**
 * GET /api/opportunities - Returns opportunities list
 * POST /api/opportunities - Creates a new opportunity
 */
module.exports = async function handler(req, res) {
  try {
    console.log('Opportunities endpoint called', req.method, req.url);
    
    if (req.method === 'GET') {
      // Return empty array for opportunities list
      return res.status(200).json([]);
    }
    
    if (req.method === 'POST') {
      // Create opportunity
      console.log('Creating opportunity:', req.body);
      
      // Generate a new ID
      const opportunityId = `opp_${Date.now()}`;
      
      const opportunity = {
        id: opportunityId,
        ...req.body,
        status: req.body.status || 'draft',
        sessions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      console.log('Created opportunity:', opportunity);
      return res.status(201).json(opportunity);
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Error in opportunities handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

