import { chromium, Browser, Page } from 'playwright';
import { generateMockUser, generateMockOpportunity, generateMockSession } from '../../../shared/test-utils';

/* Raw `playwright` Browser, so playwright.config.ts's `use.baseURL` does not apply here.
 * Set it on the context so the relative paths below resolve. */
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

describe('Adaptalabs E2E Tests', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage({ baseURL: BASE_URL });
    
    // Set viewport size
    await page.setViewportSize({ width: 1280, height: 720 });
    
    // Mock API responses
    await page.route('**/api/me', async (route) => {
      const mockUser = generateMockUser();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockUser),
      });
    });

    await page.route('**/api/opportunities**', async (route) => {
      const mockOpportunities = [
        generateMockOpportunity({ id: 'opp-1', title: 'UI Testing Session' }),
        generateMockOpportunity({ id: 'opp-2', title: 'User Research Interview' }),
      ];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockOpportunities),
      });
    });

    await page.route('**/api/sessions**', async (route) => {
      const mockSessions = [
        generateMockSession({ 
          id: 'session-1', 
          opportunity_id: 'opp-1',
          start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          end_time: new Date(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
        }),
      ];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockSessions),
      });
    });
  });

  afterEach(async () => {
    await page.close();
  });

  describe('Authentication Flow', () => {
    it('should complete login flow', async () => {
      // Navigate to home page
      await page.goto('/');

      // Should see login options
      await expect(page.locator('text=Sign In')).toBeVisible();
      await expect(page.locator('text=Demo Login')).toBeVisible();

      // Click demo login
      await page.click('text=Demo Login');

      // Should be redirected to demo login page
      await expect(page.locator('text=Demo Login')).toBeVisible();

      // Fill in demo email
      await page.fill('input[type="email"]', 'demo@example.com');
      await page.click('button[type="submit"]');

      // Should be redirected back to home page
      await expect(page.locator('text=Welcome')).toBeVisible();
    });

    it('should handle admin login', async () => {
      await page.goto('/');

      // Click admin demo login
      await page.click('text=Admin Demo');

      // Should be redirected to admin login page
      await expect(page.locator('text=Admin Login')).toBeVisible();

      // Fill in admin email
      await page.fill('input[type="email"]', 'admin@example.com');
      await page.click('button[type="submit"]');

      // Should be redirected to admin page
      await expect(page.locator('text=Admin Dashboard')).toBeVisible();
    });

    it('should handle logout', async () => {
      // First login
      await page.goto('/');
      await page.click('text=Demo Login');
      await page.fill('input[type="email"]', 'demo@example.com');
      await page.click('button[type="submit"]');

      // Should see user menu
      await expect(page.locator('text=Demo User')).toBeVisible();

      // Click logout
      await page.click('text=Logout');

      // Should be redirected to home page
      await expect(page.locator('text=Sign In')).toBeVisible();
    });
  });

  describe('Opportunity Management', () => {
    beforeEach(async () => {
      // Login as admin
      await page.goto('/');
      await page.click('text=Admin Demo');
      await page.fill('input[type="email"]', 'admin@example.com');
      await page.click('button[type="submit"]');
    });

    it('should create new opportunity', async () => {
      // Navigate to admin page
      await expect(page.locator('text=Admin Dashboard')).toBeVisible();

      // Click create opportunity
      await page.click('text=Create Opportunity');

      // Fill basic information
      await page.selectOption('select[name="type"]', 'test');
      await page.fill('input[name="title"]', 'E2E Test Opportunity');
      await page.fill('textarea[name="purpose_one_liner"]', 'Testing the opportunity creation flow');
      await page.fill('input[name="default_duration_minutes"]', '30');

      // Save opportunity
      await page.click('text=Save Opportunity');

      // Should see success message
      await expect(page.locator('text=Opportunity created successfully')).toBeVisible();
    });

    it('should edit existing opportunity', async () => {
      // Navigate to opportunities list
      await page.goto('/admin');

      // Click on first opportunity
      await page.click('text=UI Testing Session');

      // Click edit button
      await page.click('text=Edit');

      // Update title
      await page.fill('input[name="title"]', 'Updated UI Testing Session');

      // Save changes
      await page.click('text=Save Changes');

      // Should see success message
      await expect(page.locator('text=Opportunity updated successfully')).toBeVisible();
    });

    it('should delete opportunity', async () => {
      // Navigate to opportunities list
      await page.goto('/admin');

      // Click on first opportunity
      await page.click('text=UI Testing Session');

      // Click delete button
      await page.click('text=Delete');

      // Confirm deletion
      await page.click('text=Confirm Delete');

      // Should see success message
      await expect(page.locator('text=Opportunity deleted successfully')).toBeVisible();
    });
  });

  describe('Session Management', () => {
    beforeEach(async () => {
      // Login as admin
      await page.goto('/');
      await page.click('text=Admin Demo');
      await page.fill('input[type="email"]', 'admin@example.com');
      await page.click('button[type="submit"]');
    });

    it('should create new session', async () => {
      // Navigate to opportunity detail
      await page.goto('/admin');
      await page.click('text=UI Testing Session');

      // Click add session
      await page.click('text=Add Session');

      // Fill session details
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const startTime = tomorrow.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
      const endTime = new Date(tomorrow.getTime() + 30 * 60 * 1000).toISOString().slice(0, 16);

      await page.fill('input[name="start_time"]', startTime);
      await page.fill('input[name="end_time"]', endTime);
      await page.fill('input[name="capacity"]', '5');

      // Save session
      await page.click('text=Save Session');

      // Should see success message
      await expect(page.locator('text=Session created successfully')).toBeVisible();
    });

    it('should edit existing session', async () => {
      // Navigate to opportunity detail
      await page.goto('/admin');
      await page.click('text=UI Testing Session');

      // Click edit on first session
      await page.click('text=Edit Session');

      // Update capacity
      await page.fill('input[name="capacity"]', '10');

      // Save changes
      await page.click('text=Save Changes');

      // Should see success message
      await expect(page.locator('text=Session updated successfully')).toBeVisible();
    });

    it('should delete session', async () => {
      // Navigate to opportunity detail
      await page.goto('/admin');
      await page.click('text=UI Testing Session');

      // Click delete on first session
      await page.click('text=Delete Session');

      // Confirm deletion
      await page.click('text=Confirm Delete');

      // Should see success message
      await expect(page.locator('text=Session deleted successfully')).toBeVisible();
    });
  });

  describe('Booking Flow', () => {
    beforeEach(async () => {
      // Login as regular user
      await page.goto('/');
      await page.click('text=Demo Login');
      await page.fill('input[type="email"]', 'demo@example.com');
      await page.click('button[type="submit"]');
    });

    it('should book a session', async () => {
      // Navigate to opportunities
      await page.goto('/');

      // Click on first opportunity
      await page.click('text=UI Testing Session');

      // Should see opportunity details
      await expect(page.locator('text=UI Testing Session')).toBeVisible();
      await expect(page.locator('text=Testing the opportunity creation flow')).toBeVisible();

      // Click on first available session
      await page.click('text=Book Session');

      // Should see booking confirmation
      await expect(page.locator('text=Confirm Booking')).toBeVisible();

      // Confirm booking
      await page.click('text=Confirm');

      // Should see success message
      await expect(page.locator('text=Successfully booked')).toBeVisible();
    });

    it('should cancel a booking', async () => {
      // First book a session
      await page.goto('/');
      await page.click('text=UI Testing Session');
      await page.click('text=Book Session');
      await page.click('text=Confirm');

      // Navigate to my bookings
      await page.click('text=My Bookings');

      // Should see the booking
      await expect(page.locator('text=UI Testing Session')).toBeVisible();

      // Click cancel booking
      await page.click('text=Cancel Booking');

      // Confirm cancellation
      await page.click('text=Confirm Cancel');

      // Should see success message
      await expect(page.locator('text=Booking cancelled successfully')).toBeVisible();
    });

    it('should handle booking conflicts', async () => {
      // Mock booking conflict response
      await page.route('**/api/bookings', async (route) => {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Session is fully booked' }),
        });
      });

      // Try to book a session
      await page.goto('/');
      await page.click('text=UI Testing Session');
      await page.click('text=Book Session');
      await page.click('text=Confirm');

      // Should see error message
      await expect(page.locator('text=Session is fully booked')).toBeVisible();
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      // Mock network error
      await page.route('**/api/**', async (route) => {
        await route.abort('failed');
      });

      await page.goto('/');

      // Should see error message
      await expect(page.locator('text=Network error')).toBeVisible();
    });

    it('should handle 404 errors', async () => {
      // Mock 404 response
      await page.route('**/api/opportunities/999', async (route) => {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Opportunity not found' }),
        });
      });

      await page.goto('/opportunity/999');

      // Should see 404 error
      await expect(page.locator('text=Opportunity not found')).toBeVisible();
    });

    it('should handle validation errors', async () => {
      // Login as admin
      await page.goto('/');
      await page.click('text=Admin Demo');
      await page.fill('input[type="email"]', 'admin@example.com');
      await page.click('button[type="submit"]');

      // Try to create opportunity with invalid data
      await page.click('text=Create Opportunity');
      await page.click('text=Save Opportunity');

      // Should see validation errors
      await expect(page.locator('text=Title is required')).toBeVisible();
      await expect(page.locator('text=Purpose is required')).toBeVisible();
    });
  });

  describe('Responsive Design', () => {
    it('should work on mobile devices', async () => {
      // Set mobile viewport
      await page.setViewportSize({ width: 375, height: 667 });

      await page.goto('/');

      // Should see mobile-friendly layout
      await expect(page.locator('text=Sign In')).toBeVisible();
      
      // Navigation should be collapsed
      await expect(page.locator('.navbar-toggler')).toBeVisible();
    });

    it('should work on tablet devices', async () => {
      // Set tablet viewport
      await page.setViewportSize({ width: 768, height: 1024 });

      await page.goto('/');

      // Should see tablet-friendly layout
      await expect(page.locator('text=Sign In')).toBeVisible();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels', async () => {
      await page.goto('/');

      // Check for ARIA labels on interactive elements
      const signInButton = page.locator('text=Sign In');
      await expect(signInButton).toHaveAttribute('aria-label');
    });

    it('should support keyboard navigation', async () => {
      await page.goto('/');

      // Tab through elements
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');

      // Should be able to activate elements with Enter
      await page.keyboard.press('Enter');
    });

    it('should have proper heading hierarchy', async () => {
      await page.goto('/');

      // Check for proper heading structure
      const h1 = page.locator('h1');
      await expect(h1).toBeVisible();
    });
  });
});
