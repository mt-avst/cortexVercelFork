# Known Issues and Limitations

**Version**: 3.12.0  
**Last Updated**: 2025-01-27  
**Status**: Alpha Testing Phase

---

## 🎯 Purpose

This document lists known issues, limitations, and workarounds for AdaptaLabs. This information helps set expectations for alpha testers and guides development priorities.

---

## ⚠️ Known Issues

### Critical Issues

_None currently known. All critical bugs have been resolved._

### Medium Priority Issues

#### 1. Email Reminders
**Status**: Automated (Vercel Cron)  
**Impact**: Low  
**Description**: Session reminder emails are sent automatically for bookings whose session starts in ~24 hours. A daily cron job (GET /api/cron/send-reminders) runs at 9:00 AM UTC. Requires CRON_SECRET in Vercel env and migrations run (adds reminder_sent_at to bookings).

**Workaround**: If reminders are not received, check CRON_SECRET is set, run GET /api/run-migrations, and ensure SMTP/email is configured. Participants can set their own calendar reminders.

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
**Status**: Tested with axe-core  
**Impact**: Low (for alpha)  
**Description**: Automated accessibility tests (axe-core) run on key routes: Home, Opportunity detail, Admin dashboard, Create opportunity form, Header/skip link, My Bookings, Feedback, Settings. Light-mode form contrast was fixed (WCAG AA). Skip link and keyboard navigation are tested.

**Known Issues**:
- Screen reader optimization is basic
- Run full audit locally: start dev server, then `npx playwright test e2e/accessibility.test.ts --config=playwright.accessibility.config.ts`

**Workaround**: 
- Use keyboard navigation (Tab, Enter, Escape)
- Report accessibility issues via feedback form

---

## 📋 Feature Limitations

### 1. Email Functionality

**Current State**:
- ✅ Booking confirmation emails are sent
- ✅ Cancellation emails are sent
- ✅ Reminder emails are sent automatically (Vercel Cron, daily; ~24h before session)
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
- [x] Full email reminder automation (Vercel Cron + reminder_sent_at)
- [x] Calendar event cancellation docs and UI note
- [x] Mobile viewport E2E (Mobile Chrome/Safari in Playwright)
- [x] Edge and accessibility coverage
- [ ] Improved error messages

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

**Last Updated**: 2025-01-27  
**For Questions**: Use feedback form or contact nfine@adaptavist.com

