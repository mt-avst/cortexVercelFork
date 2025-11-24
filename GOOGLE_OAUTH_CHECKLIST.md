# Quick Checklist: Google OAuth Production Setup

## ✅ Action Items

### 1. Get Google OAuth Credentials (if not already done)
- [ ] Create OAuth 2.0 Client ID in Google Cloud Console
- [ ] Copy Client ID and Client Secret
- [ ] Add redirect URI: `https://adapta-labs-p62q.vercel.app/api/auth/google-callback`

### 2. Set Environment Variables in Vercel
Go to: https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q/settings/environment-variables

**Set these for Production environment:**
- [ ] `GOOGLE_OAUTH_CLIENT_ID` = `[your_client_id]`
- [ ] `GOOGLE_OAUTH_CLIENT_SECRET` = `[your_client_secret]`
- [ ] `GOOGLE_OAUTH_REDIRECT_URI` = `https://adapta-labs-p62q.vercel.app/api/auth/google-callback`
- [ ] `CORS_ORIGIN` = `https://adapta-labs-p62q.vercel.app`
- [ ] `FRONTEND_URL` = `https://adapta-labs-p62q.vercel.app`

### 3. Redeploy
- [ ] After setting variables, redeploy the application
- [ ] Deployments → Latest → ⋯ → Redeploy

### 4. Verify
- [ ] Test login on production site
- [ ] Should redirect to Google OAuth (not demo login)
- [ ] Test with @adaptavist.com email (or any Google account)

## 📚 Detailed Documentation

For complete setup instructions, see:
- **`GOOGLE_OAUTH_PRODUCTION_SETUP.md`** - Full production setup guide
- **`GOOGLE_CALENDAR_SETUP.md`** - Google OAuth setup instructions

## ⚠️ Common Issues

**"GOOGLE_OAUTH_CLIENT_ID is required in production mode"**
→ Set `GOOGLE_OAUTH_CLIENT_ID` in Vercel Production environment

**"Redirect URI mismatch"**
→ Ensure redirect URI in Google Cloud Console exactly matches `GOOGLE_OAUTH_REDIRECT_URI`

**Login still uses demo mode**
→ Verify variables are set for **Production** (not Preview/Development), then redeploy






