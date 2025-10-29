import type { VercelRequest, VercelResponse } from '@vercel/node';
import fs from 'fs';
import path from 'path';

const DATA_FILE = path.join('/tmp', 'opportunities.json');

// In-memory cache for opportunities (persists within the same Lambda instance)
let opportunitiesCache: any[] | null = null;

// Initialize storage file if it doesn't exist
function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([]));
  }
}

// Read opportunities from file and cache
function readOpportunities(): any[] {
  // Try to use cache first
  if (opportunitiesCache !== null) {
    return opportunitiesCache;
  }
  
  ensureDataFile();
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    const opportunities = JSON.parse(data);
    // Update cache
    opportunitiesCache = opportunities;
    return opportunities;
  } catch (error) {
    console.error('Error reading opportunities:', error);
    return [];
  }
}

// Write opportunities to file and update cache
function writeOpportunities(opportunities: any[]): void {
  ensureDataFile();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(opportunities, null, 2));
    // Update cache
    opportunitiesCache = opportunities;
  } catch (error) {
    console.error('Error writing opportunities:', error);
  }
}

/**
 * GET /api/opportunities
 * Returns all opportunities
 * POST /api/opportunities
 * Creates a new opportunity
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    console.log('Opportunities endpoint called - GET', req.query);
    
    const opportunities = readOpportunities();
    
    // If an ID is specified, return just that opportunity
    const id = req.query.id;
    if (id) {
      const opportunity = opportunities.find((opp: any) => opp.id === id);
      if (!opportunity) {
        return res.status(404).json({ error: 'Opportunity not found' });
      }
      return res.status(200).json(opportunity);
    }
    
    return res.status(200).json(opportunities);
  }
  
  if (req.method === 'POST') {
    console.log('Opportunities endpoint called - POST', req.body);
    
    // Read existing opportunities
    const opportunities = readOpportunities();
    
    // Generate a new ID for the opportunity
    const opportunity = {
      id: `opp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ...req.body,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    
    // Add the new opportunity
    opportunities.push(opportunity);
    
    // Save to file
    writeOpportunities(opportunities);
    
    // Return the created opportunity
    return res.status(201).json(opportunity);
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}

