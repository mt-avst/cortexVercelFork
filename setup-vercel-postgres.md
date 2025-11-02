# Quick Setup Guide: Vercel Postgres

## Step 1: Create the Database (Manual - Must be done in Dashboard)

Since database creation requires the Vercel dashboard, please do this manually:

1. **Go to**: https://vercel.com/dashboard
2. **Select your project**: `adapta-labs-p62q` (or search for it)
3. **Click on "Storage" tab** (in the left sidebar)
4. **Click "Create Database"**
5. **Select "Postgres"**
6. **Enter name**: `adaptalabs-db`
7. **Choose a region** (pick the one closest to your users)
8. **Click "Create"** (this may take a minute)

## Step 2: Get the Connection String

After the database is created:

1. **Click on your database** (`adaptalabs-db`)
2. **Go to the ".env.local" tab**
3. **Copy the `POSTGRES_URL` value** (it looks like: `postgres://default:xxxxx@ep-xxx.region.postgres.vercel-storage.com:5432/verceldb`)

## Step 3: Add Environment Variable (I'll help with this)

Once you have the `POSTGRES_URL`, come back here and I'll run:

```bash
vercel env add DATABASE_URL
```

Then paste the connection string when prompted.

## Step 4: Run Migrations

After the environment variable is set, I'll run:

```bash
vercel env pull .env.production
cd backend
npm run migrate
```

---

## Alternative: Use the Setup Script

Run the helper script which will guide you:

```bash
./setup-vercel-db.sh
```

For migration only (after database and env var are set):

```bash
./setup-vercel-db.sh --migrate
```










