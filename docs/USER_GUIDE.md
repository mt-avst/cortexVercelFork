# AdaptaLabs User Guide

**Version**: 7.65.0  
**Last Updated**: 2026-08-29

---

## Welcome to AdaptaLabs

AdaptaLabs is an internal platform for researchers to post opportunities and for employees to browse and book research sessions. This guide will help you get started.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Browsing Opportunities](#browsing-opportunities)
3. [Booking a Session](#booking-a-session)
4. [Managing Your Bookings](#managing-your-bookings)
5. [Polls and Surveys](#polls-and-surveys)
6. [Recorded Sessions](#recorded-sessions)
7. [Troubleshooting](#troubleshooting)
8. [FAQ](#faq)

---

## Getting Started

### Accessing AdaptaLabs

1. Navigate to the AdaptaLabs website
2. Sign in with your company Google account to see the studies available to take part in
3. Book a session on any study that has open slots

A direct link to a specific study will open without signing in, but you'll need to sign in to book.

### Signing In

**Option 1: Google SSO (Recommended)**
- Click "Sign in with Google"
- Use your company Google account
- You'll be redirected back to AdaptaLabs

**Option 2: Demo Login (Testing)**
- Click "Demo Login" on the landing page
- This creates a temporary demo account for testing

---

## Browsing Opportunities

### Viewing All Opportunities

- The home page shows all available opportunities
- Each opportunity card shows:
  - **Type**: Live session, Recorded session, Poll, Survey, Interview or One question
  - **Title**: Name of the opportunity
  - **Purpose**: Brief description
  - **Available Sessions**: Number of remaining slots, on the types you book. Recorded sessions, polls and surveys show roughly how long they take instead

### Filtering Opportunities

- Use the **type filter** buttons above the list to filter by:
  - All
  - Live session
  - Recorded session
  - Survey
  - Poll
  - Interview
  - One question

### Using the Type Filters

- The type filters are chips above the list, not a search box; there is no free-text search on the home page.
- Click a chip to show only that study type, and click **All** to return to the full list.
- A line above the list tells you how many studies are showing and which type is currently selected.

### Viewing Opportunity Details

1. Click on any opportunity card
2. You'll see:
   - Full description
   - Available session times
   - Remaining slots per session
   - Calendar conflict indicators (if you're logged in)

---

## Booking a Session

### Prerequisites

- You must be signed in
- The opportunity must have available sessions
- The session time must be in the future

### How to Book

1. **Browse** to find an opportunity you're interested in
2. **Click** on the opportunity to view details
3. **Review** available session times
4. **Select** a session with available slots
5. **Click** the "Book" button
6. **Confirm** your booking - if the opportunity carries consent text (Live sessions and Interviews describe what the researcher may store afterwards, such as a recording of the call), it is shown to you here and **Accept and book** is what completes the booking

### What Happens When You Book

- ✅ Your booking is confirmed
- ✅ If you accepted consent text, the exact wording you saw is stored with your booking
- ✅ A calendar event is created (Google Calendar)
- ✅ You receive a confirmation email
- ✅ The session slot count decreases
- ✅ You can view your booking in "My Bookings"

### Calendar Integration

- When you book, a Google Calendar event is automatically created on the researcher's calendar
- You receive a confirmation email that may include a calendar link or .ics attachment so you can add the session to **your own** calendar
- The event includes: session title, date and time, location or meeting link (if provided), researcher contact information
- **When you cancel**: The event is removed from the researcher's calendar. If you added the session to your own calendar (via the email link or .ics), you need to remove it yourself from your calendar app

### Conflict Detection

- If you're logged in, the system checks for calendar conflicts
- Sessions with conflicts show a warning badge
- You can still book, but be aware of the conflict

---

## Managing Your Bookings

### Viewing Your Bookings

1. Click **"My Bookings"** in the header (when logged in). Below 992px wide it is inside the header's menu button
2. You'll see:
   - **Upcoming bookings**: sessions still to come
   - **Past bookings**: sessions that have happened
   - **Recorded sessions**: recorded sessions you have started, shown only once you have started one. See [Recorded Sessions](#recorded-sessions)

### Canceling a Booking

1. Go to **"My Bookings"**
2. Find the booking you want to cancel
3. Click **"Cancel"**
4. Confirm the cancellation
5. You'll receive a cancellation email
6. The slot becomes available for others

**Note**: You cannot cancel past bookings. If you added this session to your own calendar (e.g. via the confirmation email link), remove it from your calendar after cancelling—the app only removes the event from the researcher's calendar.

### Changing a Booking to a Different Time

There is no Reschedule button. Cancel the booking, then book the slot you want
from the study page.

Cortex used to show a **Reschedule** control on every upcoming booking, but it
was permanently disabled - the feature behind it was never built - so it has
been removed rather than left promising something it could not do. My Bookings
now tells you the working route in place of the dead button.

### What Are Polls and Surveys?

- **Polls**: Quick questions or voting opportunities
- **Surveys**: Longer-form feedback collection

### How to Participate

1. Browse opportunities and find a poll or survey
2. Click on the opportunity
3. Click **"Open Poll"** or **"Open Survey"** button
4. You'll be taken to an external link
5. Complete the poll/survey on the external site
6. Your participation is automatically tracked

### Tracking

- Your click is tracked for analytics
- Researchers can see participation rates
- Your privacy is protected (IP addresses are hashed)

---

## Recorded Sessions

A recorded session is self-guided.
There is no researcher with you and nothing to book.
You work through a short list of tasks on your own, while Cortex records your screen and microphone in the browser.
The research team watches the recording afterwards.

It is the same kind of study as a **Live session**, run without a researcher present - which is why the two names are a pair.

They appear in the opportunity list like anything else.
Filter by **Recorded session** to find them, and the card tells you roughly how long the study takes.

### What You Need

- A laptop or desktop, and a browser window at least 1024 pixels wide
- Chrome, Edge, Arc, Opera or Firefox. Safari cannot record a session
- A working microphone
- To be signed in to Cortex

Cortex checks all of this for you before anything starts, and tells you what to fix if something is missing.
You cannot take part on a phone or tablet.

### What Is Recorded

- **Your screen**, and only the window or screen you choose when the browser asks
- **Your microphone**, so you can think aloud as you work

You are never asked to type an answer.
Say what you are thinking as you go - that is the answer, and it is in the recording.

Your camera is never used.
Nothing is recorded until you have agreed to it and pressed start.

### How to Take Part

The session page is one long page of six numbered blocks: Welcome, Consent, Setup and start, Task, Upload and Done.
Each unlocks as you finish the one before it.

1. Open the opportunity and click **Start recorded study**. The session opens in the same tab and takes over the page
2. **Welcome**: read the brief and what to expect, then click **Continue to consent**. The tasks themselves come one at a time once recording starts, so you meet each page as you would normally
3. **Consent**: read what you are agreeing to, then click **I agree and want to continue**. Choosing **I do not agree** ends the study there and nothing is recorded
4. **Setup and start**: Cortex checks your browser, window size, microphone and screen sharing. If something fails, fix it and click **Check again**
5. **Open the task window**: this opens a small panel that floats above your other windows and holds your tasks. Everything from here happens in that panel
   - In the panel, click **Open the task page**. It opens in its own window
   - Then click **Start recording** in the panel, allow your microphone, and pick the task page in the browser's sharing chooser. In Chrome and Edge it is under the **Window** tab. Sharing your whole screen works just as well if you cannot find it
   - If the study has no page for you to use, there is a single **Start recorded session** button on the Cortex page instead
6. **Task**: work through the tasks one at a time in the floating panel. Do what the task asks in the task window, saying what you are thinking as you go, then click **I’ve completed this task** to move on
   - **Your tasks follow you.** The panel stays above your other windows, so you can read the task without switching back and forth, and it closes itself when you finish - along with the task window, so there is nothing left open once you are done
   - Move or resize it like any other window, or drag it to a second screen. **Bring the task page back** in the panel re-opens the task window if you lose it behind something
   - It shows **Cortex** and whether recording is live. If it ever says **Recording stopped**, go back to the Cortex tab to see what happened, because nothing you do after that point is being recorded
   - If you close the panel, the Cortex page takes the tasks back and you carry on there
   - The panel needs Chrome, Edge, Arc or Opera. In Firefox you work from the Cortex tab throughout, which does the same job
7. **Upload**: stay on the page while your recording uploads. Recording itself has already stopped by this point
8. **Done**: you will see **Recording captured**, and nothing further is needed from you

There are no right answers.
The team is testing the product, not you.

### Stopping

You stay in control throughout:

- **Before you begin**: click **I do not agree** at the consent step. The study ends cleanly and no recording begins. If you did that by mistake, **Review consent again** takes you back
- **Once it has started**: stop sharing your screen using your browser's own stop-sharing control, at any point and for any reason. Recording ends immediately. What was already captured is kept, and your saved answers stay saved, so you can carry on through the remaining tasks
- **If you shared the task window itself** rather than your whole screen, closing that window also ends the recording. Keep it open until you have finished

Do not refresh or close the session tab until the upload has finished.
Your recording is held in the browser until it uploads, so leaving the page destroys it, and that is true whether the recording stopped early or ran to the end.
Your browser will warn you if you try.

### After the Session

Your sessions appear in **My Bookings** under **Self-guided sessions**.
Each stage is listed separately, so one completed session usually shows two entries, one **Started** and one **Completed**, with the time each happened.
A session you declined or left part-way through shows as **Abandoned**.
**View opportunity** takes you back to the study it belonged to.

---

## Troubleshooting

### I Can't See Any Opportunities

- Check if filters are applied
- Select the **All** chip to clear the type filter
- Refresh the page
- Contact support if the issue persists

### I Can't Book a Session

**Possible reasons:**
- You're not signed in (sign in required)
- The session is full (no remaining slots)
- The session time has passed
- There's a technical issue

**Solutions:**
- Make sure you're logged in
- Try a different session time
- Refresh the page and try again
- Contact support if the problem continues

### I Didn't Receive a Confirmation Email

- Check your spam/junk folder
- Verify your email address is correct
- Wait a few minutes (emails may be delayed)
- Check with your IT department about email filtering

### Calendar Event Not Created

- Check your Google Calendar
- Verify you're signed in with the correct Google account
- Check your calendar permissions
- Contact support if the issue persists

### I Can't Cancel My Booking

- Make sure you're logged in
- Check that the booking is in the "Upcoming" tab
- Past bookings cannot be cancelled
- Contact support if you need help

### The Page Won't Load

- Check your internet connection
- Try refreshing the page
- Clear your browser cache
- Try a different browser
- Contact support if the problem continues

### I Can't Start a Recorded Session

If the **Start Test** button is disabled, or you are told the study is not yet configured, the research team has not finished setting it up.
Contact them, or try again later.

### My Browser Blocked the Task Page

Allow pop-ups for Cortex from your browser's address bar, then click **Open the task page** again.

### I Can't Find the Task Page in the Sharing Chooser

In Chrome and Edge, look under the **Window** tab in the chooser.
If it still is not listed, share your whole screen instead.

### My Recording Stopped Before I Finished

Either you or your browser stopped the screen share, which ends the recording.
Everything captured up to that point is safe and still uploads, and your answers are saved.
Carry on through the remaining tasks to finish the session.

### I Can't Take Part on My Phone

Recorded sessions need a laptop or desktop, a window at least 1024 pixels wide and one of Chrome, Edge, Arc, Opera or Firefox.
Safari cannot record a session.

---

## FAQ

### Do I Need to Create an Account?

No separate account is needed. Sign in with your company Google account (SSO).

### Can I Browse Without Signing In?

No.
Signing in is what shows you the studies available to take part in.
A direct link to a specific study will still open without signing in, but browsing what's on offer and booking a session both need you signed in.

### How Many Sessions Can I Book?

You can book multiple sessions, but only one booking per session slot.

### Can I Book Multiple Sessions for the Same Opportunity?

Yes, if there are multiple session times available, you can book different sessions for the same opportunity.

### What Happens If I Miss a Session?

- Past sessions cannot be cancelled
- Contact the researcher if you need to discuss
- Check "My Bookings" to see past sessions

### Can I See Who Else Is Booked for a Session?

No, for privacy reasons, you can only see:
- Total number of slots
- Number of remaining slots
- Your own bookings

### How Do I Contact a Researcher?

- Researcher contact information is included in:
  - Booking confirmation emails
  - Calendar event details
  - Opportunity descriptions (if provided)

### What If I Have Technical Issues?

1. Try the troubleshooting steps above
2. Use the **"Send Feedback"** link in the header
3. Contact support: nfine@adaptavist.com
4. Submit a ticket via Service Desk

### Do I Need to Book a Recorded Session?

No.
There is nothing to book and no time slot to keep.
Open it and start whenever it suits you.

### Is My Camera Recorded?

No.
A recorded session records your screen and your microphone only.
Your camera is never switched on.

### Can I Stop a Recorded Session Once It Has Started?

Yes.
Stop sharing your screen using your browser's own control and the recording ends immediately.
Whatever was recorded before that point is kept, so if you would rather a session was not used at all, tell the research team.

### Is My Data Secure?

Yes! AdaptaLabs follows security best practices:
- Secure authentication (SSO)
- Encrypted connections (HTTPS)
- Privacy-protected analytics
- Minimal data collection

### Can I Use This on Mobile?

Yes, AdaptaLabs is responsive and works on mobile devices. Some features may be optimized for desktop use.

---

## Getting Help

### Feedback and Support

- **Send Feedback**: Click "Send Feedback" in the header dropdown menu
- **Service Desk**: https://adaptavistlabs.atlassian.net/servicedesk/customer/portal/80
- **Email**: nfine@adaptavist.com

### Reporting Issues

When reporting an issue, please include:
- What you were trying to do
- What happened (or didn't happen)
- Any error messages
- Your browser and device information
- Screenshots (if helpful)

---

## Tips for Best Experience

1. **Book Early**: Popular sessions fill up quickly
2. **Check Your Calendar**: Use conflict detection to avoid double-booking
3. **Read Descriptions**: Make sure the opportunity is right for you
4. **Check Emails**: Confirmation emails contain important details
5. **Manage Bookings**: Check "My Bookings" regularly to stay organized

---

**Last Updated**: 2026-08-18  
**Version**: 7.43.4

