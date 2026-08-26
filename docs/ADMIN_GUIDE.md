# AdaptaLabs Admin Guide

**Version**: 7.49.0  
**Last Updated**: 2026-08-21

---

## Welcome, Researcher Admin!

This guide will help you create and manage research opportunities on AdaptaLabs.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating an Opportunity](#creating-an-opportunity)
3. [Managing Sessions](#managing-sessions)
4. [Unmoderated Studies](#unmoderated-studies)
5. [Polls and Surveys Answered in Cortex](#polls-and-surveys-answered-in-cortex)
6. [Consent](#consent)
7. [Publishing Opportunities](#publishing-opportunities)
8. [Dashboard and Analytics](#dashboard-and-analytics)
9. [Settings](#settings)
10. [Managing Bookings](#managing-bookings)
11. [Tips and Best Practices](#tips-and-best-practices)

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

### Finding your way around the form

The form is a series of steps, listed across the top. How many there are depends on the type you pick: an external poll has three, a recorded study has four, and before you have chosen a type at all there are two.
Each step says where it sits in the sequence - *Step 3 of 4* - what it is for, and how it is doing.

Every step reports one of four states, with an icon and words as well as a colour:

- **Not started** - you have not opened this step yet
- **Current step** - the one you are looking at
- **Completed** - you have been here and there is nothing on it that would stop a save
- **Needs attention** - something on this step is not right, and the form will refuse to save until it is

**Needs attention does not lock anything.** You can go forward and back freely, in any order, and nothing you have typed is lost by moving between steps. The flag is there to tell you where the problem is, not to stop you working.

The states update as you type. Leave the Title empty, walk two steps on, and step 1 says *Needs attention*; go back and fill it in, and it says *Completed* - without saving anything.

A draft is allowed to be empty, so a Task List step with nothing written on it yet still shows as **Completed** - there is genuinely nothing there stopping you. Publishing is where the form starts insisting.

An opportunity you are **editing** opens with its steps already marked, because its content is already saved.

### The two ways back

Two controls used to look almost identical and do very different things. They are now named apart:

- **Exit to dashboard**, at the top of the page, leaves the form. If you have unsaved changes it asks first, and you can choose to stay
- **Previous: {step name}**, at the bottom of every step after the first, goes back one step and names where it is going - *Previous: Task List*, *Previous: Content & Details*

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

### Step 3: Where a Poll or Survey is answered

A Poll or a Survey can be answered in either of two places, and you choose on **Basic Information**:

- **In an external tool** - you give Cortex the link. SurveyMonkey, Google Forms, Typeform and the rest. Cortex sends people there and counts the clicks, and the answers live in that tool. This is what every poll and survey used to be, and it is still the default
- **In Cortex** - you write the questions here and the answers come back in Cortex. Nothing is recorded: no screen, no microphone, no camera

Choosing **In an external tool** gives you an **External Link** step, where the link is required.
That is where people go when they click "Open Poll/Survey".

Choosing **In Cortex** replaces that step with a **Questions** step.
See [Polls and Surveys Answered in Cortex](#polls-and-surveys-answered-in-cortex).

A **One question** opportunity has no native mode and always uses an external link.

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

Choosing Unmoderated replaces the External Link step with a **Task List** step.
There is no Session Management step, because there is nothing to book.

### Step 2: Write the Task List

Open the **Task List** step. It is headed *"What the participant is asked to do while their screen is recorded"*.

- **Starting URL**: the page the participant is asked to open and record. Optional, but leave it blank only for a survey-style study with nothing to test. Without it, participants share their screen with nothing pre-opened and never see the guided open-and-share step
- **Estimated completion time**: worked out from your task list and shown to participants before they agree to be recorded. It moves as you write, so it stays right as the list grows. **Set it myself** takes it over if you know better - and once you have taken it over you can clear it entirely, which tells participants no length at all. That is still the better answer when you genuinely do not know: a wrong number is worse than no number
- **Add task**: adds a task, already open with the cursor in it. Each one is just **"What the participant sees"** - there is no response type to choose. Sessions record screen and voice, so participants answer **out loud** as they work; a typed answer box invited them to stop talking and type, which is the opposite of thinking aloud
  - Task Lists written before this still hold typed steps. Those run and stay editable, but no participant is asked to type any more, and their answers are in the recording
- **Each task is a collapsed row** showing its position, its type and the opening of its wording, so a long list stays readable and the controls below it stay within reach. **Edit** opens one to work on; **Collapse** shuts it again. A task that fails validation opens itself and is flagged **Needs attention**, so a refused save never hides the field it is complaining about
- **Reordering**, on each row: **Move up** and **Move down** for a nudge, a **position dropdown** to send a task straight to a given place in a long list, and a **drag handle** to drag it. Order matters: participants work through the list top to bottom. Every move is announced for screen reader users
- **Duplicate** copies a task and everything in it, and drops the copy directly below the original
- **Remove** deletes a task. If there is anything written in it, you are asked to confirm first

Consent is no longer written here. **Continue to Consent** takes you to a step of its own - see [Consent](#consent) below.

Write tasks as goals, not instructions.
*"Find last month's report and download it"* tells you whether the journey works.
*"Click Reports, then click Download"* only tells you whether they can follow directions.

Up to 50 tasks are allowed, though most useful studies have far fewer.

### Step 3: Start from an existing task list, if you have one

At the top of the Task List step, **"How do you want to add tasks?"** offers two answers.
**Create tasks for this opportunity** is the default and is what everything above describes.
**Start from an existing task list** offers the launched task lists you or a colleague has already written.

Each one shows how many tasks it holds, when it was last updated, and whether it is yours.
**Preview** opens the tasks themselves without leaving the form.
**Start from this** takes a **copy** into this opportunity.

The copy is the point.
The tasks become yours to edit here, and the original is left exactly as it was - so starting from a colleague's task list no longer means editing theirs, and later changes to theirs do not change what your participants see.
The form says where the copy came from, and so does the opportunity when you reopen it.

Only launched task lists appear, and only recorded ones - a set of survey questions is a different thing and cannot be copied here.
If the list is empty and you know one exists, it is probably still a draft, and the form says how many are waiting.

Changing your mind is safe: switching back to **Create tasks for this opportunity** keeps everything the copy brought in.

> **This replaced reuse-by-link.** Until 7.44 an opportunity could point at another opportunity's task list, and editing that list changed what every opportunity using it served, with nothing on screen saying so. Existing links were converted to copies when this shipped; nothing a participant sees changed.

### Step 4: Consent

**Continue to Consent** takes you to the last step, where the **Create opportunity** button lives.

It opens locked, showing the approved recorded-session wording and its version. Most studies need nothing here and can go straight on. If yours needs different wording, **Customise consent wording** unlocks it - and records that you did. See [Consent](#consent).

### Step 5: Publish and share

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
> The **Consent** step shows that study's wording read only too, with its approved-or-custom status, so you can see what it says without being able to change it. If the task list could not be **loaded** at all, the step says so and shows nothing rather than showing you the default wording as though it were the study's.

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

## Polls and Surveys Answered in Cortex

A Poll or Survey set to **In Cortex** collects its answers here rather than sending people to another tool.
Nothing is recorded - no screen, no microphone, no camera - so it is the right shape when you want typed answers rather than to watch someone work.

Choose it on **Basic Information**, under where the poll or survey is answered.
That replaces the External Link step with a **Questions** step.

### Writing the questions

The Questions step is headed *"What the participant is asked, answered here in Cortex"*.

- **Estimated completion time**: worked out from your questions and shown to participants before they start. It moves as you write. **Set it myself** takes it over, and once taken over it can be cleared entirely to tell them no length at all
- **Add question**: adds a question, already open with the cursor in it
- **Type**, on each question:
  - **Section text (no answer)** - a heading and some context before the next block of questions. It is shown and skipped, and does not count towards progress
  - **Free text** - a typed answer
  - **Choose one** / **Choose several** - answers you write, at least two
  - **Rating scale** - you set the number of points, between 2 and 10. It is never chosen for you: two surveys with the same wording on different scales produce numbers nothing records the difference between
  - **Recommendation score (0 to 10)** - always 0 to 10, so there is nothing to set. An author-set scale would produce something labelled a recommendation score whose numbers cannot be compared with anyone else's
- **Required** marks a question that has to be answered. Section text cannot be required, because it cannot be answered
- **Changing a question's type keeps what the new type cannot show.** Turn a multiple choice into free text and back, and your answers are still there. Turn a rating into a recommendation score and back, and your scale is still there. Nothing is thrown away by touching the type selector

### Working with a long list

The controls are the same ones the Task List uses, and they exist because a twenty-question survey used to push everything below it several screens down.

- **Each question is a collapsed row** showing its position, its type, whether it is required, and the opening of its wording. **Edit** opens one; **Collapse** shuts it
- A question that fails validation **opens itself** and is flagged **Needs attention**
- **Move up**, **Move down**, a **position dropdown** for a long list, and a **drag handle**. Every move is announced for screen reader users
- **Duplicate** copies a question and everything in it, including its answers and its scale, and drops the copy below the original
- **Remove** asks first if there is anything written in the question
- Up to 50 questions are allowed

### Consent

Consent is its own step now, shared with recorded studies, and it follows the questions. See [Consent](#consent).

### Starting from an existing set of questions

**"How do you want to add questions?"** works exactly as the task-list version above.
**Create questions for this opportunity** is the default; **Start from an existing set of questions** offers the launched, survey-shaped sets you or a colleague has already written, with a question count, a last-updated date, whether it is yours, and a **Preview**.

**Start from this** takes a **copy**, so the questions become yours to edit and the original is untouched.
Only survey-shaped sets appear - a recorded task list is a different vocabulary and cannot be copied here.
If the list is empty and you know one exists, it is probably still a draft, and the form says how many are waiting.

### Reviewing results

Open the opportunity and go to **Analytics**.
Answers are grouped under each question's own wording:

- **Choose one** and **Choose several** give a table of each answer with its count and share. Multiple choice says plainly that shares add up to past 100%, because they otherwise look like an error - and answers to options you have since removed are listed separately rather than vanishing
- **Rating scale** and **Recommendation score** give the distribution across the scale
- **Free text** lists the answers

There is a CSV export.

### Common mistakes

- **Writing a rating question without deciding the scale** - the save is refused rather than picking one for you
- **Expecting a recorded study's consent wording** - a survey records nothing, and its consent text says so
- **Reordering questions after people have answered** - answers are attached to a question by its position, so this is refused on the opportunity form. Make a new opportunity instead

---

## Consent

Consent is its own step, and it is the last one. It follows **Questions** on a poll or survey answered in Cortex, and **Task List** on a recorded study. The **Create opportunity** button lives there, so you pass through it on the way to saving.

**It opens locked, showing the approved wording**, the template it comes from and its version - for example *Standard survey consent (version 1)*, with a line saying what it covers. There is nothing to type into, because for most studies there is nothing to decide: the approved wording is the wording.

There are two templates, and they are deliberately different:

- **Standard recorded-session consent** covers screen and microphone recording, who sees the recording, and how a participant ends it
- **Standard survey consent** says what is stored, who sees it, and that **no screen, microphone or camera is recorded**

A survey never gets the recorded wording and a recorded study never gets the survey wording. Reusing the recorded text on a survey would have participants agreeing to a capture that never happens.

### If your study needs different wording

**Customise consent wording** unlocks the field. Nothing is stopping you, and nothing tries to.

What changes is that the deviation is **recorded**:

- The step marks the study **Custom wording** and says plainly that it does not run on approved consent wording
- A **diff** shows exactly what your version adds and removes against the template you started from, with a one-line summary in words as well as the marked-up text
- A **Custom consent** flag appears against that study in the Task Lists list, and against it in the copy picker - so anyone starting from your study sees it *before* they take the copy

**Opening the field is not the same as changing it.** Unlock it, read it, change nothing, and the study still runs on the approved template. Change it and change it back exactly, and it goes back to the template - there is no flag left stuck on. **Restore the approved wording** puts the template text back and re-locks the field in one step.

Whitespace alone is not a change: a stray blank line at the end does not mark a study as custom.

### What a copy inherits

Starting from an existing task list or set of questions brings its consent wording across **and its status with it**. A copy of an approved study is approved; a copy of somebody's custom wording is custom. That is why the copy picker shows the flag on the row.

### What the participant sees

Whatever wording is stored on the study at the moment their session starts - approved or custom. That wording is **frozen into their session**, along with which template it was, so editing the study afterwards never changes what somebody has already agreed to.

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

### "Somebody else saved this while you were editing"

Cortex refuses a save that would silently overwrite a colleague. You see this
when someone else saved the same task list, or the same opportunity's questions,
after you opened yours.

**Nothing you typed has been lost.** Your edits are still on screen, and nothing
of yours has been written.

You have two choices, and neither loses your work:

- **Look at theirs first.** Use the link in the message to open the saved
  version in a new tab. Your unsaved edits stay untouched in the original tab,
  so you can compare and copy across what you want to keep
- **Keep yours.** Save again. The second save goes through and replaces their
  version - deliberately, now that you have been told

Deliberately re-saving overwrites the other person's changes, so it is worth
looking first if you are not sure what they changed.

Two things worth knowing:

- Task lists are shared. The Task Lists area lists every admin's, not just
  yours, so somebody editing the same one is normal rather than a mistake
- Cortex does not name who saved it. If you need to know, ask - or check with
  whoever else works on that study

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

**Last Updated**: 2026-08-21  
**Version**: 7.49.0

