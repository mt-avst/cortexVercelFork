# Google Calendar Integration Setup Guide

This guide will help you set up Google Calendar integration for your Adaptalabs application using Google Cloud Console.

## Status, before you follow any of this

> **Part 2 (Service Account Calendar) does nothing.**
> `backend/src/services/calendar.ts` has no Google client and there is no value of
> `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` or `GOOGLE_CALENDAR_ID` that
> builds one.
> Setting those variables changes nothing except one WARN line at boot.
> Booking used to report `calendar: "success"` with a fabricated
> `demo-event-<timestamp>` id regardless; it now answers `calendar: "not_configured"`
> and writes no event id (cto/AdaptaLabs#89).
> Per-user OAuth is the direction being taken instead.

> **Part 1 (User Calendar OAuth) works. You do NOT need credentials to try it.**
>
> `GET /api/calendar/auth/connect` was restored for cto/AdaptaLabs#89 (it had been
> deleted in v2.5.1, which left `connection-status` answering `{"connected":false}`
> for every user, permanently).
>
> There are **three modes**, decided in one place - `calendarOAuthMode()` in
> `backend/src/routes/userCalendar.ts`:
>
> | Mode | When | What happens |
> |---|---|---|
> | `real` | `GOOGLE_OAUTH_CLIENT_ID` and `..._SECRET` are set | the genuine Google flow |
> | `demo` | they are not, and `NODE_ENV=development` | a COMPLETE working flow with no credentials: the consent URL points back at our own callback with `code=demo`, tokens are minted, `connection-status` flips to `connected`, and mock busy time appears at 10am/2pm/3pm, aligned with the demo sessions |
> | `unavailable` | they are not, and this is not development | `503`, and the UI offers no Connect control |
>
> **So local development needs nothing from Google.** Follow Part 1 below only when
> you want a researcher's REAL free/busy in a deployed environment; then see
> `.kubera/playground-backend.yaml` for where the two values go.
>
> The `unavailable` refusal is deliberate rather than a gap: those demo tokens are
> **fabricated**, and a researcher who connected successfully and then trusted
> invented busy time is worse off than one offered no button at all.
>
> Skip Part 2 entirely.

Authoring does not depend on either of them: the Session Management slot picker
generates availability without a calendar, and slots can be typed in by hand.

## Overview

The application uses **two types** of Google Calendar integrations:

1. **User Calendar OAuth** - Allows users to connect their personal Google Calendar (read-only) to check for conflicts when booking sessions
2. **Service Account Calendar** - Allows the system to create calendar events on behalf of admin owners when bookings are made

## Prerequisites

- Access to Google Cloud Console
- A Google Cloud project (or ability to create one)
- Admin access to enable APIs

## Part 1: User Calendar OAuth Setup

This enables users to connect their personal Google Calendar accounts.

### Step 1: Create or Select a Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **"Select a project"** (or **"Create or select a project"**)
3. Either:
   - Select an existing project, OR
   - Click **"New Project"** → Enter project name → Click **"Create"**

### Step 2: Enable Google Calendar API

1. In the Google Cloud Console, go to **"APIs & Services"** → **"Library"**
2. Search for **"Google Calendar API"**
3. Click on **"Google Calendar API"**
4. Click **"Enable"**

### Step 3: Configure OAuth Consent Screen

1. Go to **"APIs & Services"** → **"OAuth consent screen"**
2. Choose **"External"** (unless you have a Google Workspace account)
3. Click **"Create"**
4. Fill in the required fields:
   - **App name**: Adaptalabs Research Platform (or your app name)
   - **User support email**: Your email address
   - **Developer contact information**: Your email address
5. Click **"Save and Continue"**
6. On **"Scopes"** page:
   - Click **"Add or Remove Scopes"**
   - Search for and add:
     - `https://www.googleapis.com/auth/calendar.readonly`
     - `https://www.googleapis.com/auth/userinfo.email`
   - Click **"Update"** → **"Save and Continue"**
7. On **"Test users"** page (if in testing mode):
   - Add test user emails (your email and any test accounts)
   - Click **"Save and Continue"**
8. Review and click **"Back to Dashboard"**

### Step 4: Create OAuth 2.0 Credentials

1. Go to **"APIs & Services"** → **"Credentials"**
2. Click **"Create Credentials"** → **"OAuth client ID"**
3. Choose application type: **"Web application"**
4. Fill in:
   - **Name**: Adaptalabs Calendar OAuth Client (or descriptive name)
   - **Authorized JavaScript origins**: 
     - `http://localhost:3001` (for local development)
     - Your production backend URL (e.g., `https://api.yourdomain.com`)
   - **Authorized redirect URIs**:
     - `http://localhost:3001/api/calendar/auth/callback` (for local development)
     - `http://localhost:3001/auth/google-callback` (for login flow)
     - Your production callback URLs (e.g., `https://api.yourdomain.com/api/calendar/auth/callback`)
5. Click **"Create"**
6. **IMPORTANT**: Copy the **Client ID** and **Client Secret** immediately
   - These will be shown only once
   - Store them securely

### Step 5: Add Credentials to Environment

Add these to your `.env` file (or environment variables):

```bash
# Google OAuth for User Calendar Integration
GOOGLE_OAUTH_CLIENT_ID=your_client_id_here
GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret_here
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3001/api/calendar/auth/callback
```

For production, update `GOOGLE_OAUTH_REDIRECT_URI` to your production URL.

---

## Part 2: Service Account Setup (Optional)

This enables the system to create calendar events on behalf of admin owners. This is optional - you can skip this if you only want users to connect their own calendars.

### Step 1: Create Service Account

1. Go to **"APIs & Services"** → **"Credentials"**
2. Click **"Create Credentials"** → **"Service account"**
3. Fill in:
   - **Service account name**: adaptalabs-calendar-service
   - **Service account ID**: adaptalabs-calendar-service (auto-filled)
   - **Description**: Service account for creating calendar events
4. Click **"Create and Continue"**
5. Skip optional steps and click **"Done"**

### Step 2: Create Service Account Key

1. Click on the newly created service account
2. Go to **"Keys"** tab
3. Click **"Add Key"** → **"Create new key"**
4. Choose **"JSON"** format
5. Click **"Create"**
6. **IMPORTANT**: A JSON file will download - save it securely (you won't be able to download it again)

### Step 3: Enable Domain-Wide Delegation (Optional)

Only needed if you want to create events on calendars of users in a Google Workspace domain.

1. Click on your service account
2. Under **"Advanced settings"**, enable **"Enable Google Workspace Domain-wide Delegation"**
3. Note the **Client ID** shown
4. You'll need to authorize this in your Google Workspace Admin Console

### Step 4: Share Calendar with Service Account

1. Open your Google Calendar
2. Go to **"Settings"** → **"Settings for my calendars"**
3. Select the calendar you want to use
4. Go to **"Share with specific people"**
5. Click **"Add people"**
6. Enter the service account email (from the JSON file: `client_email` field)
7. Give it **"Make changes to events"** permission
8. Click **"Send"**

### Step 5: Extract Service Account Credentials

From the downloaded JSON file, extract:

```json
{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "your-service-account@project-id.iam.gserviceaccount.com",
  ...
}
```

### Step 6: Add Service Account Credentials to Environment

Add these to your `.env` file:

```bash
# Google Service Account for Calendar Event Creation
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project-id.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour private key here\n-----END PRIVATE KEY-----"
GOOGLE_CALENDAR_ID=primary
```

**Important**: 
- The `GOOGLE_PRIVATE_KEY` must include the `\n` characters (newlines) as shown
- Wrap the entire private key in quotes
- For `GOOGLE_CALENDAR_ID`, use `primary` for the main calendar, or use the calendar ID for a specific calendar

---

## Testing the Integration

### Test User Calendar OAuth

1. Start your backend server
2. Navigate to your frontend application
3. Log in or sign up
4. Look for **"Connect Google Calendar"** button
5. Click it and authorize with your Google account
6. You should be redirected back with calendar connected

### Test Service Account Calendar

1. Make a booking as an admin/researcher
2. Check if a calendar event is created in the admin's calendar
3. Check backend logs for any errors

---

## Troubleshooting

### Common Issues

1. **"Redirect URI mismatch"**
   - Verify the redirect URI in OAuth credentials matches exactly (including protocol, port, path)
   - Check for trailing slashes

2. **"Access denied" or "403 Forbidden"**
   - Ensure Google Calendar API is enabled
   - Check OAuth consent screen is configured
   - Verify test users are added (if in testing mode)

3. **"Invalid grant"**
   - Authorization code may have expired (they expire quickly)
   - Try disconnecting and reconnecting

4. **Service account can't create events**
   - Verify the calendar is shared with the service account email
   - Check service account has correct permissions
   - Ensure domain-wide delegation is set up (if using Workspace)

### Environment Variables Checklist

Ensure these are set:

```bash
# User Calendar OAuth
GOOGLE_OAUTH_CLIENT_ID=✓
GOOGLE_OAUTH_CLIENT_SECRET=✓
GOOGLE_OAUTH_REDIRECT_URI=✓

# Service Account (Optional)
GOOGLE_SERVICE_ACCOUNT_EMAIL=✓
GOOGLE_PRIVATE_KEY=✓
GOOGLE_CALENDAR_ID=primary
```

---

## Security Notes

1. **Never commit** `.env` files or service account JSON files to version control
2. Store credentials securely (use environment variables in production)
3. Use different OAuth clients for development and production
4. Regularly rotate credentials if compromised
5. Limit service account permissions to only what's needed

---

## Next Steps

After setting up credentials:

1. Add them to your `.env` file
2. Restart your backend server
3. Test the calendar connection flow
4. Verify calendar events are created for bookings
5. Check that calendar conflicts are detected correctly

For production deployment, add these environment variables to the Kubera secret store (or `.kubera/playground-backend.yaml` `config.data` for the non-secret values) with production URLs.

