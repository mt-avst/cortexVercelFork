# Vercel Postgres Setup Guide

This guide will help you set up PostgreSQL for your Vercel deployment.

## Step 1: Create Vercel Postgres Database

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project: **adapta-labs-p62q**
3. Go to **Storage** tab
4. Click **Create Database**
5. Select **Postgres**
6. Choose a name (e.g., `adaptalabs-db`)
7. Choose a region (closest to your users)
8. Click **Create**

## Step 2: Get Connection String

After the database is created:

1. Click on your database in the Storage tab
2. Go to the **.env.local** tab
3. You'll see two connection strings:
   - `POSTGRES_URL` (direct connection)
   - `POSTGRES_PRISMA_URL` (for Prisma, not needed for us)
   - `POSTGRES_URL_NON_POOLING` (direct connection without pooling)

**You need `POSTGRES_URL`**

## Step 3: Add Environment Variable

1. In Vercel Dashboard, go to **Settings** → **Environment Variables**
2. Add a new variable:
   - **Name**: `DATABASE_URL`
   - **Value**: Copy the value from `POSTGRES_URL` (it starts with `postgres://`)
   - **Environments**: Select all (Production, Preview, Development)
3. Click **Save**

Alternatively, you can also use `POSTGRES_URL` directly. The code will check both `DATABASE_URL` and `POSTGRES_URL`.

## Step 4: Run Database Migrations

You need to run the migrations to create the tables. You can do this via:

### Option A: Using Vercel CLI

```bash
# Install Vercel CLI if you haven't
npm i -g vercel

# Pull environment variables
vercel env pull .env.production

# Run migrations (requires DATABASE_URL to be set)
cd backend
npm run migrate
```

### Option B: Using a One-Time Script

Create a temporary script to run migrations:

```bash
# Create migration script
cat > run-migrations.js << 'EOF'
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false }
});

// Read migration SQL from backend/src/db/migrate.ts
// (You'll need to extract the SQL or use the migrate script)
const { runMigrations } = require('./backend/dist/db/migrate.js');

runMigrations()
  .then(() => {
    console.log('Migrations completed');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
EOF

# Run it with DATABASE_URL set
DATABASE_URL=$(vercel env pull .env.production | grep DATABASE_URL) node run-migrations.js
```

### Option C: Manual SQL Execution

1. In Vercel Dashboard, go to your database
2. Click **Data** tab or use **Query** tab if available
3. Copy and paste the SQL from `backend/src/db/migrate.ts`

## Step 5: Verify Setup

After migrations run, verify the setup:

1. Check if tables exist in Vercel Dashboard → Storage → Your Database → Tables
2. You should see tables like:
   - `users`
   - `opportunities`
   - `sessions`
   - `bookings`
   - etc.

## Step 6: Seed Demo Data (Optional)

If you want to seed the database with demo data:

```bash
cd backend
DATABASE_URL=$(vercel env pull .env.production | grep DATABASE_URL) npm run seed
```

## Troubleshooting

### Connection Issues

- Make sure `DATABASE_URL` is set correctly
- Ensure SSL is enabled (Vercel Postgres requires SSL)
- Check that the database is in the same region as your functions

### Migration Issues

- Make sure you're using the correct connection string
- Check that you have permissions to create tables
- Look for errors in the Vercel function logs

### Testing Locally

To test locally with Vercel Postgres:

```bash
# Pull environment variables
vercel env pull .env.local

# The .env.local will have DATABASE_URL set
# Now you can run migrations or start the backend
cd backend
npm run migrate
npm run dev
```

## Next Steps

Once the database is set up:

1. The serverless functions will automatically use PostgreSQL instead of file storage
2. All data will persist across deployments
3. You can query the database directly from Vercel Dashboard

