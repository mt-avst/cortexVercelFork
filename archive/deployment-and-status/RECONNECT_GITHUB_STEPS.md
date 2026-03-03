# Steps to Fix Vercel-GitHub Auto-Deploy

## Quick Steps (Try This First)

### Option 1: Reconnect in Vercel Dashboard

1. **Go to your project Git settings:**
   ```
   https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q/settings
   ```

2. **Click on "Git" tab in the left sidebar**

3. **You should see your repository connected. If you see a "Disconnect" button:**
   - Click **Disconnect**
   - Wait a moment
   - Click **Connect Git Repository** (or "Restore Git Integration")
   - Select GitHub
   - Authorize if prompted
   - Select `nickfine/AdaptaLabs`
   - Select branch: `main`
   - Click **Deploy**

4. **After connecting, check deployment settings:**
   - Still in Settings
   - Go to "Deployments" tab
   - Make sure "Automatic deployments from Git" is **enabled**

## Option 2: If No "Disconnect" Button Exists

1. **Go to Vercel Settings:**
   ```
   https://vercel.com/nicks-projects-113886a0/settings
   ```

2. **Click "Git" in the left sidebar**

3. **You should see your Git provider (GitHub). If it shows "Not Connected":**
   - Click "Connect Git Provider" or "GitHub"
   - Authorize Vercel
   - Grant access to your repositories
   - Then go back to your project

4. **Return to project Git settings:**
   ```
   https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q/settings/git
   ```

5. **Click "Connect Git Repository"**
   - Select `nickfine/AdaptaLabs`
   - This should now automatically set up the webhook

## What Should Happen

After connecting:
1. Vercel will automatically add a webhook to your GitHub repository
2. You can verify by going to: https://github.com/nickfine/AdaptaLabs/settings/hooks
3. You should see a Vercel webhook there

## Test It

After reconnecting, push this to trigger a deployment:
```bash
echo "" >> timestamp.txt && git add timestamp.txt && git commit -m "Test webhook" && git push
```

Within 30 seconds, you should see a new deployment in Vercel!

