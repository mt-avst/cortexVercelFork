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

  // Fill in required fields
  await page.fill('#title', 'Test Draft Poll Study');
  await page.fill('#purpose_one_liner', 'This is a test to verify draft warnings appear correctly in the UI');

  // Go to next tab. Since C3 every forward control names its destination -
  // "Continue: {next step}" - and the label is derived from the step list
  // rather than written at the call site, which is what removed the old
  // "Continue to Link Setup" that then landed the author on Questions.
  await page.click('text=Continue: Content & Details');
  await page.waitForTimeout(500);

  // Go to external link tab
  await page.click('text=Continue: External Link');
  await page.waitForTimeout(500);

  // Fill external link
  await page.fill('#external_link_optional', 'https://example.com/poll');

  // On to Review, which is the only step that commits - and, since #111,
  // where Status now lives too. It moved off Basic Information deliberately:
  // publishing reads as the LAST decision on the form, not the first.
  await page.click('text=Continue: Review');
  await page.waitForTimeout(500);

  // Check the Draft pod is checked by default. Review's Status control is a
  // radiogroup of two pods (#167), not a `<select>` - each option is a real
  // `<input type="radio">` with a stable `${name}-${value}` id, so there is
  // no single `#status` element any more to read an `inputValue` from.
  const draftPod = page.getByRole('radiogroup', { name: 'Status' }).getByRole('radio', { name: /^Draft/ });
  await expect(draftPod).toBeChecked();

  // Check if status help text shows the warning. The icon here is a lucide
  // `AlertTriangle` SVG, not the "⚠️" glyph the success banner below uses
  // for the same warning - `toContainText('⚠️ DRAFT')` could never match
  // this element (pre-existing on main, before #167 too: the icon was never
  // text).
  const statusHelp = await page.locator('#status-help');
  await expect(statusHelp).toContainText('DRAFT - Not visible to users');

  console.log('✅ Draft warning is visible beside the Status pods!');

  // Submit the form
  await page.click('button:has-text("Create opportunity")');
  
  // The draft warning moved with the commit point. C3 removed the timed
  // navigation that used to hold this alert on the form for three seconds
  // before replacing the page underneath the author; the message now travels
  // in the navigation state and the dashboard renders it - with the same
  // words and the same warning style, which is what the assertions below
  // check. Waiting for the URL first is what stops this matching the form's
  // own status-help alert asserted at the top of this test.
  await page.waitForURL(/\/admin$/, { timeout: 10000 });
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

/**
 * Pressing Return must not commit the opportunity.
 *
 * The unit suite cannot see this: jsdom does not implement the HTML
 * implicit-submission algorithm, so the 1187 frontend tests were all green
 * while one keystroke on the External Link step created the opportunity and
 * navigated to the dashboard - from a step that is not Review, with no summary
 * ever shown. A real browser does implement it, which is where this was found,
 * so the guard belongs here as well as in the unit test that pins the handler.
 *
 * Deliberately asserts on the REQUEST rather than on the URL. A version of this
 * bug that posted and then failed to navigate would leave the URL unchanged and
 * this test green.
 */
test('pressing Return on a step that is not Review does not create anything', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/opportunities$/.test(request.url())) {
      posts.push(request.url());
    }
  });

  await page.goto('/auth/admin-login');
  await page.waitForLoadState('networkidle');
  await page.goto('/admin/opportunities/new');
  await page.waitForSelector('#type', { state: 'visible', timeout: 20000 });

  await page.selectOption('#type', 'poll');
  await page.waitForTimeout(300);
  await page.fill('#title', 'Return key must not commit');
  await page.fill('#purpose_one_liner', 'A keystroke must not create an opportunity from this step');

  await page.click('text=Continue: Content & Details');
  await page.waitForTimeout(400);
  await page.click('text=Continue: External Link');
  await page.waitForTimeout(400);

  // One text field on this step is exactly the condition the algorithm needs.
  await page.fill('#external_link_optional', 'https://example.com/return-probe');
  await page.locator('#external_link_optional').press('Enter');
  await page.waitForTimeout(2000);

  expect(posts).toHaveLength(0);
  // Still on the form, still on the same step.
  await expect(page).toHaveURL(/\/admin\/opportunities\/new/);
  await expect(page.locator('#external_link_optional')).toBeVisible();
});
