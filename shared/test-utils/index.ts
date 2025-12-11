// Shared Test Utilities for Adaptalabs Application
// This file contains common test utilities used by both frontend and backend tests

import { Request, Response, NextFunction } from 'express';

// ============================================================================
// MOCK DATA GENERATORS
// ============================================================================

/**
 * Generate mock user data for testing
 */
export const generateMockUser = (overrides: Partial<any> = {}) => ({
  id: 'test-user-id',
  name: 'Test User',
  email: 'test@example.com',
  business_unit: 'Engineering',
  role_title: 'Software Engineer',
  role: 'employee' as const,
  created_at: new Date().toISOString(),
  ...overrides,
});

/**
 * Generate mock opportunity data for testing
 */
export const generateMockOpportunity = (overrides: Partial<any> = {}) => ({
  id: 'test-opportunity-id',
  type: 'test' as const,
  title: 'Test Opportunity',
  purpose_one_liner: 'Test purpose',
  description_optional: 'Test description',
  product_optional: 'Test product',
  default_duration_minutes: 30,
  status: 'published' as const,
  owner_user_id: 'test-user-id',
  external_link_optional: undefined,
  participant_type_required: 'any' as const,
  participant_type_specific_details: undefined,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

/**
 * Generate mock session data for testing
 */
export const generateMockSession = (overrides: Partial<any> = {}) => ({
  id: 'test-session-id',
  opportunity_id: 'test-opportunity-id',
  start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Tomorrow
  end_time: new Date(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(), // Tomorrow + 30 min
  capacity: 5,
  booked_count: 0,
  location_or_meet_link_optional: undefined,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  remaining: 5,
  ...overrides,
});

/**
 * Generate mock booking data for testing
 */
export const generateMockBooking = (overrides: Partial<any> = {}) => ({
  id: 'test-booking-id',
  user_id: 'test-user-id',
  session_id: 'test-session-id',
  status: 'booked' as const,
  gcal_event_id: undefined,
  cancelled_at: undefined,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

// ============================================================================
// EXPRESS MOCK HELPERS
// ============================================================================

/**
 * Create a mock Express request object
 */
export const createMockRequest = (overrides: Partial<Request> = {}): any => ({
  method: 'GET',
  url: '/test',
  headers: {},
  body: {},
  params: {},
  query: {},
  user: undefined,
  ...overrides,
});

/**
 * Create a mock Express response object
 */
export const createMockResponse = (): Partial<Response> => {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    getHeader: jest.fn(),
    locals: {},
  };
  return res;
};

/**
 * Create a mock Express next function
 */
export const createMockNext = (): NextFunction => jest.fn();

// ============================================================================
// DATABASE MOCK HELPERS
// ============================================================================

/**
 * Create a mock database query result
 */
export const createMockQueryResult = (rows: any[] = []) => ({
  rows,
  rowCount: rows.length,
  command: 'SELECT',
  oid: 0,
  fields: [],
});

/**
 * Create a mock database client
 */
export const createMockDbClient = () => ({
  query: jest.fn(),
  connect: jest.fn(),
  end: jest.fn(),
  release: jest.fn(),
});

// ============================================================================
// API MOCK HELPERS
// ============================================================================

/**
 * Create a mock API response
 */
export const createMockApiResponse = <T>(data: T, status: number = 200) => ({
  data,
  status,
  statusText: 'OK',
  headers: {},
  config: {},
});

/**
 * Create a mock API error response
 */
export const createMockApiError = (status: number = 500, message: string = 'Internal Server Error') => ({
  response: {
    data: { error: message },
    status,
    statusText: 'Error',
    headers: {},
    config: {},
  },
  message,
  code: 'API_ERROR',
});

// ============================================================================
// AUTHENTICATION MOCK HELPERS
// ============================================================================

/**
 * Create a mock authenticated request
 */
export const createMockAuthenticatedRequest = (user: any = generateMockUser()) => ({
  ...createMockRequest(),
  user,
  isAuthenticated: () => true,
});

/**
 * Create a mock unauthenticated request
 */
export const createMockUnauthenticatedRequest = () => ({
  ...createMockRequest(),
  user: undefined,
  isAuthenticated: () => false,
});

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Test if a value is a valid email
 */
export const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Test if a value is a valid URL
 */
export const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

/**
 * Test if a value is a valid ISO date string
 */
export const isValidISODate = (dateString: string): boolean => {
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime()) && dateString === date.toISOString();
};

// ============================================================================
// TEST DATA CLEANUP
// ============================================================================

/**
 * Whitelist of valid table names for test cleanup.
 * Prevents SQL injection in test utilities.
 */
const VALID_TEST_TABLES = new Set([
  'bookings',
  'sessions',
  'opportunities',
  'users',
  'feedback',
  'notification_preferences',
  'user_calendar_tokens',
  'opportunity_clicks',
  'admin_requests',
]);

/**
 * Clean up test data after tests
 * SECURITY: Table name is validated against whitelist to prevent SQL injection
 */
export const cleanupTestData = async (dbClient: any, tableName: string, testId: string) => {
  // Validate table name against whitelist
  if (!VALID_TEST_TABLES.has(tableName.toLowerCase())) {
    console.warn(`Invalid table name for cleanup: ${tableName}`);
    return;
  }
  
  try {
    // Use the validated table name (still use parameterized query for testId)
    await dbClient.query(`DELETE FROM ${tableName.toLowerCase()} WHERE id LIKE $1`, [`${testId}%`]);
  } catch (error) {
    console.warn(`Failed to cleanup test data from ${tableName}:`, error);
  }
};

/**
 * Clean up all test data
 */
export const cleanupAllTestData = async (dbClient: any) => {
  const tables = ['bookings', 'sessions', 'opportunities', 'users'];
  for (const table of tables) {
    await cleanupTestData(dbClient, table, 'test-');
  }
};

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

/**
 * Assert that a response has the expected structure
 */
export const assertApiResponse = (response: any, expectedStatus: number, expectedData?: any) => {
  expect(response.status).toBe(expectedStatus);
  if (expectedData) {
    expect(response.data).toEqual(expectedData);
  }
};

/**
 * Assert that an error response has the expected structure
 */
export const assertErrorResponse = (response: any, expectedStatus: number, expectedError?: string) => {
  expect(response.status).toBe(expectedStatus);
  expect(response.data).toHaveProperty('error');
  if (expectedError) {
    expect(response.data.error).toBe(expectedError);
  }
};

/**
 * Assert that a database query was called with expected parameters
 */
export const assertDbQuery = (mockQuery: jest.Mock, expectedQuery: string, expectedParams?: any[]) => {
  expect(mockQuery).toHaveBeenCalled();
  const calls = mockQuery.mock.calls;
  const lastCall = calls[calls.length - 1];
  expect(lastCall[0]).toBe(expectedQuery);
  if (expectedParams) {
    expect(lastCall[1]).toEqual(expectedParams);
  }
};

// ============================================================================
// TIME HELPERS
// ============================================================================

/**
 * Create a date that's a certain number of days from now
 */
export const createFutureDate = (daysFromNow: number): Date => {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date;
};

/**
 * Create a date that's a certain number of hours from now
 */
export const createFutureHour = (hoursFromNow: number): Date => {
  const date = new Date();
  date.setHours(date.getHours() + hoursFromNow);
  return date;
};

/**
 * Create a date that's a certain number of minutes from now
 */
export const createFutureMinute = (minutesFromNow: number): Date => {
  const date = new Date();
  date.setMinutes(date.getMinutes() + minutesFromNow);
  return date;
};

// ============================================================================
// MOCK IMPLEMENTATIONS
// ============================================================================

/**
 * Mock console methods for testing
 */
export const mockConsole = () => {
  const originalConsole = { ...console };
  
  beforeEach(() => {
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
    console.info = jest.fn();
    console.debug = jest.fn();
  });
  
  afterEach(() => {
    Object.assign(console, originalConsole);
  });
};

/**
 * Mock environment variables for testing
 */
export const mockEnv = (envVars: Record<string, string>) => {
  const originalEnv = { ...process.env };
  
  beforeEach(() => {
    Object.assign(process.env, envVars);
  });
  
  afterEach(() => {
    process.env = originalEnv;
  });
};

// ============================================================================
// INTEGRATION TEST HELPERS
// ============================================================================

/**
 * Wait for a condition to be true
 */
export const waitFor = async (condition: () => boolean, timeout: number = 5000): Promise<void> => {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!condition()) {
    throw new Error(`Condition not met within ${timeout}ms`);
  }
};

/**
 * Retry a function until it succeeds or times out
 */
export const retry = async <T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 1000
): Promise<T> => {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt === maxRetries) break;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError!;
};
