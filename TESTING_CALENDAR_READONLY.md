# Testing Guide: Calendar Readonly + Email Links

This guide helps you test the changes made to switch from full calendar write access to readonly access with email-based calendar event management.

## Prerequisites

1. **Environment Setup**
   - Backend running on `http://localhost:3001`
   - Frontend running on `http://localhost:3000`
   - Database connected
   - Google OAuth credentials configured

2. **Google Cloud Console**
   - OAuth consent screen set to "External" and "Testing" (or "Production")
   - OAuth client ID and secret configured
   - Redirect URI: `http://localhost:3001/api/auth/google-callback` (for local) or your Vercel URL

## Test Plan

### Test 1: Verify OAuth Scope Changed to Readonly

**Goal**: Confirm that the OAuth flow requests `calendar.readonly` instead of `calendar`

**Steps**:
1. Open browser DevTools (F12) → Network tab
2. Navigate to `http://localhost:3000` (or your deployed URL)
3. Click "Sign in with Google"
4. Before completing login, check the OAuth URL in the Network tab
5. Look for the `scope` parameter in the authorization URL

**Expected Result**:
```
scope=https://www.googleapis.com/auth/calendar.readonly%20openid%20profile%20email
```

**Note**: The scope should include `calendar.readonly`, NOT `calendar`

### Test 2: Verify Login Works with Readonly Scope

**Goal**: Ensure users can still log in successfully with readonly scope

**Steps**:
1. Complete the Google login flow
2. Verify you're redirected to the app
3. Check that you're authenticated (you should see your profile)

**Expected Result**:
- Login completes successfully
- User is authenticated
- No OAuth errors in console

### Test 3: Test Calendar Link Generation in Booking Email

**Goal**: Verify that booking confirmation emails include calendar links

**Steps**:
1. Log in as a regular user (not admin)
2. Find an available session/opportunity
3. Book the session
4. Check the backend console logs (where emails are logged)

**Expected Result in Console**:
```
📧 EMAIL NOTIFICATION
From: Adaptalabs Impact Lab <noreply@adaptalabs.com>
To: Your Name <your-email@example.com>
Subject: Booking confirmed: [Opportunity Title]

Text:
Booking Confirmed

Hello [Your Name],

Your booking has been confirmed for the following research session:

[Opportunity Title]
Date & Time: [Date] - [Time]
Duration: [X] minutes

Add to your calendar:
Google Calendar: https://calendar.google.com/calendar/render?action=TEMPLATE&text=...
```

**Verify the Google Calendar link**:
1. Copy the Google Calendar URL from the email text
2. Paste it in a browser (or decode it)
3. Verify it contains:
   - `action=TEMPLATE`
   - `text=` (the opportunity title)
   - `dates=` (formatted dates)
   - `details=` (description)
   - `location=` (if provided)

### Test 4: Test ICS File Generation

**Goal**: Verify that ICS calendar files are generated correctly

**Steps**:
1. After booking, check the email HTML content in console logs
2. Look for the `.ics` file data URI

**Expected Result**:
- Email HTML includes: `<a href="data:text/calendar;charset=utf-8,...">Download Calendar File</a>`
- The data URI contains valid ICS format

**Manual Test**:
1. You can test the ICS generation function directly:

```typescript
// In backend/src/services/email.ts, temporarily add:
const testICS = EmailService.generateICSFile(
  'Test Event',
  new Date('2024-01-15T10:00:00Z'),
  new Date('2024-01-15T11:00:00Z'),
  'Test description',
  'Test location',
  'test@example.com',
  'Test Organizer'
);
console.log(testICS);
```

Expected ICS format:
```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//AdaptaLabs//Research Platform//EN
BEGIN:VEVENT
UID:...
DTSTAMP:...
DTSTART:...
DTEND:...
SUMMARY:Test Event
DESCRIPTION:Test description
LOCATION:Test location
ORGANIZER;CN=Test Organizer:MAILTO:test@example.com
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR
```

### Test 5: Verify Calendar Links Work

**Goal**: Ensure users can actually add events to their calendars

**Steps**:
1. Book a session (or use the email from Test 3)
2. Copy the Google Calendar link from the email
3. Open it in a browser
4. Verify Google Calendar opens with pre-filled event details

**Expected Result**:
- Google Calendar opens with the event details
- Title, date, time, description, and location are pre-filled
- You can click "Save" to add it to your calendar

**Test ICS File**:
1. Create a test HTML file:
```html
<!DOCTYPE html>
<html>
<body>
  <a href="data:text/calendar;charset=utf-8,BEGIN:VCALENDAR%0AVERSION:2.0%0APRODID:-//AdaptaLabs//Research%20Platform//EN%0ABEGIN:VEVENT%0AUID:12345@adaptalabs.com%0ADTSTAMP:20240115T100000Z%0ADTSTART:20240115T100000Z%0ADTEND:20240115T110000Z%0ASUMMARY:Test%20Event%0ADESCRIPTION:Test%20description%0ALOCATION:Test%20location%0ASTATUS:CONFIRMED%0AEND:VEVENT%0AEND:VCALENDAR">Download Test Calendar File</a>
</body>
</html>
```
2. Open it in a browser
3. Click the link
4. Verify your calendar app opens with the event (or downloads the .ics file)

### Test 6: Verify Conflict Checking Still Works

**Goal**: Ensure readonly calendar access still allows conflict checking

**Steps**:
1. Log in as a user
2. Connect your Google Calendar (if not already connected)
3. Create a test event in your Google Calendar for a future time
4. Try to book a session at the same time
5. Verify the system detects the conflict

**Expected Result**:
- System shows a conflict warning
- You can still book (or system prevents booking based on your logic)
- No errors related to readonly access

### Test 7: Test Reschedule Flow

**Goal**: Verify rescheduling doesn't try to update user calendars programmatically

**Steps**:
1. Book a session
2. Reschedule it to a different time
3. Check backend logs for any errors about calendar updates
4. Verify the confirmation email includes updated calendar links

**Expected Result**:
- No errors about "updateUserCalendarEvent" or "deleteUserCalendarEvent"
- Email includes updated calendar links with new date/time
- Comment in code: "User calendar events are managed via email links"

### Test 8: Test Cancellation Flow

**Goal**: Verify cancellation doesn't try to delete user calendar events

**Steps**:
1. Book a session
2. Cancel the booking
3. Check backend logs for any errors about calendar deletion

**Expected Result**:
- No errors about "deleteUserCalendarEvent"
- Cancellation email sent successfully
- Comment in code: "Users need to manually delete events from their calendars"

### Test 9: Verify Admin Calendar Still Works

**Goal**: Ensure admin calendar events are still created programmatically (via service account)

**Steps**:
1. As an admin, create a session
2. As a regular user, book the session
3. Check admin's calendar (where service account has access)
4. Verify event appears in admin calendar

**Expected Result**:
- Event appears in admin's calendar
- Admin calendar uses service account (not user OAuth)
- This functionality is unchanged

## Automated Testing Script

You can create a simple test script to verify calendar link generation:

```bash
# test-calendar-links.sh
cd backend
node -e "
const { EmailService } = require('./dist/services/email');

const startTime = new Date('2024-12-15T10:00:00Z');
const endTime = new Date('2024-12-15T11:00:00Z');

// Test Google Calendar link
const googleLink = EmailService.generateGoogleCalendarLink(
  'Test Research Session',
  startTime,
  endTime,
  'Test description',
  'Test location'
);
console.log('Google Calendar Link:', googleLink);

// Test ICS file
const ics = EmailService.generateICSFile(
  'Test Research Session',
  startTime,
  endTime,
  'Test description',
  'Test location',
  'researcher@example.com',
  'Researcher Name'
);
console.log('\\nICS File:\\n', ics);
"
```

## Checklist

- [ ] OAuth scope is `calendar.readonly` (not `calendar`)
- [ ] Login works with readonly scope
- [ ] Booking emails include Google Calendar link
- [ ] Booking emails include ICS file download link
- [ ] Google Calendar link opens correctly with pre-filled data
- [ ] ICS file can be downloaded and imported
- [ ] Conflict checking still works
- [ ] Reschedule sends updated calendar links
- [ ] Cancellation doesn't try to delete user calendar events
- [ ] Admin calendar events still work (service account)
- [ ] No console errors related to calendar permissions

## Troubleshooting

### Issue: OAuth still requests `calendar` scope
**Solution**: Check that all files were updated:
- `api/auth/google-login.ts`
- `backend/src/routes/auth.ts`
- `backend/src/services/userCalendar.ts`

### Issue: Calendar links don't work
**Solution**: 
- Verify URL encoding is correct
- Check date formatting matches Google Calendar format (YYYYMMDDTHHmmssZ)
- Test the link manually in a browser

### Issue: ICS file doesn't import
**Solution**:
- Verify ICS format is valid (check line endings: `\r\n`)
- Ensure special characters are escaped correctly
- Test with a simple calendar app first

### Issue: Conflict checking doesn't work
**Solution**:
- Verify user has connected their calendar
- Check that readonly scope allows reading calendar events
- Review error logs for API permission issues

## Next Steps After Testing

1. **Deploy to Vercel** (if testing locally)
2. **Update Google Cloud Console**:
   - Remove `calendar` scope from OAuth consent screen if it was there
   - Ensure `calendar.readonly` scope is listed
   - Move to "Production" if ready (readonly scope doesn't require verification)
3. **Monitor logs** for any calendar-related errors
4. **Update user documentation** about manually adding calendar events

