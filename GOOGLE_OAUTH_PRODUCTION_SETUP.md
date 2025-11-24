# Google OAuth Production Setup Guide

## Overview

This guide ensures that Google OAuth credentials are properly configured in production (Vercel) to enable real user authentication with any Google account email (including `@adaptavist.com` and other domains).

## Required Environment Variables

You need to set these environment variables in your Vercel project:

### Critical Variables

1. **`GOOGLE_OAUTH_CLIENT_ID`** - Your Google OAuth Client ID
2. **`GOOGLE_OAUTH_CLIENT_SECRET`** - Your Google OAuth Client Secret  
3. **`GOOGLE_OAUTH_REDIRECT_URI`** - The callback URL for OAuth (see below)

### Related Variables

4. **`CORS_ORIGIN`** - Your production frontend URL (e.g., `https://adapta-labs-p62q.vercel.app`)
5. **`FRONTEND_URL`** - Your production frontend URL (same as above)
6. **`DATABASE_URL`** - Your production database connection string
7. **`SESSION_SECRET`** - A secure random string (minimum 32 characters)

## Step-by-Step Setup

### Step 1: Get Google OAuth Credentials

If you don't have Google OAuth credentials yet:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select or create a project
3. Enable **Google Calendar API** (APIs & Services → Library)
4. Configure **OAuth consent screen**:
   - Go to APIs & Services → OAuth consent screen
   - Choose "External" (unless you have Google Workspace)
   - Fill in app name, support email, developer contact
   - Add scopes:
     - `https://www.googleapis.com/auth/calendar.readonly`
     - `openid`
     - `profile`
     - `email`
   - Add test users if in testing mode
5. Create **OAuth 2.0 Client ID**:
   - Go to APIs & Services → Credentials
   - Click "Create Credentials" → "OAuth client ID"
   - Choose "Web application"
   - Add authorized redirect URIs:
     - `https://adapta-labs-p62q.vercel.app/api/auth/google-callback` (production)
     - `http://localhost:3001/api/auth/google-callback` (development, if needed)
   - Copy the **Client ID** and **Client Secret** (shown only once!)

For detailed instructions, see `GOOGLE_CALENDAR_SETUP.md`.

### Step 2: Set Environment Variables in Vercel

#### Option A: Using Vercel Dashboard (Recommended)

1. Go to your Vercel project dashboard:
   - Direct link: https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q/settings/environment-variables
   - Or navigate: Your Project → Settings → Environment Variables

2. Add each environment variable:

   **For Production Environment:**
   
   | Variable Name | Value | Environment |
   |--------------|-------|-------------|
   | `GOOGLE_OAUTH_CLIENT_ID` | `your_google_oauth_client_id` | Production |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | `your_google_oauth_client_secret` | Production |
   | `GOOGLE_OAUTH_REDIRECT_URI` | `https://adapta-labs-p62q.vercel.app/api/auth/google-callback` | Production |
   | `CORS_ORIGIN` | `https://adapta-labs-p62q.vercel.app` | Production |
   | `FRONTEND_URL` | `https://adapta-labs-p62q.vercel.app` | Production |
   | `DATABASE_URL` | `your_production_database_url` | Production |
   | `SESSION_SECRET` | `your_secure_random_secret_min_32_chars` | Production |

3. For each variable:
   - Click **"Add New"**
   - Enter the **Name** (exactly as shown above)
   - Enter the **Value**
   - Select **Environment**: Check "Production"
   - Click **"Save"**

4. **Important**: After adding new environment variables, you **must redeploy**:
   - Go to Deployments tab
   - Click the three dots (⋯) on the latest deployment
   - Click **"Redeploy"**
   - Or push a new commit to trigger a new deployment

#### Option B: Using Vercel CLI

```bash
# Install Vercel CLI if not already installed
npm i -g vercel

# Login to Vercel
vercel login

# Link your project (if not already linked)
vercel link

# Set environment variables (production)
vercel env add GOOGLE_OAUTH_CLIENT_ID production
vercel env add GOOGLE_OAUTH_CLIENT_SECRET production
vercel env add GOOGLE_OAUTH_REDIRECT_URI production
vercel env add CORS_ORIGIN production
vercel env add FRONTEND_URL production

# Redeploy to apply changes
vercel --prod
```

### Step 3: Verify Redirect URI Configuration

**Critical**: The redirect URI in Google Cloud Console **must exactly match** the one you set in Vercel:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to: APIs & Services → Credentials
3. Click on your OAuth 2.0 Client ID
4. Under **"Authorized redirect URIs"**, ensure you have:
   ```
   https://adapta-labs-p62q.vercel.app/api/auth/google-callback
   ```
5. If missing, click **"Add URI"** and add it
6. Click **"Save"**

### Step 4: Verify Configuration

After setting environment variables and redeploying:

1. **Check demo mode detection**:
   - With `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` set, the app should be in **production mode**
   - Demo mode is enabled when these are missing

2. **Test login flow**:
   - Visit your production site
   - Click login
   - Should redirect to Google OAuth (not demo login)
   - After authorization, should redirect back to your site

3. **Check logs** (if available):
   - Look for any OAuth-related errors
   - Verify redirect URI matches

## Important Notes

### Redirect URI Format

The redirect URI must match exactly:
- ✅ Correct: `https://adapta-labs-p62q.vercel.app/api/auth/google-callback`
- ❌ Wrong: `https://adapta-labs-p62q.vercel.app/api/auth/google-callback/` (trailing slash)
- ❌ Wrong: `https://adapta-labs-p62q.vercel.app/auth/google-callback` (missing `/api`)

### Environment-Specific Values

- **Development**: Use localhost URLs
- **Production**: Use production domain URLs
- **Preview**: Can use preview URLs or same as production

### Security Best Practices

1. **Never commit** credentials to git
2. **Use different OAuth clients** for development and production
3. **Rotate credentials** if compromised
4. **Limit OAuth scopes** to only what's needed
5. **Monitor OAuth usage** in Google Cloud Console

## Troubleshooting

### Issue: "GOOGLE_OAUTH_CLIENT_ID is required in production mode"

**Solution**: Ensure `GOOGLE_OAUTH_CLIENT_ID` is set in Vercel production environment variables.

### Issue: "Redirect URI mismatch"

**Solution**: 
1. Check that `GOOGLE_OAUTH_REDIRECT_URI` in Vercel matches exactly with Google Cloud Console
2. Verify there are no trailing slashes or extra characters
3. Ensure the domain is correct (no typos)

### Issue: Login still goes to demo login

**Solution**:
1. Verify environment variables are set for **Production** environment (not just Preview/Development)
2. Redeploy after adding environment variables
3. Check browser console for errors
4. Verify you're testing on production domain (not localhost)

### Issue: "Access denied" or "403 Forbidden"

**Solution**:
1. Verify Google Calendar API is enabled
2. Check OAuth consent screen is configured
3. If in testing mode, ensure test user email is added
4. Verify scopes are correct

### Issue: Users can't login with @adaptavist.com email

**Solution**:
1. Ensure Google OAuth is configured (not demo mode)
2. Verify OAuth consent screen allows external users (if using "External" type)
3. Check that the user's Google account has access to the app
4. If in testing mode, ensure the email is added as a test user

## Verification Checklist

- [ ] Google OAuth Client ID created in Google Cloud Console
- [ ] Google OAuth Client Secret copied (saved securely)
- [ ] OAuth consent screen configured
- [ ] Redirect URI added to Google Cloud Console
- [ ] `GOOGLE_OAUTH_CLIENT_ID` set in Vercel (Production)
- [ ] `GOOGLE_OAUTH_CLIENT_SECRET` set in Vercel (Production)
- [ ] `GOOGLE_OAUTH_REDIRECT_URI` set in Vercel (Production)
- [ ] `CORS_ORIGIN` set in Vercel (Production)
- [ ] `FRONTEND_URL` set in Vercel (Production)
- [ ] Application redeployed after setting variables
- [ ] Login redirects to Google OAuth (not demo login)
- [ ] Test user can login successfully

## Next Steps

After completing setup:

1. Test login with a real Google account
2. Verify user is created/updated in database
3. Test calendar connection (if applicable)
4. Monitor for any errors in logs
5. Update documentation if production URL changes

## References

- [Google Cloud Console](https://console.cloud.google.com/)
- [Vercel Environment Variables](https://vercel.com/docs/concepts/projects/environment-variables)
- [Google OAuth Documentation](https://developers.google.com/identity/protocols/oauth2)
- See also: `GOOGLE_CALENDAR_SETUP.md` for detailed OAuth setup instructions






