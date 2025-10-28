/**
 * GET /api/opportunities - List all opportunities
 * POST /api/opportunities - Create an opportunity
 * GET /api/opportunities/:id - Get a specific opportunity
 * PATCH /api/opportunities/:id - Update an opportunity
 */
const fs = require('fs');

const STORAGE_FILE = '/tmp/opportunities.json';

function readOpportunities() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = fs.readFileSync(STORAGE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading storage file:', error);
  }
  return [];
}

function writeOpportunities(opportunities) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(opportunities, null, 2));
  } catch (error) {
    console.error('Error writing storage file:', error);
  }
}

module.exports = async function handler(req, res) {
  try {
    console.log('Opportunities endpoint called', req.method, req.url);
    
    const urlPath = req.url || '';
    
    // Check if this is a request for a specific opportunity
    const pathParts = urlPath.split('/').filter(p => p);
    const isSpecificOpportunity = pathParts.length > 1; // More than just "opportunities"
    
    if (isSpecificOpportunity) {
      // This is a request like /opportunities/:id
      const opportunityId = pathParts[1];
      console.log('Specific opportunity request:', opportunityId);
      
      const opportunities = readOpportunities();
      
      if (req.method === 'GET') {
        const opportunity = opportunities.find(o => o.id === opportunityId);
        
        if (!opportunity) {
          return res.status(404).json({ error: 'Opportunity not found' });
        }
        
        return res.status(200).json(opportunity);
      }
      
      if (req.method === 'PATCH') {
        const index = opportunities.findIndex(o => o.id === opportunityId);
        
        if (index === -1) {
          return res.status(404).json({ error: 'Opportunity not found' });
        }
        
        const opportunity = {
          ...opportunities[index],
          ...req.body,
          updated_at: new Date().toISOString()
        };
        
        opportunities[index] = opportunity;
        writeOpportunities(opportunities);
        
        return res.status(200).json(opportunity);
      }
      
      if (req.method === 'DELETE') {
        const index = opportunities.findIndex(o => o.id === opportunityId);
        
        if (index === -1) {
          return res.status(404).json({ error: 'Opportunity not found' });
        }
        
        opportunities.splice(index, 1);
        writeOpportunities(opportunities);
        
        return res.status(204).send();
      }
      
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    // List all opportunities or create a new one
    if (req.method === 'GET') {
      const opportunities = readOpportunities();
      console.log('Returning', opportunities.length, 'opportunities');
      return res.status(200).json(opportunities);
    }
    
    if (req.method === 'POST') {
      const opportunityId = `opp_${Date.now()}`;
      
      const opportunity = {
        id: opportunityId,
        ...req.body,
        status: req.body.status || 'draft',
        sessions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      const opportunities = readOpportunities();
      opportunities.push(opportunity);
      writeOpportunities(opportunities);
      
      console.log('Created opportunity. Total opportunities:', opportunities.length);
      return res.status(201).json(opportunity);
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Error in opportunities handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

