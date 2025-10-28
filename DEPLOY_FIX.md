# Fix Vercel GitHub Connection

## Steps to Fix:

1. Go to: https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q/settings/git

2. Click "Disconnect" for the current GitHub integration

3. Click "Connect Git Repository"

4. Select your repository: `nickfine/AdaptaLabs`

5. Vercel should automatically trigger a new deployment with the latest commits

## OR - Manual Deploy via Dashboard:

1. Go to: https://vercel.com/nicks-projects-113886a0/adapta-labs-p62q

2. Click on any of the "Ready" deployments (78NzbLuxS, 9jcaaoKDY, or 8YGCGPqmy)

3. In the deployment details, click "..." menu → "Redeploy"

4. Select "Use existing build cache: Off" to force a fresh build

This should deploy the latest code with localhost fixes.
