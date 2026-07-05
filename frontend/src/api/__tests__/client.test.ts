import { describe, expect, it } from 'vitest';

import { API_CONFIG } from '../../config/api';
import * as apiClient from '../client';

describe('API Client', () => {
  it('should have API_CONFIG defined', () => {
    expect(API_CONFIG).toBeDefined();
    expect(API_CONFIG.BASE_URL).toBeDefined();
    expect(API_CONFIG.AUTH_BASE_URL).toBeDefined();
    expect(API_CONFIG.TIMEOUT).toBeDefined();
  });

  it('should have API_CONFIG with correct structure', () => {
    expect(typeof API_CONFIG.BASE_URL).toBe('string');
    expect(typeof API_CONFIG.AUTH_BASE_URL).toBe('string');
    expect(typeof API_CONFIG.TIMEOUT).toBe('number');
  });

  it('should export API functions', () => {
    expect(typeof apiClient.getMe).toBe('function');
    expect(typeof apiClient.logout).toBe('function');
    expect(typeof apiClient.getOpportunities).toBe('function');
    expect(typeof apiClient.bookSession).toBe('function');
    expect(typeof apiClient.cancelBooking).toBe('function');
  });
});
