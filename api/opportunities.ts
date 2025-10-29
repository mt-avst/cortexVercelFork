import type { VercelRequest, VercelResponse } from '@vercel/node';
import fs from 'fs';
import path from 'path';

const DATA_FILE = path.join('/tmp', 'opportunities.json');
const SESSIONS_FILE = path.join('/tmp', 'sessions.json');

// Global in-memory storage (persists across invocations within same Lambda instance)
declare global {
  var __opportunities: any[] | undefined;
  var __sessions: any[] | undefined;
}

if (!global.__opportunities) {
  global.__opportunities = [];
}
if (!global.__sessions) {
  global.__sessions = [];
}

let opportunitiesCache: any[] | null = null;
let sessionsCache: any[] | null = null;

// Initialize storage file if it doesn't exist
function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([]));
  }
}

// Read opportunities from file and cache
function readOpportunities(): any[] {
  // Try to use global cache first
  if (global.__opportunities && global.__opportunities.length > 0) {
    return global.__opportunities;
  }
  
  // Try to use local cache
  if (opportunitiesCache !== null) {
    return opportunitiesCache;
  }
  
  ensureDataFile();
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    const opportunities = JSON.parse(data);
    // Update caches
    global.__opportunities = opportunities;
    opportunitiesCache = opportunities;
    return opportunities;
  } catch (error) {
    console.error('Error reading opportunities:', error);
    return global.__opportunities || [];
  }
}

// Write opportunities to file and update cache
function writeOpportunities(opportunities: any[]): void {
  // Update global cache immediately (persists across invocations)
  global.__opportunities = opportunities;
  opportunitiesCache = opportunities;
  
  ensureDataFile();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(opportunities, null, 2));
  } catch (error) {
    console.error('Error writing opportunities:', error);
  }
}

// Read sessions from file and cache
function readSessions(): any[] {
  // Try to use global cache first
  if (global.__sessions && global.__sessions.length > 0) {
    return global.__sessions;
  }
  
  // Try to use local cache
  if (sessionsCache !== null) {
    return sessionsCache;
  }
  
  if (!fs.existsSync(SESSIONS_FILE)) {
    global.__sessions = [];
    sessionsCache = [];
    return [];
  }
  
  try {
    const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const sessions = JSON.parse(data);
    global.__sessions = sessions;
    sessionsCache = sessions;
    return sessions;
  } catch (error) {
    console.error('Error reading sessions:', error);
    return global.__sessions || [];
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
      
      // Load sessions for this opportunity
      const allSessions = readSessions();
      const opportunitySessions = allSessions.filter((session: any) => session.opportunity_id === id);
      opportunity.sessions = opportunitySessions;
      
      return res.status(200).json(opportunity);
    }
    
    // For list view, also load sessions for each opportunity
    const allSessions = readSessions();
    const opportunitiesWithSessions = opportunities.map((opp: any) => {
      opp.sessions = allSessions.filter((s: any) => s.opportunity_id === opp.id);
      return opp;
    });
    
    return res.status(200).json(opportunitiesWithSessions);
    
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

