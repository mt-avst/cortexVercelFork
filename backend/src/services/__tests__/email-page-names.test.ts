import { describe, it, expect } from '@jest/globals';
import { EmailService } from '../email';

/**
 * #169: the researcher workspace at /admin is called "Create & Manage". The
 * booking notice an owner receives links there, so it uses that name - in the
 * HTML escaped as `&amp;`, in the plain-text body as a bare `&`.
 */
describe('the owner booking notice names Create & Manage (#169)', () => {
  const start = new Date('2026-09-01T10:00:00Z');
  const end = new Date('2026-09-01T11:00:00Z');
  const { html, text } = EmailService.getAdminNotificationTemplate(
    'Checkout study', 'Pat', 'pat@example.com', start, end, 'booked'
  );

  it('links to Create & Manage in the HTML body, escaped', () => {
    expect(html).toMatch(/\/admin" [^>]*>Create &amp; Manage<\/a>/);
    expect(html).not.toMatch(/Admin Dashboard/i);
  });

  it('names Create & Manage in the plain-text body, unescaped', () => {
    expect(text).toContain('Create & Manage: ');
    expect(text).not.toContain('&amp;');
  });
});
