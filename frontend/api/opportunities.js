/**
 * GET /api/opportunities or /api/opportunities/:id
 * Returns opportunities list or a specific opportunity
 */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    console.log('Opportunities endpoint called', req.url);
    
    // Check if this is a single opportunity request
    const urlPath = req.url || '';
    const pathParts = urlPath.replace('/api/opportunities', '').split('/').filter(p => p);
    
    if (pathParts.length > 0 && pathParts[0] !== '') {
      // Single opportunity request
      const oppId = pathParts[0];
      console.log('Getting single opportunity:', oppId);
      
      const opportunity = {
        id: oppId,
        type: 'interview',
        title: 'Test Study',
        purpose: 'Test purpose',
        status: 'draft',
        sessions: []
      };
      
      return res.status(200).json(opportunity);
    }
    
    // Return empty array for opportunities list
    return res.status(200).json([]);
  } catch (error) {
    console.error('Error in opportunities handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

