/**
 * GET /api/opportunities - Returns opportunities list
 * POST /api/opportunities - Creates a new opportunity
 * 
 * Note: This uses a shared module-level array to persist data
 * across serverless function invocations in the same process
 */
// Use a global variable that persists in the module scope
// This works across requests within the same serverless function container
if (typeof global.opportunities === 'undefined') {
  global.opportunities = [];
}

module.exports = async function handler(req, res) {
  try {
    console.log('Opportunities endpoint called', req.method, req.url);
    
    if (req.method === 'GET') {
      // Return stored opportunities (persists across requests in the same container)
      console.log('Returning', global.opportunities.length, 'opportunities');
      return res.status(200).json(global.opportunities);
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
      
      // Store in memory (persists across requests in the same container)
      global.opportunities.push(opportunity);
      console.log('Created opportunity. Total opportunities:', global.opportunities.length);
      return res.status(201).json(opportunity);
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Error in opportunities handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

