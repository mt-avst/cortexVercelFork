# Vercel Environment Variables Setup

## Overview
This document outlines the environment variables needed for deploying the AdaptaLabs frontend to Vercel.

## Required Environment Variables

To fix the localhost reference issues in production, set the following environment variables in your Vercel project:

### Production Environment Variables

```bash
# Set the environment to production
REACT_APP_ENVIRONMENT=production

# Set your backend API URL (if you have a separate backend deployed)
REACT_APP_API_BASE_URL=https://your-backend-api-url.com

# If your backend is on a different domain, also set:
REACT_APP_AUTH_BASE_URL=https://your-backend-api-url.com

# OR if your backend is on the same domain (e.g., using Vercel serverless functions):
# Leave these unset or use relative paths
# REACT_APP_API_BASE_URL=
# REACT_APP_AUTH_BASE_URL=
```

## How to Set Environment Variables in Vercel

1. Go to your Vercel project dashboard
2. Click on **Settings** → **Environment Variables**
3. Add each variable:
   - **Name**: The environment variable name (e.g., `REACT_APP_ENVIRONMENT`)
   - **Value**: The environment variable value (e.g., `production`)
   - **Environment**: Select which environments to apply (Production, Preview, Development)
4. Click **Save**

## Changes Made

### 1. `frontend/src/config/api.ts`
- **Before**: Hardcoded `'http://localhost:3001'` fallback
- **After**: Uses empty string `''` for production environment, allowing relative paths
- This ensures API calls go to the same domain in production

### 2. `frontend/src/setupProxy.js`
- **Before**: Single hardcoded localhost fallback
- **After**: Checks multiple env vars and logs the proxy target
- This setupProxy is only used in development mode anyway

## Deployment Instructions

### Option 1: Backend Deployed Separately

If you have a separate backend (e.g., on Railway, Render, or another platform):

1. Deploy your backend first and get the URL
2. In Vercel, set:
   - `REACT_APP_ENVIRONMENT=production`
   - `REACT_APP_API_BASE_URL=https://your-backend-url.com`
   - `REACT_APP_AUTH_BASE_URL=https://your-backend-url.com`

### Option 2: Backend as Vercel Serverless Functions

If you're deploying the backend as Vercel serverless functions:

1. In Vercel, set:
   - `REACT_APP_ENVIRONMENT=production`
   - Leave `REACT_APP_API_BASE_URL` and `REACT_APP_AUTH_BASE_URL` unset

2. The code will use relative paths (empty string) and Vercel will route requests properly

### Option 3: Localhost Development

For local development, the code will automatically use `http://localhost:3001` as a fallback.

## Testing the Fix

After setting up environment variables and redeploying:

1. Visit your Vercel deployment URL
2. Check browser console for any errors
3. Verify images load correctly (logo and research icon)
4. Test API calls work properly

## Troubleshooting

### Images Still Not Loading

If images still don't load after deployment:
1. Check that images exist in `frontend/public/images/` directory
2. Verify build output includes images in `frontend/build/images/`
3. Check browser Network tab to see if images are being requested from correct path

### API Calls Failing

If API calls are failing:
1. Check browser console for error messages
2. Verify environment variables are set correctly in Vercel
3. Check Network tab to see what URL API calls are going to
4. Ensure CORS is configured correctly on your backend

## Current Status

✅ Fixed hardcoded localhost fallback in production
✅ Updated setupProxy for better development experience  
⏳ Next: Set environment variables in Vercel dashboard
⏳ Next: Redeploy and verify fixes

