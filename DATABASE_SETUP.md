# Database Setup Instructions

The app is currently using in-memory storage which doesn't persist across serverless cold starts. To fix this, you need to:

## Option 1: Vercel Postgres (Recommended)

1. Go to https://vercel.com/dashboard
2. Click on your project (adapta-labs-p62q)
3. Go to Settings → Storage
4. Click "Create Database" → Select "Postgres"
5. After creation, you'll get a `POSTGRES_URL` connection string
6. Add this as an environment variable:
   - Go to Settings → Environment Variables
   - Add: `DATABASE_URL` = (value of `POSTGRES_URL`)
7. Connect from the Vercel CLI:
   ```bash
   vercel env pull .env.production
   ```

## Option 2: Use Existing Database

If you have a PostgreSQL database already set up:

1. Add the connection string as an environment variable in Vercel:
   - Name: `DATABASE_URL`
   - Value: `postgresql://user:pass@host:5432/dbname`
2. Deploy again

## After Setup

The API will automatically detect the database and start using it instead of in-memory storage.
