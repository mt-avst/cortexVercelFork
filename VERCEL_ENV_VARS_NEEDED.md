# Environment Variables Needed in Vercel

## Problem
The backend redirects to `CORS_ORIGIN` after login. If this isn't set, it defaults to `http://localhost:3000`, causing a blank screen.

## Solution
You need to set environment variables in your Vercel project:

### Option 1: Using Vercel Dashboard
1. Go to: https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q/settings/environment-variables
2. Add these environment variables:

**For Production Environment:**
- `CORS_ORIGIN` = `https://adapta-labs-p62q.vercel.app`
- `FRONTEND_URL` = `https://adapta-labs-p62q.vercel.app`

**Note:** The backend service needs these set too. Is your backend deployed separately?

### Option 2: Check if backend is on Vercel
If the backend is on Vercel as a serverless function, you'd need to set environment variables there too.

### Temporary Workaround
Until environment variables are set, the redirects will fail. The user is getting blank screens because the backend is trying to redirect to localhost:3000.

## Check Current Backend Deployment
Is the backend running at all in production? If not, that would also explain the blank screen.

