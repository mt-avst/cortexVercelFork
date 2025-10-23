// Mock data service for development when database is not available
let dynamicMockOpportunities: any[] = [];

// Export the original static data for reference
export const mockOpportunities = dynamicMockOpportunities;

export const getMockOpportunities = (filters?: {
  type?: string;
  q?: string;
  status?: string;
}) => {
  let filtered = [...dynamicMockOpportunities];

  if (filters?.type) {
    filtered = filtered.filter(opp => opp.type === filters.type);
  }

  if (filters?.q) {
    const query = filters.q.toLowerCase();
    filtered = filtered.filter(opp => 
      opp.title.toLowerCase().includes(query) ||
      opp.purpose_one_liner.toLowerCase().includes(query)
    );
  }

  if (filters?.status) {
    filtered = filtered.filter(opp => opp.status === filters.status);
  }

  return filtered;
};

export const getMockOpportunity = (id: string) => {
  return dynamicMockOpportunities.find(opp => opp.id === id);
};

// Function to add a new opportunity to the dynamic mock data
export const addMockOpportunity = (opportunity: any) => {
  dynamicMockOpportunities.unshift(opportunity);
};

// Function to update an opportunity in the dynamic mock data
export const updateMockOpportunity = (id: string, updates: any) => {
  const index = dynamicMockOpportunities.findIndex(opp => opp.id === id);
  if (index !== -1) {
    dynamicMockOpportunities[index] = { ...dynamicMockOpportunities[index], ...updates };
    return dynamicMockOpportunities[index];
  }
  return null;
};

// Function to delete an opportunity from the dynamic mock data
export const deleteMockOpportunity = (id: string) => {
  const index = dynamicMockOpportunities.findIndex(opp => opp.id === id);
  if (index !== -1) {
    dynamicMockOpportunities.splice(index, 1);
    return true;
  }
  return false;
};

// Mock sessions storage
let dynamicMockSessions: any[] = [];

// Function to add sessions to an opportunity in mock data
export const addMockSessions = (opportunityId: string, sessions: any[]) => {
  const opportunity = getMockOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error('Opportunity not found');
  }

  const newSessions = sessions.map(session => ({
    id: `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    opportunity_id: opportunityId,
    start_time: session.start_time,
    end_time: session.end_time,
    capacity: session.capacity,
    booked_count: 0,
    location_or_meet_link_optional: session.location_or_meet_link_optional || null,
    created_at: new Date(),
    updated_at: new Date(),
    remaining: session.capacity
  }));

  // Add to global sessions array
  dynamicMockSessions.push(...newSessions);

  // Update the opportunity's sessions array with the same session objects
  opportunity.sessions = [...(opportunity.sessions || []), ...newSessions];

  return newSessions;
};

// Function to get sessions for an opportunity
export const getMockSessions = (opportunityId: string) => {
  return dynamicMockSessions.filter(session => session.opportunity_id === opportunityId);
};

// Function to get all sessions (for finding by ID)
export const getAllMockSessions = () => {
  return dynamicMockSessions;
};

// Function to update a session in mock data
export const updateMockSession = (sessionId: string, updates: any) => {
  const sessionIndex = dynamicMockSessions.findIndex(session => session.id === sessionId);
  if (sessionIndex !== -1) {
    const updatedSession = { 
      ...dynamicMockSessions[sessionIndex], 
      ...updates,
      updated_at: new Date()
    };
    
    // Recalculate remaining field if capacity or booked_count changed
    if (updates.capacity !== undefined || updates.booked_count !== undefined) {
      updatedSession.remaining = updatedSession.capacity - updatedSession.booked_count;
    }
    
    dynamicMockSessions[sessionIndex] = updatedSession;
    
    // Also update the session in the opportunity's sessions array
    const opportunity = getMockOpportunity(updatedSession.opportunity_id);
    if (opportunity && opportunity.sessions) {
      const oppSessionIndex = opportunity.sessions.findIndex((s: any) => s.id === sessionId);
      if (oppSessionIndex !== -1) {
        opportunity.sessions[oppSessionIndex] = updatedSession;
      }
    }
    
    return updatedSession;
  }
  return null;
};

// Function to delete a session from mock data
export const deleteMockSession = (sessionId: string) => {
  const sessionIndex = dynamicMockSessions.findIndex(session => session.id === sessionId);
  if (sessionIndex !== -1) {
    const session = dynamicMockSessions[sessionIndex];
    dynamicMockSessions.splice(sessionIndex, 1);
    
    // Remove from opportunity's sessions array
    const opportunity = getMockOpportunity(session.opportunity_id);
    if (opportunity && opportunity.sessions) {
      opportunity.sessions = opportunity.sessions.filter((s: any) => s.id !== sessionId);
    }
    
    return true;
  }
  return false;
};
