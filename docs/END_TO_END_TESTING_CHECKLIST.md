# End-to-End Testing Checklist

**Version**: 7.55.13  
**Date**: 2026-08-24  
**Purpose**: Verify all critical user flows work correctly before alpha testing

---

## 🎯 Testing Goals

Verify that all critical user journeys work end-to-end without blocking issues.

---

## ✅ Pre-Testing Setup

- [ ] Clear browser cache
- [ ] Use incognito/private window (or clear cookies)
- [ ] Have test accounts ready:
  - [ ] Admin account
  - [ ] Regular user account
  - [ ] Demo login credentials
- [ ] Have test email addresses ready
- [ ] Google Calendar account accessible

---

## 🔴 Critical User Flows

### 1. New User Journey (Browse → Book)

**Steps**:
1. [ ] Navigate to home page
2. [ ] Verify opportunities list loads
3. [ ] Browse opportunities (no login required)
4. [ ] Click on an opportunity
5. [ ] View opportunity details
6. [ ] Click "Sign in to book" or similar
7. [ ] Sign in (SSO or demo)
8. [ ] Return to opportunity
9. [ ] Select available session
10. [ ] Click "Book"
11. [ ] Verify booking confirmation
12. [ ] Check "My Bookings" page
13. [ ] Verify booking appears
14. [ ] Check email for confirmation
15. [ ] Check Google Calendar for event

**Expected Results**:
- ✅ Opportunities visible without login
- ✅ Can view details without login
- ✅ Login required to book
- ✅ Booking succeeds
- ✅ Confirmation message shown
- ✅ Booking appears in "My Bookings"
- ✅ Email received
- ✅ Calendar event created

**Issues Found**: _________________________

---

### 2. Booking Flow (Authenticated User)

**Steps**:
1. [ ] Sign in as regular user
2. [ ] Navigate to home page
3. [ ] Find opportunity with available sessions
4. [ ] Click on opportunity
5. [ ] View session list
6. [ ] Check for calendar conflicts (if logged in)
7. [ ] Select session with available slots
8. [ ] Click "Book" button
9. [ ] Verify success message
10. [ ] Check session shows one less available slot
11. [ ] Go to "My Bookings"
12. [ ] Verify booking appears in "Upcoming"
13. [ ] Check email inbox for confirmation
14. [ ] Check Google Calendar

**Expected Results**:
- ✅ Can book successfully
- ✅ Slot count decreases
- ✅ Booking appears in "My Bookings"
- ✅ Email confirmation received
- ✅ Calendar event created

**Issues Found**: _________________________

---

### 3. Cancel Booking Flow

**Steps**:
1. [ ] Sign in as user with existing booking
2. [ ] Go to "My Bookings"
3. [ ] Find booking in "Upcoming" tab
4. [ ] Click "Cancel" button
5. [ ] Confirm cancellation
6. [ ] Verify success message
7. [ ] Verify booking removed from "Upcoming"
8. [ ] Check "Past" tab (booking should appear)
9. [ ] Check email for cancellation confirmation
10. [ ] Go back to opportunity
11. [ ] Verify slot is available again

**Expected Results**:
- ✅ Can cancel booking
- ✅ Booking moves to "Past" tab
- ✅ Slot becomes available
- ✅ Email confirmation received
- ⚠️ Calendar event may need manual deletion

**Issues Found**: _________________________

---

### 4. Reschedule Booking Flow

**Steps**:
1. [ ] Sign in as user with existing booking
2. [ ] Go to "My Bookings"
3. [ ] Find booking in "Upcoming"
4. [ ] Click "Reschedule" button
5. [ ] View available alternative sessions
6. [ ] Select new session time
7. [ ] Confirm reschedule
8. [ ] Verify success message
9. [ ] Check "My Bookings" - old booking cancelled, new booking created
10. [ ] Verify original slot is available
11. [ ] Verify new slot shows as booked
12. [ ] Check emails (cancellation + new booking)

**Expected Results**:
- ✅ Can reschedule successfully
- ✅ Old booking cancelled
- ✅ New booking created
- ✅ Slots update correctly
- ✅ Emails sent for both actions

**Issues Found**: _________________________

---

### 5. Poll/Survey Click Tracking

**Steps**:
1. [ ] Find a Poll or Survey opportunity
2. [ ] Click on opportunity
3. [ ] Click "Open Poll" or "Open Survey" button
4. [ ] Verify redirect to external link
5. [ ] Sign in as admin
6. [ ] Go to Create & Manage
7. [ ] Find the poll/survey opportunity
8. [ ] Check "Clicks" column - should show 1
9. [ ] Click "Analytics" button
10. [ ] Verify analytics show the click
11. [ ] Check 24-hour clicks count
12. [ ] Check 30-day trend (if applicable)

**Expected Results**:
- ✅ External link opens correctly
- ✅ Click is tracked
- ✅ Analytics show click count
- ✅ Dashboard shows updated count

**Issues Found**: _________________________

---

## 🔵 Admin Flows

### 6. Create Opportunity Flow

**Steps**:
1. [ ] Sign in as admin
2. [ ] Go to Create & Manage
3. [ ] Click "Create New Opportunity"
4. [ ] Fill in basic information:
   - [ ] Select type (Test, Poll, Survey, etc.)
   - [ ] Enter title
   - [ ] Enter purpose one-liner
   - [ ] Enter description (optional)
   - [ ] Set default duration
5. [ ] If Poll/Survey: Add external link
6. [ ] Add at least one session:
   - [ ] Set start time
   - [ ] Set capacity
   - [ ] Add location/link (optional)
7. [ ] Click "Save as Draft"
8. [ ] Verify opportunity saved as draft
9. [ ] Edit opportunity
10. [ ] Click "Publish"
11. [ ] Verify opportunity appears in public list
12. [ ] Verify status shows as "Published"

**Expected Results**:
- ✅ Can create opportunity
- ✅ Can save as draft
- ✅ Can publish
- ✅ Published opportunities visible to users
- ✅ Drafts only visible to admins

**Issues Found**: _________________________

---

### 7. Edit Opportunity Flow

**Steps**:
1. [ ] Sign in as admin
2. [ ] Go to Create & Manage
3. [ ] Find existing opportunity
4. [ ] Click "Edit"
5. [ ] Modify title or description
6. [ ] Add new session
7. [ ] Edit existing session
8. [ ] Save changes
9. [ ] Verify changes are reflected
10. [ ] Check public view shows updates

**Expected Results**:
- ✅ Can edit opportunity details
- ✅ Can add sessions
- ✅ Can edit sessions
- ✅ Changes save correctly
- ✅ Public view updates

**Issues Found**: _________________________

---

### 8. Duplicate Opportunity Flow

**Steps**:
1. [ ] Sign in as admin
2. [ ] Go to Create & Manage
3. [ ] Find opportunity to duplicate
4. [ ] Click "Duplicate" button
5. [ ] Verify new opportunity created
6. [ ] Check status is "Draft"
7. [ ] Verify sessions are copied
8. [ ] Edit duplicated opportunity
9. [ ] Publish if needed

**Expected Results**:
- ✅ Duplicate created successfully
- ✅ All details copied
- ✅ Sessions copied
- ✅ Status set to Draft
- ✅ Can edit and publish

**Issues Found**: _________________________

---

### 9. Create & Manage and Analytics

**Steps**:
1. [ ] Sign in as admin
2. [ ] Go to Create & Manage
3. [ ] Verify statistics cards show:
   - [ ] Total opportunities
   - [ ] Total bookings
   - [ ] Participants count
   - [ ] Available slots
4. [ ] Check opportunities table:
   - [ ] All opportunities listed
   - [ ] Statistics columns populated
   - [ ] Clicks column shows for polls/surveys
5. [ ] Test filtering:
   - [ ] Filter by type
   - [ ] Filter by status
   - [ ] Search by text
6. [ ] Click "Analytics" on poll/survey
7. [ ] Verify analytics page loads
8. [ ] Check click data displays

**Expected Results**:
- ✅ Create & Manage loads correctly
- ✅ Statistics are accurate
- ✅ Filtering works
- ✅ Analytics display correctly

**Issues Found**: _________________________

---

### 10. Settings and Notifications

**Steps**:
1. [ ] Sign in as admin
2. [ ] Click profile dropdown
3. [ ] Click "Settings"
4. [ ] View notification preferences
5. [ ] Toggle "On Book Email" off
6. [ ] Toggle "On Cancel Email" off
7. [ ] Verify settings save
8. [ ] Have someone book a session
9. [ ] Verify no email received (if toggled off)
10. [ ] Toggle back on
11. [ ] Verify settings save

**Expected Results**:
- ✅ Settings page accessible
- ✅ Can toggle preferences
- ✅ Settings save correctly
- ✅ Notifications respect preferences

**Issues Found**: _________________________

---

## 🟡 Edge Cases

### 11. Full Session Booking

**Steps**:
1. [ ] Find opportunity with 1 remaining slot
2. [ ] Book the slot
3. [ ] Verify session shows as "Full"
4. [ ] Try to book again (should fail)
5. [ ] Verify error message
6. [ ] Check that session is closed for new bookings

**Expected Results**:
- ✅ Can't book full session
- ✅ Clear error message
- ✅ Session shows as "Full"

**Issues Found**: _________________________

---

### 12. Past Session Booking

**Steps**:
1. [ ] Find opportunity with past sessions
2. [ ] Try to book past session
3. [ ] Verify error or disabled state
4. [ ] Verify can't book past sessions

**Expected Results**:
- ✅ Can't book past sessions
- ✅ Clear indication why

**Issues Found**: _________________________

---

### 13. Multiple Bookings Same User

**Steps**:
1. [ ] Sign in as user
2. [ ] Book a session
3. [ ] Try to book same session again
4. [ ] Verify error (already booked)
5. [ ] Book different session for same opportunity
6. [ ] Verify both bookings appear

**Expected Results**:
- ✅ Can't double-book same session
- ✅ Can book multiple different sessions
- ✅ Clear error for duplicate booking

**Issues Found**: _________________________

---

### 14. Calendar Conflict Detection

**Steps**:
1. [ ] Sign in as user
2. [ ] Create calendar event for specific time
3. [ ] Find opportunity with session at same time
4. [ ] View opportunity details
5. [ ] Check for conflict warning/badge
6. [ ] Verify conflict is detected
7. [ ] Can still book (with warning)

**Expected Results**:
- ✅ Conflicts detected
- ✅ Visual indicator shown
- ✅ Can still book (user choice)

**Issues Found**: _________________________

---

## 📧 Email Testing

### 15. Email Deliverability

**Steps**:
1. [ ] Book a session with real email
2. [ ] Check inbox for confirmation email
3. [ ] Check spam folder if not in inbox
4. [ ] Verify email content is correct
5. [ ] Check email links work
6. [ ] Cancel booking
7. [ ] Check for cancellation email
8. [ ] Verify cancellation email content

**Expected Results**:
- ✅ Confirmation email received
- ✅ Email content is correct
- ✅ Links work
- ✅ Cancellation email received

**Issues Found**: _________________________

---

## 🐛 Error Handling

### 16. Error Scenarios

**Test Cases**:
1. [ ] Network error (disconnect internet, try to book)
2. [ ] Invalid session ID (try to book non-existent session)
3. [ ] Unauthorized access (try to access admin without login)
4. [ ] Validation errors (try to create opportunity with missing fields)
5. [ ] Server error (if possible to simulate)

**Expected Results**:
- ✅ User-friendly error messages
- ✅ No technical details exposed
- ✅ Clear action items
- ✅ Graceful degradation

**Issues Found**: _________________________

---

## 📱 Mobile Testing (Optional)

### 17. Mobile Responsiveness

**Steps**:
1. [ ] Open on mobile device or resize browser
2. [ ] Test navigation
3. [ ] Test booking flow
4. [ ] Test Create & Manage
5. [ ] Check form inputs
6. [ ] Verify buttons are clickable
7. [ ] Check text readability

**Expected Results**:
- ✅ Layout adapts to mobile
- ✅ Buttons are accessible
- ✅ Text is readable
- ⚠️ Some features may be less optimal

**Issues Found**: _________________________

---

## ✅ Testing Summary

### Test Results

| Test # | Test Name | Status | Notes |
|--------|-----------|--------|-------|
| 1 | New User Journey | ⬜ | |
| 2 | Booking Flow | ⬜ | |
| 3 | Cancel Booking | ⬜ | |
| 4 | Reschedule Booking | ⬜ | |
| 5 | Poll/Survey Tracking | ⬜ | |
| 6 | Create Opportunity | ⬜ | |
| 7 | Edit Opportunity | ⬜ | |
| 8 | Duplicate Opportunity | ⬜ | |
| 9 | Create & Manage/Analytics | ⬜ | |
| 10 | Settings | ⬜ | |
| 11 | Full Session | ⬜ | |
| 12 | Past Session | ⬜ | |
| 13 | Multiple Bookings | ⬜ | |
| 14 | Calendar Conflicts | ⬜ | |
| 15 | Email Deliverability | ⬜ | |
| 16 | Error Handling | ⬜ | |
| 17 | Mobile (Optional) | ⬜ | |

**Legend**:
- ✅ Pass
- ❌ Fail
- ⚠️ Partial/Issues
- ⬜ Not Tested

---

## 📝 Issues Log

### Critical Issues (Blocking)
_List any issues that prevent core functionality_

1. _________________________________________
2. _________________________________________

### Medium Issues (Non-Blocking)
_List issues that don't prevent use but should be fixed_

1. _________________________________________
2. _________________________________________

### Low Priority Issues
_List minor issues or improvements_

1. _________________________________________
2. _________________________________________

---

## ✅ Sign-Off

**Tester**: _________________________  
**Date**: _________________________  
**Overall Status**: ⬜ Ready for Alpha ⬜ Needs Fixes

**Notes**: _________________________________________

---

**Last Updated**: 2026-08-24

