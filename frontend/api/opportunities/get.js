/**
 * GET /api/opportunities/get
 * Get a specific opportunity by query parameter
 */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    console.log('Get opportunity endpoint called', req.url);
    
    // Return mock opportunity
    const opportunity = {
      id: 'new',
      type: 'interview',
      title: 'Test Study',
      purpose: 'Test purpose',
      status: 'draft',
      sessions: []
    };
    
    return res.status(200).json(opportunity);
  } catch (error) {
    console.error('Error in opportunities/get handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

