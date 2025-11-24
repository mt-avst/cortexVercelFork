# Google OAuth Redirect URI Fix

## Problem
Google OAuth is failing because the redirect URI is set to:
```
https://adapta-labs-p62q.vercel.app/api/calendar/auth/callback
```

But it should be:
```
https://adapta-labs-p62q.vercel.app/api/auth/google-callback
```

## Solution

### Step 1: Update Vercel Environment Variable

1. Go to [Vercel Dashboard](https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q/settings/environment-variables)

2. Find `GOOGLE_OAUTH_REDIRECT_URI` in the list

3. Click the **Edit** button (pencil icon)

4. Update the value to:
   ```
   https://adapta-labs-p62q.vercel.app/api/auth/google-callback
   ```

5. Make sure it's enabled for **Production** and **Preview** environments

6. Click **Save**

### Step 2: Update Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to **APIs & Services** → **Credentials**
3. Find your OAuth 2.0 Client ID (ends with `.apps.googleusercontent.com`)
4. Click to edit it
5. Under **Authorized redirect URIs**, add/update:
   ```
   https://adapta-labs-p62q.vercel.app/api/auth/google-callback
   ```
6. Remove the old calendar callback URI if it's no longer needed:
   ```
   https://adapta-labs-p62q.vercel.app/api/calendar/auth/callback
   ```
   (Keep this if you still need calendar-only OAuth flows)
7. Click **Save**

### Step 3: Redeploy (Optional)

After updating the environment variable, Vercel will automatically redeploy. If not, you can trigger a redeploy:

```bash
vercel redeploy --prod
```

## Verification

After making these changes:

1. Clear your browser cache/cookies
2. Try Google login again
3. The OAuth flow should now redirect to the correct callback URL
4. Check browser DevTools → Network tab to verify the redirect URI in the OAuth request

## Alternative: Using Vercel CLI

If you prefer CLI, you can update it manually:

```bash
# Remove old value (requires confirmation)
vercel env rm GOOGLE_OAUTH_REDIRECT_URI production

# Add new value (requires confirmation)
echo "https://adapta-labs-p62q.vercel.app/api/auth/google-callback" | vercel env add GOOGLE_OAUTH_REDIRECT_URI production

# Repeat for preview environment
vercel env rm GOOGLE_OAUTH_REDIRECT_URI preview
echo "https://adapta-labs-p62q.vercel.app/api/auth/google-callback" | vercel env add GOOGLE_OAUTH_REDIRECT_URI preview
```

