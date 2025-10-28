# How to Set Up GitHub-Vercel Webhook

## The Problem
Vercel is not receiving webhook notifications from GitHub, so it doesn't know about new commits.

## The Solution: Authorize Vercel as a GitHub App

### Step 1: Go to Vercel Project Git Settings
1. Open: https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q/settings/git
2. You'll see information about your connected repository

### Step 2: Reconnect GitHub Integration
1. On the Git Settings page, click **"Disconnect"** button (if it exists)
2. Then click **"Connect Git Repository"** 
3. Select **GitHub** as your Git provider
4. Authorize Vercel if prompted
5. Select your repository: `nickfine/AdaptaLabs`
6. Select branch: `main`
7. Click **"Deploy"**

### Step 3: Verify Auto-Deploy is Enabled
1. Still on the settings page, scroll down to **"Production Deployments"**
2. Ensure "Auto-deploy from GitHub" is **ON**
3. If it's OFF, turn it ON

### Step 4: Wait for Deployment
- A new deployment should automatically trigger
- It should pick up commit `5dbbf79` (your latest code with fixes)

## Alternative: If Connect Git Repository Doesn't Work

If the button doesn't work, try this:

1. Go to Vercel Team Settings: https://vercel.com/nicks-projects-113886a0/settings
2. Click on **"Git"** in the left sidebar
3. You should see **"Connect Git Provider"** or **"GitHub"** listed
4. Click it and make sure it's connected
5. Grant permissions to access your repositories

## After Configuration

Once connected, Vercel will:
1. Receive webhooks from GitHub on every push
2. Automatically deploy when you push to `main`
3. Deploy your latest code with localhost fixes

## Verify It's Working

After connecting, make a small change and push:
```bash
echo "# Test" >> README.md
git add README.md
git commit -m "Test webhook"
git push origin main
```

You should see a new deployment appear in Vercel within seconds!

