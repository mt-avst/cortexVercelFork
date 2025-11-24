# Environment Variables Needed in Vercel

## Problem
The backend redirects to `CORS_ORIGIN` after login. If this isn't set, it defaults to `http://localhost:3000`, causing a blank screen.

Additionally, Google OAuth credentials are required for production login to work with real user accounts (including @adaptavist.com emails).

## Solution
You need to set environment variables in your Vercel project:

### Option 1: Using Vercel Dashboard
1. Go to: https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q/settings/environment-variables
2. Add these environment variables:

**For Production Environment (REQUIRED):**

**Core Configuration:**
- `CORS_ORIGIN` = `https://adapta-labs-p62q.vercel.app`
- `FRONTEND_URL` = `https://adapta-labs-p62q.vercel.app`

**Google OAuth (CRITICAL for login):**
- `GOOGLE_OAUTH_CLIENT_ID` = `your_google_oauth_client_id` (from Google Cloud Console)
- `GOOGLE_OAUTH_CLIENT_SECRET` = `your_google_oauth_client_secret` (from Google Cloud Console)
- `GOOGLE_OAUTH_REDIRECT_URI` = `https://adapta-labs-p62q.vercel.app/api/auth/google-callback`

**Database (CRITICAL - Required for login to work):**
- `DATABASE_URL` = `your_production_database_url` (PostgreSQL connection string)
  - **Required!** Without this, Google OAuth login will fail with a 500 error
  - See `DATABASE_URL_FIX.md` or `setup-neon-postgres.md` for setup instructions

**Other Required Variables:**
- `SESSION_SECRET` = `your_secure_random_secret_minimum_32_characters`

**Important Steps:**
1. After adding environment variables, you **MUST redeploy**:
   - Go to Deployments tab
   - Click the three dots (⋯) on latest deployment
   - Click "Redeploy"

2. Verify Google OAuth redirect URI matches:
   - The redirect URI in Google Cloud Console must exactly match `GOOGLE_OAUTH_REDIRECT_URI`
   - See `GOOGLE_OAUTH_PRODUCTION_SETUP.md` for detailed setup instructions

### Option 2: Check if backend is on Vercel
If the backend is on Vercel as a serverless function, you'd need to set environment variables there too.

### Temporary Workaround
Until environment variables are set, the redirects will fail. The user is getting blank screens because the backend is trying to redirect to localhost:3000. Without Google OAuth credentials, login will fall back to demo mode.

## Check Current Backend Deployment
Is the backend running at all in production? If not, that would also explain the blank screen.

## See Also
- **`GOOGLE_OAUTH_PRODUCTION_SETUP.md`** - Complete guide for setting up Google OAuth in production
- **`GOOGLE_CALENDAR_SETUP.md`** - Detailed Google OAuth setup instructions

