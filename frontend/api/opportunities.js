/**
 * Handler for /api/opportunities with support for nested paths
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
    console.log('Full req object keys:', Object.keys(req));
    console.log('req.query:', req.query);
    console.log('req.url:', req.url);
    
    // Parse query string manually if req.query is not populated
    let opportunityId = null;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    opportunityId = url.searchParams.get('id');
    
    console.log('Extracted opportunityId from URL:', opportunityId);
    
    // Also check URL path for ID (for other methods)
    if (!opportunityId) {
      const urlPath = req.url || '';
      
      if (urlPath.includes('/api/opportunities/')) {
        const parts = urlPath.split('/api/opportunities/')[1];
        if (parts && parts !== '' && parts !== 'opportunities') {
          opportunityId = parts.split('/')[0];
        }
      } else if (urlPath.startsWith('/opportunities/')) {
        const parts = urlPath.split('/opportunities/')[1];
        if (parts && parts !== '') {
          opportunityId = parts.split('/')[0];
        }
      }
    }
    
    console.log('Final opportunity ID:', opportunityId);
    
    // If we have an ID, handle specific opportunity operations
    if (opportunityId) {
      console.log('Processing request for specific opportunity:', opportunityId);
      const opportunities = readOpportunities();
      
      if (req.method === 'GET') {
        console.log('Looking for opportunity:', opportunityId);
        console.log('Available opportunities:', opportunities.map(o => o.id));
        
        const opportunity = opportunities.find(o => o.id === opportunityId);
        
        if (!opportunity) {
          console.log('Opportunity not found');
          return res.status(404).json({ error: 'Opportunity not found' });
        }
        
        console.log('Found opportunity:', opportunity.id);
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
    
    // No ID - handle list all or create
    const opportunities = readOpportunities();
    
    if (req.method === 'GET') {
      // If query param has ID, this was a request like /api/opportunities?id=xxx
      // that didn't match the opportunityId check above. Return all.
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

