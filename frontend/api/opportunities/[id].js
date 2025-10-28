/**
 * GET /api/opportunities/:id - Get a specific opportunity
 * PATCH /api/opportunities/:id - Update an opportunity
 * DELETE /api/opportunities/:id - Delete an opportunity
 */
const fs = require('fs');
const path = require('path');

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
    console.log('Opportunity by ID endpoint called', req.method, req.url);
    
    // Extract ID from URL
    const urlPath = req.url || '';
    const pathParts = urlPath.split('/').filter(p => p);
    const idIndex = pathParts.indexOf('opportunities');
    const id = pathParts[idIndex + 1];
    
    console.log('Opportunity ID:', id);
    
    // Read all opportunities
    const opportunities = readOpportunities();
    
    if (req.method === 'GET') {
      const opportunity = opportunities.find(o => o.id === id);
      
      if (!opportunity) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      console.log('Returning opportunity:', opportunity.id);
      return res.status(200).json(opportunity);
    }
    
    if (req.method === 'PATCH') {
      const index = opportunities.findIndex(o => o.id === id);
      
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
      
      console.log('Updated opportunity:', opportunity.id);
      return res.status(200).json(opportunity);
    }
    
    if (req.method === 'DELETE') {
      const index = opportunities.findIndex(o => o.id === id);
      
      if (index === -1) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      
      opportunities.splice(index, 1);
      writeOpportunities(opportunities);
      
      console.log('Deleted opportunity:', id);
      return res.status(204).send();
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Error in opportunity handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

