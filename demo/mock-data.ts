// Mock data service for development when database is not available
let dynamicMockOpportunities: any[] = [
  {
    id: 'mock-1',
    type: 'test',
    title: 'User Interface Testing',
    purpose_one_liner: 'Help us improve our mobile app interface',
    description_optional: 'We are looking for users to test our new mobile app interface. This will involve completing various tasks while we observe your interactions.',
    product_optional: 'Mobile Banking App',
    default_duration_minutes: 45,
    status: 'published',
    owner_user_id: 'admin-user-id',
    external_link_optional: null,
    participant_type_required: 'any',
    participant_type_specific_details: null,
    created_at: new Date('2024-01-15T10:00:00Z'),
    updated_at: new Date('2024-01-15T10:00:00Z'),
    owner_name: 'Research Team',
    owner_email: 'research@adaptalabs.com',
    sessions: [
      {
        id: 'session-1',
        opportunity_id: 'mock-1',
        start_time: new Date('2024-12-01T14:00:00Z').toISOString(),
        end_time: new Date('2024-12-01T14:45:00Z').toISOString(),
        capacity: 5,
        booked_count: 2,
        location_or_meet_link_optional: 'https://meet.google.com/abc-defg-hij',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
        remaining: 3
      },
      {
        id: 'session-2',
        opportunity_id: 'mock-1',
        start_time: new Date('2024-12-02T10:00:00Z').toISOString(),
        end_time: new Date('2024-12-02T10:45:00Z').toISOString(),
        capacity: 5,
        booked_count: 0,
        location_or_meet_link_optional: 'https://meet.google.com/xyz-1234-uvw',
        created_at: new Date('2024-01-15T10:00:00Z'),
        updated_at: new Date('2024-01-15T10:00:00Z'),
        remaining: 5
      }
    ]
  },
  {
    id: 'mock-2',
    type: 'survey',
    title: 'Customer Satisfaction Survey',
    purpose_one_liner: 'Share your thoughts about our service experience',
    description_optional: 'We value your feedback! Please take 10 minutes to complete our customer satisfaction survey.',
    product_optional: 'E-commerce Platform',
    default_duration_minutes: 10,
    status: 'published',
    owner_user_id: 'admin-user-id',
    external_link_optional: null,
    participant_type_required: 'any',
    participant_type_specific_details: null,
    created_at: new Date('2024-01-10T09:00:00Z'),
    updated_at: new Date('2024-01-10T09:00:00Z'),
    owner_name: 'Customer Success Team',
    owner_email: 'success@adaptalabs.com',
    sessions: []
  },
  {
    id: 'mock-3',
    type: 'poll',
    title: 'Feature Preference Poll',
    purpose_one_liner: 'Vote on which features you would like to see next',
    description_optional: 'Help us prioritize our development roadmap by voting on potential new features.',
    product_optional: 'Project Management Tool',
    default_duration_minutes: 5,
    status: 'published',
    owner_user_id: 'admin-user-id',
    external_link_optional: null,
    participant_type_required: 'any',
    participant_type_specific_details: null,
    created_at: new Date('2024-01-12T11:30:00Z'),
    updated_at: new Date('2024-01-12T11:30:00Z'),
    owner_name: 'Product Team',
    owner_email: 'product@adaptalabs.com',
    sessions: []
  },
  {
    id: 'mock-4',
    type: 'question',
    title: 'Quick Feedback Question',
    purpose_one_liner: 'Answer one question about your experience',
    description_optional: 'A single question to help us understand user preferences.',
    product_optional: 'Learning Platform',
    default_duration_minutes: 2,
    status: 'published',
    owner_user_id: 'admin-user-id',
    external_link_optional: null,
    participant_type_required: 'any',
    participant_type_specific_details: null,
    created_at: new Date('2024-01-14T16:00:00Z'),
    updated_at: new Date('2024-01-14T16:00:00Z'),
    owner_name: 'UX Team',
    owner_email: 'ux@adaptalabs.com',
    sessions: []
  },
  {
    id: 'mock-5',
    type: 'test',
    title: 'Website Performance Testing',
    purpose_one_liner: 'Test our website performance and provide feedback',
    description_optional: 'Help us identify performance issues by testing our website on different devices and browsers.',
    product_optional: 'Corporate Website',
    default_duration_minutes: 30,
    status: 'draft',
    owner_user_id: 'admin-user-id',
    external_link_optional: null,
    participant_type_required: 'any',
    participant_type_specific_details: null,
    created_at: new Date('2024-01-16T08:00:00Z'),
    updated_at: new Date('2024-01-16T08:00:00Z'),
    owner_name: 'DevOps Team',
    owner_email: 'devops@adaptalabs.com',
    sessions: []
  }
];

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
