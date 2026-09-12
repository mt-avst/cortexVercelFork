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
