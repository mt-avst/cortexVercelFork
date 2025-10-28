/**
 * GET /api/opportunities/:id - Get a specific opportunity
 * PATCH /api/opportunities/:id - Update an opportunity
 * DELETE /api/opportunities/:id - Delete an opportunity
 */
module.exports = async function handler(req, res) {
  try {
    console.log('Opportunity by ID endpoint called', req.method, req.url);
    
    // Extract ID from URL
    const urlPath = req.url || '';
    const pathParts = urlPath.split('/').filter(p => p);
    const idIndex = pathParts.indexOf('opportunities');
    const id = pathParts[idIndex + 1];
    
    if (req.method === 'GET') {
      console.log('Getting opportunity:', id);
      
      const opportunity = {
        id: id,
        type: 'interview',
        title: 'Test Study',
        purpose_one_liner: 'Test purpose',
        status: 'draft',
        sessions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      return res.status(200).json(opportunity);
    }
    
    if (req.method === 'PATCH') {
      console.log('Updating opportunity:', id, req.body);
      
      // Return updated opportunity
      const opportunity = {
        id: id,
        ...req.body,
        updated_at: new Date().toISOString()
      };
      
      return res.status(200).json(opportunity);
    }
    
    if (req.method === 'DELETE') {
      console.log('Deleting opportunity:', id);
      return res.status(204).send();
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Error in opportunity handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

