// Simple API client tests
describe('API Client', () => {
  it('should have API_CONFIG defined', () => {
    const { API_CONFIG } = require('../../config/api');
    expect(API_CONFIG).toBeDefined();
    expect(API_CONFIG.BASE_URL).toBeDefined();
    expect(API_CONFIG.AUTH_BASE_URL).toBeDefined();
    expect(API_CONFIG.TIMEOUT).toBeDefined();
  });

  it('should have API_CONFIG with correct structure', () => {
    const { API_CONFIG } = require('../../config/api');
    expect(typeof API_CONFIG.BASE_URL).toBe('string');
    expect(typeof API_CONFIG.AUTH_BASE_URL).toBe('string');
    expect(typeof API_CONFIG.TIMEOUT).toBe('number');
  });

  it('should export API functions', () => {
    const apiClient = require('../client');
    expect(typeof apiClient.getMe).toBe('function');
    expect(typeof apiClient.logout).toBe('function');
    expect(typeof apiClient.getOpportunities).toBe('function');
    expect(typeof apiClient.bookSession).toBe('function');
    expect(typeof apiClient.cancelBooking).toBe('function');
  });
});
