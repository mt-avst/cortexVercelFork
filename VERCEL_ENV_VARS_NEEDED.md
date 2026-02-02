# Environment Variables Needed in Vercel

## Deployment: Root Directory

**Root Directory must be the repo root** (empty or `.`). In Vercel Dashboard: Project → Settings → General → **Root Directory**. If this is set to `frontend`, only the frontend is deployed and `/api/*` will serve the SPA (index.html) instead of the API. Set it to the repo root so both `frontend/` and `api/` are deployed.

## Problem
The backend redirects to `CORS_ORIGIN` after login. If this isn't set, it defaults to `http://localhost:3000`, causing a blank screen.

Additionally, Google OAuth credentials are required for production login to work with real user accounts (including @adaptavist.com emails).

## Solution
You need to set environment variables in your Vercel project:

### Option 1: Using Vercel Dashboard
1. Go to: https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q/settings/environment-variables
2. Add these environment variables:

**For Production Environment (REQUIRED):**

| Variable | Purpose | Notes |
|----------|---------|--------|
| `DATABASE_URL` or `POSTGRES_URL` | Postgres connection string | **Required.** API throws without it. See `setup-neon-postgres.md` or `VERCEL_POSTGRES_SETUP.md`. |
| `SESSION_SECRET` | Session signing | Min 32 characters. |
| `CORS_ORIGIN` | Allowed origin | e.g. `https://adapta-labs-p62q.vercel.app` |
| `FRONTEND_URL` | Post-login redirect base | Same as CORS_ORIGIN for same-origin. |

**Optional but recommended:**

- **Google OAuth**: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` (e.g. `https://adapta-labs-p62q.vercel.app/api/auth/google-callback`) for production login. See `GOOGLE_OAUTH_PRODUCTION_SETUP.md`.
- **Email**: `EMAIL_*` if you use email notifications (booking confirmations, session reminders). Feedback is saved to the DB only and shown in the Feedback tab; no email is sent for feedback.
- **CRON_SECRET**: Required for automated session reminder emails. Set a random string (e.g. `openssl rand -hex 32`). Vercel Cron sends it as `Authorization: Bearer <CRON_SECRET>` when invoking `/api/cron/send-reminders`. Without it, reminder cron returns 401.

**Important Steps:**
1. After adding environment variables, you **MUST redeploy**:
   - Go to Deployments tab
   - Click the three dots (⋯) on latest deployment
   - Click "Redeploy"

2. **Run database migrations** (once, after DATABASE_URL is set):
   - Call `GET https://adapta-labs-p62q.vercel.app/api/run-migrations` after deploy, **or**
   - Run locally: `vercel env pull .env.production` then from repo root use backend or a script with that `DATABASE_URL` (see `VERCEL_POSTGRES_SETUP.md`).
   - **Seed (optional):** If you need demo data, run seed once via admin endpoint or locally with production `DATABASE_URL`.

3. Verify Google OAuth redirect URI matches:
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

