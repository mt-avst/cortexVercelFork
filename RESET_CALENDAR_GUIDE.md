# Reset Calendar Bookings Guide

## Problem
After resetting calendar bookings, the calendar may still show slots as unavailable/full because:
1. The frontend may be caching old data
2. The Vercel API was using incorrect booking status filtering
3. The `booked_count` on sessions may not match actual bookings

## Solution

### For Local Development
Run the reset script from the `backend` directory:
```bash
cd backend
npm run reset-calendar
```

This will:
- Clear all `gcal_event_id` values from bookings
- Recalculate `booked_count` for all sessions based on actual active bookings
- Provide verification statistics

### For Production (Vercel)
The Vercel API endpoint has been fixed to calculate `booked_count` dynamically based on active bookings only (`status = 'booked'`). 

**However**, if you need to reset the stored `booked_count` values in the production database, you'll need to:

1. **Option A: Run the reset script against production database**
   - Update your local `.env` to point to the production database
   - Run `npm run reset-calendar` from the backend directory
   - **⚠️ WARNING: Make sure you're connected to the correct database!**

2. **Option B: Wait for new bookings/cancellations**
   - The stored `booked_count` will be updated automatically when bookings are created/cancelled
   - The API now calculates dynamically, so the frontend will see correct availability

### After Resetting
1. **Hard refresh the browser** (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows/Linux) to clear cached data
2. **Check the browser console** for session data to verify `remaining` counts are correct
3. The calendar should now show correct availability based on actual bookings

## What the Reset Does
- ✅ Clears Google Calendar event IDs (`gcal_event_id`)
- ✅ Recalculates `booked_count` to match actual active bookings
- ✅ Does NOT delete or cancel bookings
- ✅ Does NOT affect session capacity

## What Changed in the Fix
The Vercel API endpoint (`api/opportunities/[id].ts`) now:
- Uses `b.status = 'booked'` filter instead of `b.status != 'cancelled'`
- Calculates `booked_count` dynamically from actual bookings
- Ensures `remaining` count is accurate

## Verification
After resetting, check:
1. Browser console logs showing session data with correct `remaining` values
2. Calendar grid showing green (available) slots for sessions with `remaining > 0`
3. Red (full) slots only for sessions where `booked_count = capacity`


