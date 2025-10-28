/**
 * GET /api/opportunities - Returns opportunities list
 * POST /api/opportunities - Creates a new opportunity
 * 
 * IMPORTANT: This stores data in /tmp which ONLY persists within the same
 * serverless function instance. Data WILL be lost on cold starts or redeploy.
 * 
 * For production, you MUST use a database:
 * 1. Add Vercel Postgres to your project
 * 2. Replace this code with database calls
 * 
 * See DATABASE_SETUP.md for instructions
 */
const fs = require('fs');
const path = require('path');

// Use a shared storage file in /tmp
// NOTE: This only works within the same serverless container
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
  // Initialize with sample data if empty
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
    
    if (req.method === 'GET') {
      const opportunities = readOpportunities();
      console.log('Returning', opportunities.length, 'opportunities');
      return res.status(200).json(opportunities);
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
      
      // Read, update, and write back
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

