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

// Read opportunities from cache/file
function readOpportunities(): any[] {
  if (global.__opportunities && global.__opportunities.length > 0) {
    return global.__opportunities;
  }
  
  if (opportunitiesCache !== null) {
    return opportunitiesCache;
  }
  
  if (!fs.existsSync(DATA_FILE)) {
    opportunitiesCache = [];
    global.__opportunities = [];
    return [];
  }
  
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    opportunitiesCache = JSON.parse(data);
    global.__opportunities = opportunitiesCache;
    return opportunitiesCache;
  } catch (error) {
    console.error('Error reading opportunities:', error);
    return global.__opportunities || [];
  }
}

// Read sessions from cache/file
function readSessions(): any[] {
  // Always read from file when getting sessions
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const sessions = JSON.parse(data);
      global.__sessions = sessions;
      sessionsCache = sessions;
      return sessions;
    }
    
    global.__sessions = [];
    sessionsCache = [];
    return [];
  } catch (error) {
    console.error('Error reading sessions:', error);
    return global.__sessions || [];
  }
}

// Write sessions to cache/file
function writeSessions(sessions: any[]): void {
  global.__sessions = sessions;
  sessionsCache = sessions;
  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (error) {
    console.error('Error writing sessions:', error);
  }
}

/**
 * GET /api/opportunities/[id]/sessions
 * Gets sessions for an opportunity
 * POST /api/opportunities/[id]/sessions
 * Creates sessions for an opportunity
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const opportunityId = req.query.id as string;
    console.log('Getting sessions for opportunity:', opportunityId);
    
    const sessions = readSessions();
    const opportunitySessions = sessions.filter((session: any) => session.opportunity_id === opportunityId);
    
    return res.status(200).json(opportunitySessions);
  }
  
  if (req.method === 'POST') {
    const opportunityId = req.query.id as string;
    console.log('Creating sessions for opportunity:', opportunityId);
    
    const sessionData = Array.isArray(req.body) ? req.body : [req.body];
    
    // Generate sessions with IDs
    const createdSessions = sessionData.map((session: any) => ({
      id: `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      opportunity_id: opportunityId,
      start_time: session.start_time,
      end_time: session.end_time,
      capacity: session.capacity || 1,
      booked_count: 0,
      location_or_meet_link_optional: session.location_or_meet_link_optional || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));
    
    // Read existing sessions and add new ones
    const sessions = readSessions();
    sessions.push(...createdSessions);
    writeSessions(sessions);
    
    // Update the opportunity with sessions
    const opportunities = readOpportunities();
    const opportunityIndex = opportunities.findIndex((opp: any) => opp.id === opportunityId);
    if (opportunityIndex !== -1) {
      if (!opportunities[opportunityIndex].sessions) {
        opportunities[opportunityIndex].sessions = [];
      }
      opportunities[opportunityIndex].sessions.push(...createdSessions);
    opportunitiesCache = opportunities;
    global.__opportunities = opportunities;
    
    // Write updated opportunities
      if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify([]));
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify(opportunities, null, 2));
    }
    
    console.log('Created sessions:', createdSessions.length);
    
    return res.status(201).json(createdSessions);
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}

