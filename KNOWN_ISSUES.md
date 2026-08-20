# Known Issues and Limitations

**Version**: 7.43.5  
**Last Updated**: 2026-08-19  
**Status**: Alpha Testing Phase

---

## 🎯 Purpose

This document lists known issues, limitations, and workarounds for AdaptaLabs. This information helps set expectations for alpha testers and guides development priorities.

---

## ⚠️ Known Issues

### Critical Issues

**No live defects in the opportunity-authoring flow, down from three.**
All three are resolved as of release 7.43.7 (2026-08-19).
The reasoning is kept below rather than deleted, because two of the three were written up more alarmingly than they deserved and the corrections are worth reading.

Nothing was harmed by any of them: no real study has run, and every study and response in the deployment today is test data.

#### C1. Editing a study's questions cannot mis-attribute answers ~~RESOLVED~~ — and was never reachable

**Status**: Resolved 2026-08-19, and the original entry overstated it.
**What it claimed**: that reordering questions after participants had answered would silently re-attach their answers by position, reporting question 3's answers under question 1's prompt.

The underlying fragility is real. A step's identity is derived from its position in the list (`${studyId}_step_${index + 1}`), and `participant_responses.step_id` has no foreign key, so nothing in the database would catch such a shift.

**But no route ever reached it**, which the first write-up did not check:

- The **Task Lists** editor has no reorder control at all. Removing a step renumbers `order` only and leaves every surviving step's id attached to its own question, deliberately
- The **opportunity form** is the only thing that renumbers ids, and until 7.43.5 it *refused* to save authored content over a Task List that already existed — so the renumbering only ever ran when creating a study, before any answer could exist

Since 7.43.5 the opportunity form can update a linked Task List in place, and that path **refuses** the save when the study has already collected answers and the questions would change. Consent and duration edits still save, because they move no question onto another's id.

**What you still cannot do**: change the questions of a study that has collected answers, from the opportunity form. That is the refusal above, and it is deliberate.

**Corrected in 7.43.7**: that refusal used to fire on saves that changed no question at all. Task Lists built in the Task Lists area number their steps `_step_001` while the opportunity form numbers them `_step_1`, and the guard compared those ids — so a study with answers could not have its opportunity **retitled or even unpublished**, and the refusal named a change the author had not made. The route now keeps the stored ids, and the guard ignores whitespace and the trailing completion marker, which regenerates on every save.

#### C2. Reopening an opportunity shows an empty authoring surface ~~RESOLVED~~

**Status**: Resolved in release 7.43.7 (2026-08-19).
**What it was**: editing an opportunity did not load the questions, tasks or consent wording you had written. The form showed an empty question list and the default consent text, so it read as though nothing had ever been authored. The content was never lost — it was on the Task List, and only the form failed to read it back.

It looked like an empty form rather than like loss because a linked Task List also swapped the tab to the reuse picker, so there was no populated surface left to notice was missing.

Reopening an opportunity now shows exactly what you wrote — tasks or questions, the consent wording, the estimated duration and the starting URL — and you can edit it in place.

**Four cases are deliberately shown read-only instead**, because a save rewrites the linked Task List and anything the form could not display would be deleted:

- the Task List **belongs to another researcher**
- it uses **a step type this form cannot show** — a rating or a recommendation score on a recorded task list, for instance, which are only authorable on a survey
- it gives **a different starting URL per step**, which this form can only express as one URL for the whole study
- its **kind does not match** the opportunity — a recorded task list on a native survey, or the reverse

In each case the form says which of these applies. The first cannot be fixed in the Task Lists area either, since the same ownership rule applies there; the others can.

If the Task List **cannot be read at all**, every save is refused rather than the form showing a blank list a save would then write over the real one. If it **no longer exists**, saving stays available so the opportunity can be repointed or unpublished.

#### C3. An opportunity form cannot save changes to a Task List it already has ~~RESOLVED~~

**Status**: Resolved in release 7.43.5 (2026-08-19).
**What it was**: there was no in-place update path from the opportunity form to the Task List it was linked to. Saving an opportunity that already had one, while carrying freshly authored questions or tasks, was refused outright with *"This opportunity already has a task list; edit its tasks in the Task Lists area"*. So authored content was writable exactly once, and every correction after that had to be made somewhere else.

The form now updates the linked Task List in place. Three cases are still refused, each on purpose:

- the Task List belongs to **another researcher** — only its owner or a superadmin may edit it
- the Task List is **also used by another opportunity** — editing it here would change what that opportunity serves its participants, so it must be edited in the Task Lists area where the sharing is visible
- the study has **already collected answers** and the questions would change — see C1

C2 is resolved too, so the opportunity form now shows your content when you reopen it and the Task Lists area is no longer the only place to edit it.

An earlier draft of this entry said the save created a **duplicate** Task List and orphaned the original. That was true of an older build; the duplicate-and-orphan path was closed when native polls and surveys shipped, and the refusal replaced it.

#### A note on reuse

Not a defect, but frequently misread, so worth stating plainly here.
Reusing an existing Task List creates a **link**, not a copy.
Several opportunities can point at one Task List, and editing it changes what every one of them serves to future participants.
There is no way to take a copy today.
The interface does not say any of this; the Admin Guide does.

### Medium Priority Issues

#### 1. Email Reminders
**Status**: Automated (in-process cron in the Express backend)  
**Impact**: Low  
**Description**: Session reminder emails are sent automatically for bookings whose session starts in ~24 hours. The backend runs the job daily at 9:00 AM UTC via node-cron; GET /api/cron/send-reminders (Authorization: Bearer CRON_SECRET) triggers it manually. Requires migrations run (adds reminder_sent_at to bookings).

**Workaround**: If reminders are not received, check the backend logs for the cron run, confirm migrations have run and ensure SMTP/email is configured. Participants can set their own calendar reminders.

---

#### 2. Mobile Responsiveness
**Status**: Tested on mobile viewports  
**Impact**: Low-Medium  
**Description**: The application is responsive and production smoke tests run on Mobile Chrome (Pixel 5 viewport) and Mobile Safari (iPhone 12 viewport) in the Playwright matrix. Manual testing on real devices is still recommended for layout and touch targets.

**Workaround**: 
- Use desktop browser for most complex admin flows if preferred
- Report any mobile-specific issues via feedback form

**Note**: To run Mobile Safari E2E locally, run `npx playwright install webkit`.

---

#### 3. Booking calendar: very long study periods are truncated

**Status**: Bounded and announced as of 7.43.7 (2026-08-19)
**Impact**: Low
**Description**: The booking grid draws at most seven day columns. An opportunity whose sessions span longer than that cannot show every day at once.

Days that do not fit are named in a notice below the grid, and **days that have sessions are always drawn in preference to empty ones** — so a bookable slot is never hidden behind an empty weekday. If there are more than seven days *with sessions*, the earliest seven are shown and the notice reports how many remain.

**Until 7.43.7 this was worse in three separate ways**, each of which could hide a bookable session outright with no notice at all: the grid built columns Monday to Friday only, so a Saturday or Sunday session was never drawn and an all-weekend opportunity showed *"No sessions available"*; the render then capped at five columns, dropping a weekend day from a week that also had weekday sessions; and the seven-column window took the first seven days in date order, so a fortnightly Saturday opportunity spent its whole budget on empty weekdays and truncated the second bookable Saturday.

**Workaround**: the **Table** view on the opportunity page lists every future session regardless of span.

---

#### 4. Calendar Event Cancellation
**Status**: Known Limitation  
**Impact**: Low  
**Description**: When you cancel a booking, the event is removed from the **researcher's** calendar only (if calendar is configured). If you added the session to **your own** calendar (e.g. via the link in the confirmation email or an .ics attachment), you need to remove it yourself—the app does not delete events from participants' personal calendars.

**Workaround**: 
- After cancelling, if you had added the session to your own calendar, remove it manually from your calendar app
- Or keep the event as a reminder of the cancellation

**Planned Fix**: Participant calendar event deletion would require creating events on the participant's calendar at book time (via their OAuth) and storing that event ID; planned as a future enhancement

---

### Low Priority Issues

#### 5. Browser Compatibility
**Status**: Tested  
**Impact**: Low  
**Description**: Application is tested on:
- ✅ Chrome (latest)
- ✅ Firefox (latest)
- ✅ Safari (latest)
- ✅ Microsoft Edge (latest; included in Playwright E2E matrix)
- ❓ Other browsers (untested)

**Workaround**: Use Chrome, Firefox, Safari, or Edge for best experience

---

#### 6. Accessibility Compliance
**Status**: WCAG 2.2 AA targeted; axe-core tests on key routes  
**Impact**: Low (for alpha)  
**Description**: M8 fixes applied: CTA/primary button contrast (orange-700/800), power button contrast, Settings tab active color, heading order (Available Sessions h2; calendar day titles as divs), page h1 (Feedback, form loading). Run: `npx playwright test e2e/accessibility.test.ts --config=playwright.accessibility.config.ts` (start frontend first). Use `load` not `networkidle` when testing production.

**Known Issues**:
- Screen reader optimization is basic
- **Four `color-contrast` failures remain on the opportunity form in light mode**, measured 2026-08-20: `.btn-outline-primary`, `.btn-primary`, and the active step's title and description. All predate the C2 stepper — a before-and-after axe run against a build of `main` was identical node for node. Dark mode is clean.
- **`ConfirmationModal` renders its title as `<h5>`**, which skips heading levels under the page `<h1>` and reports as a moderate `heading-order` violation wherever it opens. It is shared by nine call sites, so the fix is not local to any one of them.

**Workaround**: 
- Use keyboard navigation (Tab, Enter, Escape). The opportunity form's step strip gives one Tab stop per step and then the form body; each step is a button carrying `aria-current="step"` and its state in words
- Report accessibility issues via feedback form

---

## 📋 Feature Limitations

### 1. Email Functionality

**Current State**:
- ✅ Booking confirmation emails are sent
- ✅ Cancellation emails are sent
- ✅ Reminder emails are sent automatically (backend cron, daily; ~24h before session)
- ⚠️ Email templates are basic

**Limitations**:
- Email deliverability depends on email service configuration
- Some email clients may filter emails to spam
- Email formatting is basic (no rich HTML templates)

**Workaround**: Check spam folder if emails don't arrive

---

### 2. Calendar Integration

**Current State**:
- ✅ Google Calendar events are created on booking (researcher's calendar)
- ✅ On cancellation, the event is deleted from the researcher's calendar (when calendar is configured)
- ⚠️ The **participant's** copy (if they added the session to their own calendar via email link/.ics) is not deleted by the app
- ⚠️ Reschedule may not update calendar event automatically

**Limitations**:
- Only Google Calendar is supported
- Calendar events are created on researcher's calendar; participants receive calendar invite via email
- Participants who add the session to their own calendar must remove it manually after cancelling

**Workaround**: 
- If you cancel a booking and had added the session to your own calendar, remove it there manually
- Use email calendar links (.ics files) as needed

---

### 3. Analytics

**Current State**:
- ✅ Click tracking for polls/surveys
- ✅ Basic analytics dashboard
- ⚠️ Limited historical data
- ⚠️ No export functionality

**Limitations**:
- Analytics only available for Poll and Survey types
- Data retention: 12 months (default)
- No CSV export
- No advanced reporting

**Planned Enhancement**: Export functionality in future release

---

### 4. Search and Filtering

**Current State**:
- ✅ Type filter (Test, Poll, Survey, etc.)
- ✅ Text search (title and description)
- ⚠️ No date range filtering
- ⚠️ No status filtering for users

**Limitations**:
- Search is basic (no fuzzy matching)
- No advanced filters
- No saved searches

**Workaround**: Use browser search (Ctrl+F / Cmd+F) for more control

---

### 5. Notifications

**Current State**:
- ✅ Email notifications for bookings/cancellations
- ✅ Admin notification preferences
- ⚠️ No in-app notifications
- ⚠️ No push notifications
- ⚠️ No notification history

**Limitations**:
- Email only (no in-app notifications)
- No notification preferences for regular users
- No notification history or archive

**Workaround**: Check email regularly for notifications

---

## 🔒 Security and Privacy

### Data Collection

**What We Collect**:
- Name, email (from SSO)
- Business unit, role/title (optional)
- Booking history
- Poll/survey click tracking (IP hashed)

**What We Don't Collect**:
- Passwords (handled by SSO)
- Payment information
- Sensitive personal data

**Privacy**:
- IP addresses are hashed for analytics
- Data retention: 12 months (default)
- Data is only accessible to admins

---

### Browser Compatibility

**Recommended Browsers**:
- Chrome (latest version) ✅
- Firefox (latest version) ✅
- Safari (latest version) ✅
- Edge (latest version) ⚠️ Limited testing

**Not Supported**:
- Internet Explorer (deprecated)
- Very old browser versions

---

## 🐛 Reporting Issues

### How to Report

1. **Use Feedback Form**: Click "Send Feedback" in header
2. **Service Desk**: Submit ticket via Service Desk
3. **Email**: nfine@adaptavist.com

### What to Include

When reporting issues, please include:
- **What you were trying to do**: Clear description of the task
- **What happened**: Actual behavior vs. expected behavior
- **Error messages**: Any error messages or codes
- **Steps to reproduce**: If applicable
- **Browser/Device**: Browser version and device type
- **Screenshots**: If helpful

---

## 🔄 Workarounds Summary

### Common Workarounds

1. **Email Not Received**
   - Check spam/junk folder
   - Wait a few minutes
   - Verify email address

2. **Calendar Event Not Created**
   - Check Google Calendar
   - Verify you're signed in with correct account
   - Check email for calendar link

3. **Can't Cancel Booking**
   - Make sure you're logged in
   - Check that booking is in "Upcoming" tab
   - Past bookings cannot be cancelled

4. **Mobile Layout Issues**
   - Use desktop browser if possible
   - Rotate device to landscape
   - Report issue via feedback form

5. **Search Not Finding Results**
   - Try different search terms
   - Clear filters
   - Use browser search (Ctrl+F)

---

## 📅 Planned Improvements

### Short Term (Next Release)
- [x] Full email reminder automation (backend cron + reminder_sent_at)
- [x] Calendar event cancellation docs and UI note
- [x] Mobile viewport E2E (Mobile Chrome/Safari in Playwright)
- [x] Edge and accessibility coverage
- [x] Improved error messages (500 responses use safe user-facing messages in production; see api/utils/errors.ts createSafeErrorResponse)

### Medium Term
- [ ] Full WCAG 2.2 AA compliance
- [ ] In-app notifications
- [ ] Advanced search and filtering
- [ ] CSV export for analytics

### Long Term
- [ ] Multi-calendar support
- [ ] Advanced reporting
- [ ] Notification preferences for users
- [ ] Mobile app (optional)

---

## ✅ What's Working Well

- ✅ Core booking functionality
- ✅ Session management
- ✅ Calendar integration (creation)
- ✅ Email confirmations
- ✅ Admin dashboard
- ✅ Poll/survey tracking
- ✅ User authentication
- ✅ Performance (fast page loads)

---

## 📝 Version History

**v3.12.0** (2025-01-27)
- Fixed demo login endpoints
- Improved error handling
- Added feedback mechanism
- Performance optimizations

---

**Last Updated**: 2026-07-05  
**For Questions**: Use feedback form or contact nfine@adaptavist.com

