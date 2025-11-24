# Testing Calendar Integration Guide

This guide will help you test the user calendar integration functionality in demo mode.

## Prerequisites

1. **Database Setup**: Make sure your database is running and `DATABASE_URL` is set
2. **Backend Dependencies**: Ensure backend packages are installed
3. **Frontend Dependencies**: Ensure frontend packages are installed

## Step 1: Run Database Migration

First, run the migration to create the `user_calendar_tokens` table:

```bash
cd backend
npm run migrate
```

You should see:
```
✅ Database migrations completed successfully
```

**Verify**: Check that the table was created:
```sql
-- Connect to your database and run:
SELECT table_name FROM information_schema.tables 
WHERE table_name = 'user_calendar_tokens';
```

## Step 2: Start Development Servers

### Option A: Using the startup script
```bash
./start-dev.sh npm
```

### Option B: Manual start
```bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend  
cd frontend
npm start
```

**Verify**: 
- Backend should be running on `http://localhost:3001`
- Frontend should be running on `http://localhost:3000`

## Step 3: Test Calendar Connection Flow

### 3.1 Log in as a User

1. Navigate to `http://localhost:3000`
2. Log in with any user account (demo login or OIDC)
3. Navigate to an opportunity detail page

### 3.2 Check Calendar Connection Component

You should see a "Calendar Integration" card with:
- **If not connected**: "Connect Google Calendar" button
- **If connected**: "Calendar connected" message with disconnect button

### 3.3 Test Connection (Demo Mode)

1. Click "Connect Google Calendar"
2. In demo mode, you'll be redirected to the callback URL automatically
3. You should be redirected back to the opportunities page
4. The component should now show "Calendar connected"

**Expected Console Output** (backend):
```
📅 User Calendar service initialized in DEMO mode
📅 Demo mode: Returning mock tokens
```

### 3.4 Verify Token Storage

Check the database to verify tokens were stored:

```sql
SELECT 
  u.email,
  uct.connected_at,
  uct.expires_at
FROM user_calendar_tokens uct
JOIN users u ON uct.user_id = u.id;
```

You should see your user's connection with timestamps.

## Step 4: Test Calendar Events Fetching

### 4.1 Check API Endpoint Directly

Test the calendar events endpoint:

```bash
# First, get your session cookie by logging in through the browser
# Then use it in curl (replace COOKIE_VALUE with your actual cookie):

curl -X GET "http://localhost:3001/api/calendar/my-events?start_time=2024-01-01T00:00:00Z&end_time=2024-12-31T23:59:59Z" \
  -H "Cookie: adaptalabs_session=YOUR_SESSION_COOKIE" \
  -b "cookies.txt"
```

**Expected Response**: Array of mock calendar events (2-4 events per weekday)

```json
[
  {
    "id": "demo-event-0",
    "title": "Team Standup",
    "start": "2024-01-01T10:30:00.000Z",
    "end": "2024-01-01T11:00:00.000Z",
    "status": "confirmed",
    "location": "Meeting Room A",
    "attendees": []
  },
  ...
]
```

### 4.2 Test Through UI

1. Navigate to an opportunity detail page
2. If calendar is connected, the CalendarGrid will automatically fetch events
3. Check browser console - you should see:
   ```
   CalendarGrid: Fetching user calendar events...
   ```

## Step 5: Test Conflict Detection

### 5.1 Create Test Opportunity and Sessions

As an admin, create an opportunity with sessions that overlap with mock calendar events:

1. Create a session at a time that would conflict (e.g., 10:30 AM on a weekday)
2. Mock events are generated at random times between 9 AM - 5 PM on weekdays

### 5.2 View as Regular User

1. Log in as a regular user (not admin)
2. Navigate to the opportunity detail page
3. If you're connected to calendar, the CalendarGrid should show:
   - **Green slots**: Available, no conflicts
   - **Yellow slots**: Available but conflicts with calendar ⚠️
   - **Red slots**: Full/unavailable
   - **Grey slots**: Already booked

### 5.3 Verify Conflict Detection

Hover over a yellow slot - tooltip should say:
```
⚠️ You have a calendar conflict at this time
```

The slot should also show a warning icon (⚠️) next to the time.

## Step 6: Test API Endpoints

### 6.1 Connection Status

```bash
curl -X GET "http://localhost:3001/api/calendar/connection-status" \
  -H "Cookie: adaptalabs_session=YOUR_SESSION_COOKIE"
```

**Expected**: `{"connected": true, "connectedAt": "2024-..."}`

### 6.2 Disconnect Calendar

```bash
curl -X DELETE "http://localhost:3001/api/calendar/disconnect" \
  -H "Cookie: adaptalabs_session=YOUR_SESSION_COOKIE"
```

**Expected**: `{"success": true}`

After disconnecting, the connection status should return `{"connected": false}`.

## Step 7: Browser Console Testing

### 7.1 Check for Errors

Open browser DevTools (F12) and check:
- **Console**: Should see calendar service initialization messages
- **Network**: Should see API calls to `/api/calendar/my-events`
- **No errors**: Red errors should not appear

### 7.2 Verify Demo Mode

In backend console, you should see:
```
📅 User Calendar service initialized in DEMO mode
```

## Step 8: Visual Testing Checklist

### CalendarConnection Component
- [ ] Shows "Connect Google Calendar" button when not connected
- [ ] Shows "Calendar connected" status when connected
- [ ] Shows connection date when connected
- [ ] "Disconnect" button works
- [ ] Loading spinner shows during connection

### CalendarGrid Component
- [ ] Fetches calendar events when sessions load
- [ ] Shows green for available slots (no conflicts)
- [ ] Shows yellow for available slots WITH conflicts
- [ ] Shows warning icon (⚠️) on conflicting slots
- [ ] Tooltip shows conflict message on hover
- [ ] Can still book slots despite conflicts

## Troubleshooting

### Issue: "Calendar not connected" even after connecting

**Solution**: 
1. Check browser cookies are enabled
2. Verify session is valid
3. Check backend logs for errors
4. Try disconnecting and reconnecting

### Issue: No conflicts showing

**Possible causes**:
1. No calendar connection - check connection status
2. No sessions overlap with mock events - create sessions at 10 AM - 5 PM on weekdays
3. Browser cache - hard refresh (Ctrl+Shift+R)

**Debug**: Check browser console for:
```javascript
// Should see calendar events fetched
console.log('User calendar events:', userCalendarEvents);
```

### Issue: Migration fails

**Solution**:
1. Check database connection string is correct
2. Verify database user has CREATE TABLE permissions
3. Check if table already exists (migration is idempotent, safe to re-run)

### Issue: Backend won't start

**Solution**:
1. Check `DATABASE_URL` is set in `.env`
2. Verify port 3001 is available
3. Check backend logs for specific errors

## Expected Behavior in Demo Mode

### What Works:
- ✅ Calendar connection stores mock tokens
- ✅ Mock events are generated (2-4 per weekday)
- ✅ Conflict detection algorithm works
- ✅ Visual indicators show conflicts
- ✅ All UI components functional

### What Doesn't Work (Expected):
- ❌ Real Google OAuth redirect (uses demo callback)
- ❌ Real calendar data (uses mock events)
- ❌ Token refresh with Google (uses mock refresh)

### When You Get API Keys:

Simply add to your `.env`:
```bash
GOOGLE_OAUTH_CLIENT_ID=your_client_id
GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3001/api/calendar/auth/callback
ENCRYPTION_KEY=your_32_character_encryption_key
```

The system will automatically switch to production mode - no code changes needed!

## Quick Test Commands

```bash
# Run migrations
cd backend && npm run migrate

# Start backend
cd backend && npm run dev

# Start frontend (in new terminal)
cd frontend && npm start

# Test API endpoint (after logging in)
curl -X GET "http://localhost:3001/api/calendar/connection-status" \
  --cookie-jar cookies.txt \
  --cookie cookies.txt
```

## Success Criteria

✅ All tests pass if:
1. Can connect calendar (stores mock tokens)
2. Connection status shows connected
3. Calendar events are fetched (mock events)
4. Conflicts are detected and displayed
5. Visual indicators work correctly
6. Can disconnect calendar
7. No console errors

## Next Steps After Testing

Once testing is complete:
1. Review any issues found
2. Test with different date ranges
3. Test with multiple users
4. Test disconnect/reconnect flow
5. Verify database cleanup on disconnect


















