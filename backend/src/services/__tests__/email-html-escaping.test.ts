import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { EmailService } from '../email';

/**
 * EVERY `${}` IN AN EMAIL'S HTML BODY IS ESCAPED, AND STAYS ESCAPED.
 *
 * The five templates interpolated user-controlled strings straight into HTML.
 * Two routes matter:
 *
 *   - `opportunityTitle` and `sessionLocation` are authored by a
 *     researcher_admin and land in a PARTICIPANT's inbox.
 *   - `feedback`, `userName`, `userAgent` and `url` come from any
 *     authenticated user and land in an ADMIN's.
 *
 * A title of `</h3><a href="https://evil.example">Reschedule here</a>` rendered
 * as markup inside a message carrying the platform's own From address. That is
 * a better phishing surface than a page on the site, because the reader has
 * already decided the sender is trustworthy. Most clients drop <script>; none
 * drop <a> or <img>, so the realistic payloads are a link and a tracking pixel.
 *
 * WHY THE SOURCE SCAN EXISTS AS WELL AS THE PAYLOAD TESTS. A per-field
 * assertion cannot fail for a field nobody wrote an assertion for, and these
 * templates gain fields. The scan reads the shipped file and requires every
 * interpolation inside an `html` literal to be escaped or to be one of a small
 * set of provably-safe expressions - so a NEW unescaped field fails here
 * without anyone remembering to add a case.
 *
 * The `text` half is deliberately NOT escaped: it is sent as text/plain, where
 * `&amp;` would be shown to the reader literally. The final test pins that, so
 * a later "escape everything" sweep cannot quietly corrupt the plain-text body.
 */

const XSS = '</h3><a href="https://evil.example">Reschedule here</a><img src=x onerror=alert(1)>';
const AMP = 'Tea & Biscuits <Research>';
const START = new Date('2026-09-01T10:00:00Z');
const END = new Date('2026-09-01T11:00:00Z');

/** The markup a successful injection would produce, in escaped form. */
const NEUTRALISED = '&lt;/h3&gt;&lt;a href=&quot;https://evil.example&quot;&gt;';

describe('email HTML escaping', () => {
  describe('the payload does not survive into the markup', () => {
    it('escapes a researcher-authored title in the confirmation a participant receives', () => {
      const { html } = EmailService.getBookingConfirmationTemplate(XSS, 'Ada', START, END);

      expect(html).not.toContain('<a href="https://evil.example"');
      // NOT `not.toContain('onerror=')`. Escaping neutralises the DELIMITERS,
      // it does not delete the characters - the escaped body still holds the
      // literal text `onerror=`, inertly, and asserting otherwise fails
      // against correct output. What must not appear is the markup.
      expect(html).not.toContain('<img src=x');
      expect(html).toContain(NEUTRALISED);
    });

    it('escapes a researcher-authored session location', () => {
      const { html } = EmailService.getBookingConfirmationTemplate(
        'A study', 'Ada', START, END, XSS
      );

      expect(html).not.toContain('<a href="https://evil.example"');
      expect(html).toContain(NEUTRALISED);
    });

    it('escapes the participant name in a cancellation', () => {
      const { html } = EmailService.getBookingCancellationTemplate(
        'A study', XSS, START, END, 'Someone'
      );

      expect(html).not.toContain('<a href="https://evil.example"');
      expect(html).toContain(NEUTRALISED);
    });

    it('escapes who cancelled, which the caller supplies', () => {
      const { html } = EmailService.getBookingCancellationTemplate(
        'A study', 'Ada', START, END, XSS
      );

      expect(html).not.toContain('<a href="https://evil.example"');
    });

    it('escapes the title and researcher in a reminder', () => {
      const { html } = EmailService.getBookingReminderTemplate(
        XSS, 'Ada', START, END, undefined, XSS
      );

      expect(html).not.toContain('<a href="https://evil.example"');
      expect(html).toContain(NEUTRALISED);
    });

    it('escapes free-text feedback on its way to an admin', () => {
      const { html } = EmailService.getFeedbackTemplate(
        'bug', XSS, XSS, 'a@example.com', XSS, XSS
      );

      expect(html).not.toContain('<a href="https://evil.example"');
      // NOT `not.toContain('onerror=')`. Escaping neutralises the DELIMITERS,
      // it does not delete the characters - the escaped body still holds the
      // literal text `onerror=`, inertly, and asserting otherwise fails
      // against correct output. What must not appear is the markup.
      expect(html).not.toContain('<img src=x');
      expect(html).toContain(NEUTRALISED);
    });

    it('escapes the participant identity in the notice sent to the owner', () => {
      const { html } = EmailService.getAdminNotificationTemplate(
        XSS, XSS, 'p@example.com', START, END, 'booked'
      );

      expect(html).not.toContain('<a href="https://evil.example"');
      expect(html).toContain(NEUTRALISED);
    });
  });

  /**
   * THE CONTROL. Every assertion above is an absence, and an absence passes
   * just as well against a template that renders nothing at all - or one whose
   * signature changed so the payload never reached the body. These prove the
   * fixture genuinely puts the caller's data into the markup.
   */
  describe('the control: ordinary data still reaches the body', () => {
    it('still renders a title, escaping only what HTML requires', () => {
      const { html } = EmailService.getBookingConfirmationTemplate(AMP, 'Ada', START, END);

      expect(html).toContain('Tea &amp; Biscuits &lt;Research&gt;');
      expect(html).toContain('Ada');
    });

    // Each of the five replacements gets an assertion that dies with it. The
    // apostrophe one had none: removing `.replace(/'/g, '&#39;')` passed
    // 1060/1060. It is not exploitable while every attribute in the file is
    // double-quoted, so this is defence in depth - but an unpinned member of a
    // security helper is one refactor away from being the exploitable one, and
    // the whole argument of this file is that a guard nothing can fail is not
    // a guard.
    it('escapes apostrophes, which nothing else here would notice', () => {
      const { html } = EmailService.getBookingConfirmationTemplate(
        "Nick's study", 'Ada', START, END
      );

      expect(html).toContain('Nick&#39;s study');
      expect(html).not.toContain("Nick's study");
    });

    it('still renders the calendar links as links', () => {
      const { html } = EmailService.getBookingConfirmationTemplate('A study', 'Ada', START, END);

      expect(html).toContain('<a href="https://calendar.google.com/');
      expect(html).toContain('Add to Google Calendar');
    });
  });

  /**
   * A NEW FIELD CANNOT ARRIVE UNESCAPED.
   *
   * Reads the shipped source rather than the rendered output, because the
   * per-field tests above can only see fields somebody thought to test.
   */
  describe('the source scan', () => {
    const SOURCE = fs.readFileSync(
      path.join(__dirname, '..', 'email.ts'),
      'utf8'
    );

    /** Interpolations that are safe without escaping, and why. */
    const SAFE = [
      /^new Date\(\)\.toISOString\(\)$/,          // ISO-8601, no HTML metacharacters
      /^duration$/,                                // Math.round(...) - a number
      /^hoursUntil$/,                              // Math.round(...) - a number
      /^process\.env\.FRONTEND_URL \|\| '[^']*'$/, // operator config, not user input
      /^action === 'booked' \? '[^']*' : '[^']*'$/,// ternary over a literal union
    ];

    const htmlBlocks = (): string[] => {
      const blocks = SOURCE.match(/const html = `[\s\S]*?`;\n/g);
      return blocks ?? [];
    };

    /**
     * DESCENDS INTO CONDITIONAL FRAGMENTS RATHER THAN JUDGING THEM WHOLE.
     *
     * The first version of this returned each `${...}` as one string, and the
     * two filters below then dropped any fragment that either contained one
     * `this.e(` (read as "escaped") or none at all (read as "structural").
     * Between them they made this shape INVISIBLE:
     *
     *   ${notes ? `<p>Notes: ${notes}</p>` : ''}
     *
     * which is exactly the idiom already used four times in email.ts for
     * `sessionLocation`, `ownerName` and `ownerEmail` - so it is the idiom the
     * next optional field gets copied from. A field added that way rendered a
     * live `<a href="https://evil.example">` into a participant's inbox and
     * passed 12/12 here and 1060/1060 across the backend.
     *
     * A fragment with no interpolations of its own is returned as itself, so a
     * literal-only conditional still has to satisfy the allow-list. Failing
     * closed is the right direction for this check.
     */
    const RE = /\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
    const interpolationsIn = (block: string): string[] =>
      (block.match(RE) ?? []).flatMap((m) => {
        const expr = m.slice(2, -1).trim();
        const inner = interpolationsIn(expr);
        return inner.length > 0 ? inner : [expr];
      });

    // The presence arm for the two absence-assertions below. If the regex
    // stopped matching - a rename, a reformat, a switch to a helper - both
    // would pass against a file they never read.
    it('finds every html template in the shipped source', () => {
      expect(htmlBlocks()).toHaveLength(5);
      expect(htmlBlocks().flatMap(interpolationsIn).length).toBeGreaterThan(20);
    });

    it('escapes every interpolation in an html body, or proves it safe', () => {
      const unescaped = htmlBlocks()
        .flatMap(interpolationsIn)
        .filter((expr) => !expr.includes('this.e('))
        .filter((expr) => !SAFE.some((re) => re.test(expr)));

      expect(unescaped).toEqual([]);
    });

    it('leaves the text bodies alone, because they are not markup', () => {
      const textBlocks = SOURCE.match(/const text = `[\s\S]*?`;\n/g) ?? [];

      expect(textBlocks).toHaveLength(5);
      expect(textBlocks.join('')).not.toContain('this.e(');
    });
  });
});
