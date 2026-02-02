# AdaptaLabs Admin Guide

**Version**: 3.12.0  
**Last Updated**: 2025-01-27

---

## Welcome, Researcher Admin!

This guide will help you create and manage research opportunities on AdaptaLabs.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating an Opportunity](#creating-an-opportunity)
3. [Managing Sessions](#managing-sessions)
4. [Publishing Opportunities](#publishing-opportunities)
5. [Dashboard and Analytics](#dashboard-and-analytics)
6. [Settings](#settings)
7. [Managing Bookings](#managing-bookings)
8. [Tips and Best Practices](#tips-and-best-practices)

---

## Getting Started

### Accessing Admin Features

1. Sign in with your admin account
2. Click **"Admin"** in the header (or go to `/admin`)
3. You'll see the admin dashboard

### Admin Dashboard Overview

The dashboard shows:
- **Total Opportunities**: All opportunities you've created
- **Total Bookings**: All bookings across your opportunities
- **Participants**: Unique users who have booked
- **Available Slots**: Remaining slots across all sessions
- **Opportunities Table**: Detailed view with statistics

---

## Creating an Opportunity

### Step 1: Start Creating

1. Go to Admin Dashboard
2. Click **"Create New Opportunity"** button
3. You'll see the opportunity form

### Step 2: Basic Information

Fill in the required fields:

- **Type**: Select from:
  - 🧪 **Test**: User testing sessions
  - 📊 **Poll**: Quick questions/voting
  - 📋 **Survey**: Detailed feedback collection
  - 💬 **Interview**: One-on-one interviews
  - ❓ **Question**: Single question opportunities

- **Title**: Clear, descriptive title (required)
- **Purpose (One-liner)**: Brief description shown on list (required)
- **Description**: Full details (optional but recommended)
- **Product**: Related product or area (optional)
- **Default Duration**: Default session length in minutes (default: 30)

### Step 3: External Links (Polls & Surveys Only)

If creating a Poll or Survey:
- **External Link**: Required
- This is where users will be redirected when they click "Open Poll/Survey"
- Example: Google Forms, SurveyMonkey, Typeform, etc.

### Step 4: Add Sessions

1. Click **"Add Session"** button
2. Fill in session details:
   - **Start Time**: Date and time
   - **End Time**: Automatically calculated based on duration
   - **Capacity**: Number of participants (default: 1)
   - **Location/Meeting Link**: Optional (e.g., Zoom link, room number)

3. Add multiple sessions as needed
4. You can add sessions later by editing the opportunity

### Step 5: Preview and Publish

1. Review all information
2. Click **"Save as Draft"** to save without publishing
3. Click **"Publish"** to make it visible to users

**Note**: Draft opportunities are only visible to admins.

---

## Managing Sessions

### Adding Sessions to Existing Opportunities

1. Go to Admin Dashboard
2. Find the opportunity
3. Click **"Edit"**
4. Scroll to Sessions section
5. Click **"Add Session"**
6. Fill in details and save

### Editing Sessions

1. Edit the opportunity
2. Find the session in the list
3. Click **"Edit"** on the session
4. Modify details
5. Save changes

**Note**: Be careful editing sessions with existing bookings!

### Deleting Sessions

1. Edit the opportunity
2. Find the session
3. Click **"Delete"** on the session
4. Confirm deletion

**Warning**: Deleting a session will cancel all bookings for that session!

### Session Capacity

- Set capacity when creating sessions
- Users can see remaining slots
- Sessions automatically close when full
- You can increase capacity later if needed

---

## Publishing Opportunities

### Draft vs. Published

- **Draft**: Only visible to admins, not shown to users
- **Published**: Visible to all users, appears in browse list

### How to Publish

1. Create or edit an opportunity
2. Fill in all required fields
3. Add at least one session
4. Click **"Publish"** button

### Unpublishing (Closing)

1. Edit the opportunity
2. Change status to **"Closed"**
3. Save changes

**Note**: Closed opportunities are still visible but show as "Closed" and cannot be booked.

---

## Dashboard and Analytics

### Dashboard Statistics

The admin dashboard shows:
- **Total Opportunities**: Count of all your opportunities
- **Total Bookings**: All bookings across opportunities
- **Participants**: Unique users who have booked
- **Available Slots**: Remaining capacity

### Opportunities Table

View detailed statistics for each opportunity:
- **Title**: Opportunity name
- **Type**: Test, Poll, Survey, etc.
- **Status**: Draft, Published, or Closed
- **Sessions**: Number of sessions
- **Bookings**: Total bookings
- **Clicks**: For polls/surveys, number of clicks
- **Actions**: Edit, Delete, Duplicate, Analytics

### Analytics (Polls & Surveys)

For Poll and Survey opportunities:
1. Click **"Analytics"** button
2. View:
   - Total clicks
   - 24-hour clicks
   - 30-day trend chart
   - Click history

### Filtering and Search

- Use **Type filter** to filter by opportunity type
- Use **Status filter** to filter by status
- Use **Search** to find specific opportunities

---

## Settings

### Accessing Settings

1. Click your profile icon in header
2. Click **"Settings"** in dropdown
3. Or go to `/admin/settings`

### Notification Preferences

Control when you receive email notifications:

- **On Book Email**: Receive email when someone books a session
  - ✅ Enabled: Get notified of every booking
  - ❌ Disabled: No booking notifications

- **On Cancel Email**: Receive email when someone cancels
  - ✅ Enabled: Get notified of every cancellation
  - ❌ Disabled: No cancellation notifications

**Default**: Both are enabled

### Changing Preferences

1. Go to Settings page
2. Toggle notification preferences
3. Changes save automatically

### Session Reminder Emails

Participants receive an automatic reminder email ~24 hours before their session. This is handled by a daily cron job (Vercel Cron) that runs at 9:00 AM UTC. In production, set the **CRON_SECRET** environment variable in Vercel so only the cron invoker can call the reminder endpoint. Run **GET /api/run-migrations** after deploy to add the `reminder_sent_at` column to bookings. To test reminders locally, call **GET /api/cron/send-reminders** with header `Authorization: Bearer <your-CRON_SECRET>` (only works for bookings whose session starts in the 23–25 hour window).

---

## Managing Bookings

### Viewing Bookings

Bookings are shown in the Opportunities table:
- **Bookings** column shows total count
- Click on opportunity to see details

### Booking Details

When viewing an opportunity:
- See all sessions
- See bookings per session
- See participant information (in booking details)

### Canceling Bookings (On Behalf of Users)

As an admin, you can cancel bookings:
1. View the opportunity
2. Find the session with the booking
3. View booking details
4. Cancel if needed

**Note**: Users can cancel their own bookings from "My Bookings"

---

## Advanced Features

### Duplicating Opportunities

1. Go to Admin Dashboard
2. Find the opportunity
3. Click **"Duplicate"** button
4. A new draft opportunity is created with:
   - Same basic information
   - Same sessions (dates/times copied)
   - Status set to Draft
5. Edit as needed and publish

**Use Case**: Create recurring opportunities or similar sessions

### Deleting Opportunities

1. Go to Admin Dashboard
2. Find the opportunity
3. Click **"Delete"** button
4. Confirm deletion

**Warning**: This will:
- Delete the opportunity
- Delete all sessions
- Cancel all bookings
- This action cannot be undone!

### Auto-Closing Sessions

Sessions automatically close when:
- **Capacity Reached**: All slots are booked
- **Time Passed**: Session end time has passed

Closed sessions:
- Cannot be booked
- Still visible in lists
- Show as "Full" or "Past"

---

## Tips and Best Practices

### Creating Effective Opportunities

1. **Clear Titles**: Use descriptive, specific titles
2. **Good Descriptions**: Explain what participants will do
3. **Realistic Duration**: Set appropriate session lengths
4. **Multiple Sessions**: Offer various times for flexibility
5. **Early Publishing**: Publish early to maximize participation

### Session Management

1. **Plan Ahead**: Create sessions well in advance
2. **Capacity Planning**: Set realistic capacity limits
3. **Location Details**: Always include meeting links or locations
4. **Buffer Time**: Leave time between sessions if needed
5. **Monitor Bookings**: Check dashboard regularly

### Communication

1. **Email Notifications**: Keep notifications enabled to stay informed
2. **Clear Instructions**: Include all necessary information in descriptions
3. **Follow Up**: Consider sending reminder emails before sessions
4. **Be Responsive**: Check and respond to booking notifications

### Analytics

1. **Track Engagement**: Use analytics for polls/surveys
2. **Monitor Trends**: Check 30-day trends
3. **Optimize Timing**: Use data to schedule better times
4. **Measure Success**: Track participation rates

---

## Troubleshooting

### I Can't Create an Opportunity

- Make sure you're logged in as an admin
- Check that all required fields are filled
- Verify you have at least one session added
- Try refreshing the page

### Sessions Aren't Showing

- Make sure sessions are added and saved
- Check that opportunity is published (not draft)
- Verify session times are in the future
- Refresh the page

### Bookings Aren't Appearing

- Check that opportunity is published
- Verify sessions have available slots
- Check notification preferences
- Wait a few moments for updates

### Analytics Not Showing

- Analytics are only for Poll and Survey types
- Make sure opportunity is published
- Check that users have clicked the poll/survey link
- Data may take a moment to update

### Email Notifications Not Working

- Check Settings page for notification preferences
- Verify your email address is correct
- Check spam/junk folder
- Contact support if issues persist

---

## Getting Help

### Support Resources

- **Send Feedback**: Use feedback form in header
- **Service Desk**: https://adaptavistlabs.atlassian.net/servicedesk/customer/portal/80
- **Email**: adaptalabs-support@adaptavist.com

### Reporting Issues

When reporting issues, include:
- What you were trying to do
- What happened
- Any error messages
- Screenshots if helpful
- Browser and device information

---

**Last Updated**: 2025-01-27  
**Version**: 3.12.0

