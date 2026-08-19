import { test, expect } from '@playwright/test';

test('draft warning appears in create opportunity form', async ({ page }) => {
  // Login as admin
  await page.goto('/auth/admin-login');
  await page.waitForLoadState('networkidle');
  
  // Navigate to create opportunity form
  await page.goto('/admin/opportunities/new');
  await page.waitForLoadState('networkidle');
  
  // Select poll type
  await page.selectOption('#type', 'poll');
  
  // Check status dropdown is set to draft by default
  const statusValue = await page.inputValue('#status');
  expect(statusValue).toBe('draft');
  
  // Check if status help text shows the warning
  const statusHelp = await page.locator('#status-help');
  await expect(statusHelp).toContainText('⚠️ DRAFT');
  await expect(statusHelp).toContainText('Not visible to users');
  
  console.log('✅ Draft warning is visible in status dropdown!');
  
  // Fill in required fields
  await page.fill('#title', 'Test Draft Poll Study');
  await page.fill('#purpose_one_liner', 'This is a test to verify draft warnings appear correctly in the UI');
  
  // Go to next tab
  await page.click('text=Continue to Details');
  await page.waitForTimeout(500);
  
  // Go to external link tab
  await page.click('text=Continue to Link Setup');
  await page.waitForTimeout(500);
  
  // Fill external link
  await page.fill('#external_link_optional', 'https://example.com/poll');
  
  // Submit the form
  await page.click('button:has-text("Create Opportunity")');
  
  // Wait for success message
  await page.waitForSelector('.alert', { timeout: 5000 });
  
  // Check if success message contains draft warning
  const alert = await page.locator('.alert');
  await expect(alert).toHaveClass(/alert-warning/);
  await expect(alert).toContainText('⚠️');
  await expect(alert).toContainText('DRAFT');
  await expect(alert).toContainText('Not visible to users');
  
  console.log('✅ Draft warning appears in success message!');
  console.log('✅ Alert uses warning style (yellow) instead of success style!');
});
