# Database Configuration Required

## Issue

The Google OAuth callback handler is crashing with a 500 error because `DATABASE_URL` is not set in production.

## Solution

You need to set up a PostgreSQL database and configure the connection string in Vercel.

### Option 1: Use Neon (Free, Recommended)

1. **Create a Neon account** (if you don't have one):
   - Go to: https://neon.tech
   - Sign up (can use GitHub)
   - Create a new project

2. **Get the connection string**:
   - Copy the connection string from Neon dashboard
   - Format: `postgres://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`

3. **Add to Vercel**:
   ```bash
   cd "/Volumes/Extreme Pro/Labs2"
   echo "your_neon_connection_string_here" | vercel env add DATABASE_URL production
   ```

### Option 2: Use Vercel Postgres

1. Go to Vercel Dashboard → Your Project → Storage
2. Create a Postgres database
3. Copy the `POSTGRES_URL` connection string
4. Add as `DATABASE_URL` in environment variables

### Option 3: Use Existing Database

If you already have a PostgreSQL database:
1. Get the connection string
2. Add it as `DATABASE_URL` in Vercel production environment variables

## After Setting DATABASE_URL

1. **Redeploy** the application:
   ```bash
   vercel --prod
   ```

2. **Run migrations** (if needed):
   - The database tables need to exist
   - Check if migrations are needed in `backend/src/db/migrations/`

## Quick Fix Command

Once you have a database connection string, run:

```bash
cd "/Volumes/Extreme Pro/Labs2"
echo "your_database_connection_string" | vercel env add DATABASE_URL production
vercel --prod
```

## Verification

After setting DATABASE_URL and redeploying:
- Try logging in again
- The callback should now successfully create/update users in the database
- Check Vercel function logs if there are still errors





