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

#### 1. Email Reminders Not Fully Automated
**Status**: Partial Implementation  
**Impact**: Medium  
**Description**: Email reminder functionality is implemented but may not be fully automated. Reminders may need to be sent manually or may not be sent at all.

**Workaround**: 
- Check your calendar for session times
- Set your own calendar reminders
- Contact the researcher if you need a reminder

**Planned Fix**: Full automation in future release

---

#### 2. Mobile Responsiveness
**Status**: Limited Testing  
**Impact**: Low-Medium  
**Description**: The application is responsive but has been primarily tested on desktop browsers. Some features may not be optimized for mobile devices.

**Workaround**: 
- Use desktop browser for best experience
- Mobile features are functional but may have layout issues
- Report any mobile-specific issues via feedback form

**Planned Fix**: Enhanced mobile testing and optimization

---

#### 3. Calendar Event Cancellation
**Status**: Known Limitation  
**Impact**: Low  
**Description**: When you cancel a booking, the calendar event may not be automatically deleted from your Google Calendar. You may need to manually delete it.

**Workaround**: 
- Manually delete the calendar event after cancelling
- Or keep the event as a reminder of the cancellation

**Planned Fix**: Automatic calendar event deletion in future release

---

### Low Priority Issues

#### 4. Browser Compatibility
**Status**: Limited Testing  
**Impact**: Low  
**Description**: Application has been tested primarily on:
- ✅ Chrome (latest)
- ✅ Firefox (latest)
- ✅ Safari (latest)
- ⚠️ Edge (limited testing)
- ❓ Other browsers (untested)

**Workaround**: Use Chrome, Firefox, or Safari for best experience

---

#### 5. Accessibility Compliance
**Status**: Partial  
**Impact**: Low (for alpha)  
**Description**: Basic accessibility features are implemented, but full WCAG 2.2 AA compliance audit is pending.

**Known Issues**:
- Some color contrast ratios may not meet AA standards
- Skip navigation links may need improvement
- Screen reader optimization is basic

**Workaround**: 
- Use keyboard navigation (Tab, Enter, Escape)
- Report accessibility issues via feedback form

**Planned Fix**: Full accessibility audit and fixes in M8

---

## 📋 Feature Limitations

### 1. Email Functionality

**Current State**:
- ✅ Booking confirmation emails are sent
- ✅ Cancellation emails are sent
- ⚠️ Reminder emails may not be fully automated
- ⚠️ Email templates are basic

**Limitations**:
- Email deliverability depends on email service configuration
- Some email clients may filter emails to spam
- Email formatting is basic (no rich HTML templates)

**Workaround**: Check spam folder if emails don't arrive

---

### 2. Calendar Integration

**Current State**:
- ✅ Google Calendar events are created on booking
- ⚠️ Calendar events may not be deleted on cancellation
- ⚠️ Reschedule may not update calendar event automatically

**Limitations**:
- Only Google Calendar is supported
- Calendar events are created on researcher's calendar
- Participants receive calendar invite via email

**Workaround**: 
- Manually manage calendar events if needed
- Use email calendar links (.ics files)

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
3. **Email**: adaptalabs-support@adaptavist.com

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
- [ ] Full email reminder automation
- [ ] Calendar event deletion on cancellation
- [ ] Enhanced mobile responsiveness
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
**For Questions**: Use feedback form or contact adaptalabs-support@adaptavist.com

