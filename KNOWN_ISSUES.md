# Known Issues and Limitations

**Version**: 7.42.4  
**Last Updated**: 2026-08-18  
**Status**: Alpha Testing Phase

---

## 🎯 Purpose

This document lists known issues, limitations, and workarounds for AdaptaLabs. This information helps set expectations for alpha testers and guides development priorities.

---

## ⚠️ Known Issues

### Critical Issues

Three defects in the opportunity-authoring flow, all found by a code review on 2026-08-18 and none of them yet fixed.
A rework is planned; until it lands, the workarounds below are the whole mitigation.

None of these has harmed anything so far, because no real study has run — every study and response in the deployment today is test data.
The first one becomes unfixable in retrospect the moment a real participant answers a real question.

#### C1. Reordering or editing questions mis-attributes answers already collected

**Impact**: High. Silent, and not detectable after the fact.
**Description**: A question's identity is derived from its position in the list, not from the question.
So if you reorder your questions after participants have answered them, the results view re-attaches the existing answers by position — reporting question 3's answers under question 1's prompt.
Nothing warns you, and there is no way to tell afterwards that it happened.
Deleting a question has the same effect on everything below it.

**Workaround**: Do not reorder, insert, or delete questions on a study that has collected any answers.
Get the order right before you publish.
If you must change the questions after data has been collected, create a new opportunity instead and leave the original alone.

#### C2. Reopening an opportunity shows an empty authoring surface

**Impact**: High.
**Description**: Editing an opportunity does not load the questions, tasks or consent wording you originally wrote.
The form shows an empty question list and the default consent text.
It reads as though nothing was ever authored.
Your content is not lost — it is stored on the Task List, and only the authoring form fails to read it back.

**Workaround**: Edit questions, tasks and consent wording in the **Task Lists** area (`/admin/studies`), not on the opportunity form.
Do not re-author them on the opportunity form: see C3.

#### C3. An opportunity form cannot save changes to a Task List it already has

**Impact**: Medium, rising to High in combination with C2.
**Description**: There is no in-place update path from the opportunity form to the Task List it is linked to.
Saving an opportunity that already has a Task List, while carrying freshly authored questions or tasks, is refused outright with *"This opportunity already has a task list; edit its tasks in the Task Lists area"* (or the questions wording for a poll or survey).
Authoring on the opportunity form only works while the opportunity has no Task List yet — the first save creates one and links it.
Combined with C2, an author who reopens an opportunity, retypes what appears to be missing, and saves, is told their work cannot be saved there.

**Workaround**: As C2 — make changes in the Task Lists area.

An earlier draft of this entry said the save created a **duplicate** Task List and orphaned the original.
That was true of an older build and is not true today: the duplicate-and-orphan path was closed when native polls and surveys shipped, and the refusal above replaced it.

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

#### 3. Calendar Event Cancellation
**Status**: Known Limitation  
**Impact**: Low  
**Description**: When you cancel a booking, the event is removed from the **researcher's** calendar only (if calendar is configured). If you added the session to **your own** calendar (e.g. via the link in the confirmation email or an .ics attachment), you need to remove it yourself—the app does not delete events from participants' personal calendars.

**Workaround**: 
- After cancelling, if you had added the session to your own calendar, remove it manually from your calendar app
- Or keep the event as a reminder of the cancellation

**Planned Fix**: Participant calendar event deletion would require creating events on the participant's calendar at book time (via their OAuth) and storing that event ID; planned as a future enhancement

---

### Low Priority Issues

#### 4. Browser Compatibility
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

#### 5. Accessibility Compliance
**Status**: WCAG 2.2 AA targeted; axe-core tests on key routes  
**Impact**: Low (for alpha)  
**Description**: M8 fixes applied: CTA/primary button contrast (orange-700/800), power button contrast, Settings tab active color, heading order (Available Sessions h2; calendar day titles as divs), page h1 (Feedback, form loading). Run: `npx playwright test e2e/accessibility.test.ts --config=playwright.accessibility.config.ts` (start frontend first). Use `load` not `networkidle` when testing production.

**Known Issues**:
- Screen reader optimization is basic

**Workaround**: 
- Use keyboard navigation (Tab, Enter, Escape)
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

