# AdaptaLabs Admin Guide

**Version**: 7.3.23  
**Last Updated**: 2025-01-27

---

## Welcome, Researcher Admin!

This guide will help you create and manage research opportunities on AdaptaLabs.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating an Opportunity](#creating-an-opportunity)
3. [Managing Sessions](#managing-sessions)
4. [Unmoderated Studies](#unmoderated-studies)
5. [Publishing Opportunities](#publishing-opportunities)
6. [Dashboard and Analytics](#dashboard-and-analytics)
7. [Settings](#settings)
8. [Managing Bookings](#managing-bookings)
9. [Tips and Best Practices](#tips-and-best-practices)

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
  - 🧪 **Usability test**: Interactive session with participants
  - 📊 **Quick poll**: Quick questions/voting
  - 📋 **Survey**: Detailed feedback collection
  - 💬 **Interview**: One-on-one interviews
  - ❓ **One question**: Single question opportunities
  - 🖥️ **Recorded study**: Self-guided study recorded in the participant's browser. See [Unmoderated Studies](#unmoderated-studies)

  These are the same names participants see. Cortex uses one name per type everywhere now; the older admin-only labels ("App Testing", "Unmoderated Testing") are gone.

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

## Unmoderated Studies

An unmoderated study is self-guided: there is no moderator and no time slot.
The participant works through a list of tasks on their own while Cortex records their screen and microphone in the browser.
You watch the recording afterwards.

Use it when you want to see people actually using something, without booking time with each of them.
Use a **Test** or **Interview** instead when you need to be in the room.

### What you need before you start

- The page or prototype you want people to use, at a URL they can reach
- Two to five tasks, phrased as things to do rather than questions to answer
- Nothing else - there are no sessions to schedule and no external tool to configure

### Step 1: Create the opportunity

1. Go to Admin Dashboard
2. Click **"Create New Opportunity"**
3. On **Basic Information**, set **Research Study Type** to **"🖥️ Recorded study - Self-guided, recorded in the browser"**
4. Fill in Title and Purpose as usual on **Basic Information** and **Content & Details**

Choosing Unmoderated replaces the External Link tab with a **Task List** tab.
There is no Sessions tab, because there is nothing to book.

### Step 2: Write the Task List

Open the **Task List** tab. It is headed *"What the participant is asked to do while their screen is recorded"*.

- **Starting URL**: the page the participant is asked to open and record. Optional, but leave it blank only for a survey-style study with nothing to test. Without it, participants share their screen with nothing pre-opened and never see the guided open-and-share step
- **Add task**: adds a task. Each one is just **"What the participant sees"** - there is no response type to choose. Sessions record screen and voice, so participants answer **out loud** as they work; a typed answer box invited them to stop talking and type, which is the opposite of thinking aloud
  - Task Lists written before this still hold typed steps. Those run and stay editable, but no participant is asked to type any more, and their answers are in the recording
- **Up**, **Down** and **Remove** on each task card reorder or delete it. Order matters: participants work through the list top to bottom
- **Consent text**: pre-filled with wording that covers screen and microphone recording, who sees it and the right to stop. Edit it if your study needs something different, but do not delete it

Write tasks as goals, not instructions.
*"Find last month's report and download it"* tells you whether the journey works.
*"Click Reports, then click Download"* only tells you whether they can follow directions.

Up to 50 tasks are allowed, though most useful studies have far fewer.

### Step 3: Reuse a Task List instead, if you have one

Tick **"Reuse an existing task list instead of writing one here"** to pick one you or a colleague has already written, from **Existing task list**.

Only launched task lists appear.
If the dropdown is empty and you know one exists, it is probably still a draft - the form will tell you how many drafts are waiting.

Reuse is deliberate: several opportunities can run the same task list, and results stay separate per opportunity.
You can reuse a colleague's task list, but only its owner or a superadmin can change it.

### Step 4: Publish and share

Publish as you would any opportunity.
Once published, open it and you will see a **Share this study** panel with the participant link.
See [Sharing an Opportunity with Participants](#sharing-an-opportunity-with-participants).

Participants need a Cortex account and will be asked to sign in, so the link does not work for anyone outside the organisation.

### What the participant experiences

1. Opens the link, reads the brief and clicks **Start Test**
2. Reads and accepts the consent text
3. Shares their screen and grants microphone access. The task page opens in its own window first, so it appears in the browser's share picker
4. Works through the tasks, thinking aloud. If the study has a Starting URL, the current task floats in a small window above the page they are testing, so they are not switching back and forth to remember what you asked. It appears on its own and needs nothing from them
5. Finishes, and the recording uploads

Two things follow from that floating window when you write a task list:

- **Keep prompts short.** The window is small and the prompt is the first thing in it, so a long paragraph is harder to work from there than it looks in the editor
- **A participant sharing their whole screen will have that window in the recording**, sitting over the page under test. Someone sharing only the task window will not. Either way the task list sits beside the playback in review, so nothing is lost

It needs a Chromium browser (Chrome, Edge, Arc, Opera). Firefox participants get the previous two-window experience, which still works.

Their steps are fixed at the moment they start.
Editing a task list never changes a session already under way, so a participant mid-study will not see your edit - relaunch is not needed and not possible for them.

### Reviewing results

1. Open the opportunity and go to **Analytics**
2. Use the **Sessions** tab, which lists Participant, Session, Status and Last activity
3. Open a session for **Session Review**: recording playback, the answers to each task and a transcript

### Editing a study that is already published

Reopening an opportunity shows exactly what you wrote - the tasks or questions, the consent wording, the estimated duration and the starting URL - and you can edit them there and save.

> **Some task lists open read only on the opportunity form, and it will say which applies.**
> Either it belongs to another researcher, or it uses something this form cannot show: a step type it does not offer, or a different starting URL for each step.
> Editing it here would quietly drop whatever was not shown, so the form does not offer to.
> The second case can be edited in the **Task Lists** area. The first cannot be edited by you anywhere - ask its owner or a superadmin.

> **Changing the questions of a study that has already collected answers is refused on the opportunity form.**
> That is deliberate: a task's identity comes from its position in the list, so changing the order would re-attach answers already collected to the wrong tasks.
> Editing the consent wording or the estimated duration still saves normally.
> The same save is also refused if the task list belongs to another researcher, or if a second opportunity is using it - in both cases because the change would reach somebody else's work.

- Editing the task list changes what **future** participants see. Sessions already started keep the tasks they began with
- If someone else owns the task list you are reusing, the editor opens read only and says so. Ask the owner or a superadmin to make the change
- Changing the Starting URL after people have taken part makes the recordings harder to compare. Prefer a new opportunity for a genuinely different study

### Common mistakes

- **No Starting URL on a study that has something to test** - participants share a blank screen and have to find their own way there
- **Tasks written as click-by-click instructions** - you learn whether they can follow you, not whether the design works
- **Publishing with no task list linked** - the Share panel warns you, and the participant's start button is disabled. Link one before sharing
- **Assuming a colleague can edit your task list** - only its owner or a superadmin can
- **Deleting every task and saving, expecting the list to empty** - a task list needs at least one task, and the save is refused rather than silently keeping what was there
- **Expecting to change questions after people have answered** - the save is refused, on purpose. Make a new opportunity instead

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

### Sharing an Opportunity with Participants

Once an opportunity is published, open it and you will see a **Share this study** panel with its link.
Only admins see this panel.
Click **Copy link** and send the URL to the people you want to take part.

The link goes to the opportunity page, where a participant reads the brief and starts from there.
There is no separate link to a task list, because a participant never opens one directly.

Two things to know before you send it:

- Recipients need a Cortex account and will be asked to sign in, so the link does not work for anyone outside the organisation
- The panel warns you if nothing is linked for participants to start yet, which means the start button on that page is disabled. Link a task list before sharing

The panel does not appear on a draft or a closed opportunity, because neither can be started.

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

Participants receive an automatic reminder email ~24 hours before their session. This is handled by an in-process `node-cron` schedule inside the Express backend that runs daily at 9:00 AM UTC and calls `sendDueReminders()` (`backend/src/services/reminders.ts`); each booking is reminded at most once via the `reminder_sent_at` column. Because the scheduler runs inside the backend process there is no external invoker to authenticate — the **CRON_SECRET** environment variable (in the Kubera secret store) only guards the manual trigger endpoint below. The `reminder_sent_at` column is added by the migrations that run automatically on every deploy (the backend init container), so no manual migration step is needed. To trigger reminders manually (locally or in production), call **GET /api/cron/send-reminders** with header `Authorization: Bearer <CRON_SECRET>` (only works for bookings whose session starts in the 23–25 hour window). Disable the scheduler with `REMINDER_CRON_DISABLED=true`.

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
**Version**: 7.3.23

