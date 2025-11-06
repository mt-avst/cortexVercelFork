import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Automated Accessibility Testing Suite
 * 
 * Tests WCAG 2.2 AA compliance using axe-core
 * Runs on all major pages of the application
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Accessibility Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Set viewport size
    await page.setViewportSize({ width: 1280, height: 720 });
    
    // Mock API responses for consistency (only if not using production)
    if (BASE_URL.includes('localhost')) {
      await page.route('**/api/me', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'user-1',
            name: 'Demo User',
            email: 'demo@example.com',
            role: 'employee',
            business_unit: 'Engineering',
            role_title: 'Developer'
          }),
        });
      });

      await page.route('**/api/opportunities**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'opp-1',
              type: 'test',
              title: 'Accessibility Test Opportunity',
              purpose_one_liner: 'Testing accessibility features',
              description_optional: 'This is a test opportunity for accessibility testing',
              status: 'published',
              default_duration_minutes: 30,
              sessions: [
                {
                  id: 'session-1',
                  opportunity_id: 'opp-1',
                  start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                  end_time: new Date(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
                  capacity: 5,
                  booked_count: 0
                }
              ]
            }
          ]),
        });
      });
    }
  });

  test('Home page should be accessible', async ({ page }) => {
    await page.goto(BASE_URL);
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
    
    // Run accessibility check
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Home page (logged in) should be accessible', async ({ page }) => {
    // Mock logged-in state
    await page.goto(BASE_URL);
    
    // Set cookie to simulate logged-in user
    await page.context().addCookies([{
      name: 'session',
      value: 'mock-session-cookie',
      domain: 'localhost',
      path: '/',
    }]);
    
    await page.reload();
    await page.waitForLoadState('networkidle');
    
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Opportunity Detail page should be accessible', async ({ page }) => {
    await page.route('**/api/opportunities/opp-1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'opp-1',
          type: 'test',
          title: 'Accessibility Test Opportunity',
          purpose_one_liner: 'Testing accessibility features',
          description_optional: 'This is a test opportunity',
          status: 'published',
          default_duration_minutes: 30,
          sessions: [
            {
              id: 'session-1',
              opportunity_id: 'opp-1',
              start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              end_time: new Date(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
              capacity: 5,
              booked_count: 0
            }
          ]
        }),
      });
    });

    await page.goto(`${BASE_URL}/opportunities/opp-1`);
    await page.waitForLoadState('networkidle');
    
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Admin Dashboard should be accessible', async ({ page }) => {
    // Mock admin user
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'admin-1',
          name: 'Admin User',
          email: 'admin@example.com',
          role: 'researcher_admin',
          business_unit: 'Research',
          role_title: 'Researcher'
        }),
      });
    });

    await page.route('**/api/dashboard', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalOpportunities: 5,
          totalBookings: 10,
          totalParticipants: 8,
          availableSlots: 25
        }),
      });
    });

    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState('networkidle');
    
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Forms should be accessible', async ({ page }) => {
    // Mock admin user for form access
    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'admin-1',
          name: 'Admin User',
          email: 'admin@example.com',
          role: 'researcher_admin',
        }),
      });
    });

    await page.goto(`${BASE_URL}/admin/opportunities/new`);
    await page.waitForLoadState('networkidle');
    
    // Test form accessibility
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Header navigation should be accessible', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    
    // Test header specifically
    const header = page.locator('header');
    await expect(header).toBeVisible();
    
    // Check skip link
    const skipLink = page.locator('a.skip-link');
    await expect(skipLink).toHaveAttribute('href', '#main-content');
    
    // Verify skip link works
    await skipLink.focus();
    await expect(skipLink).toBeVisible();
    
    // Test accessibility of header only
    const accessibilityScanResults = await new AxeBuilder({ page })
      .include('header')
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Skip link should be functional', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    
    // Check if skip link exists
    const skipLink = page.locator('a.skip-link');
    const skipLinkCount = await skipLink.count();
    
    // Skip link should exist
    expect(skipLinkCount).toBeGreaterThan(0);
    
    // Focus skip link (Tab key focuses it)
    // Skip link should be the first focusable element
    await page.keyboard.press('Tab');
    
    // Wait a moment for CSS transition
    await page.waitForTimeout(200);
    
    // Skip link should be visible when focused
    await expect(skipLink).toBeVisible({ timeout: 2000 });
    
    // Verify skip link is focused or has the correct href
    const focusedElement = page.locator(':focus');
    const focusedHref = await focusedElement.getAttribute('href');
    expect(focusedHref).toBe('#main-content');
    
    // Activate skip link
    await page.keyboard.press('Enter');
    
    // Wait for navigation
    await page.waitForTimeout(100);
    
    // Should focus main content
    const mainContent = page.locator('#main-content');
    await expect(mainContent).toBeVisible();
  });

  test('Keyboard navigation should work', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    
    // Tab through interactive elements
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    
    // All elements should be focusable
    const focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible();
  });

  test('Color contrast should meet WCAG AA standards', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    
    // Check accessibility with color contrast rules
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .analyze();
    
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Images should have alt text', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    
    // Check image accessibility
    const images = page.locator('img');
    const count = await images.count();
    
    for (let i = 0; i < count; i++) {
      const img = images.nth(i);
      const alt = await img.getAttribute('alt');
      // Alt should exist (can be empty string for decorative images)
      expect(alt).not.toBeNull();
    }
  });

  test('Form inputs should have labels', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    
    // Check form accessibility
    const inputs = page.locator('input[type="text"], input[type="email"], input[type="number"], select, textarea');
    const count = await inputs.count();
    
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const id = await input.getAttribute('id');
      const ariaLabel = await input.getAttribute('aria-label');
      const ariaLabelledBy = await input.getAttribute('aria-labelledby');
      
      // Should have either id (for label association), aria-label, or aria-labelledby
      const hasLabel = id || ariaLabel || ariaLabelledBy;
      expect(hasLabel).toBeTruthy();
    }
  });
});

