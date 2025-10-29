# Setup Neon Postgres (Free Serverless PostgreSQL)

Since Vercel Postgres isn't available, we'll use **Neon** - a free serverless PostgreSQL that works perfectly with Vercel.

## Step 1: Create Neon Account & Database

1. Go to: https://neon.tech
2. Click **"Sign Up"** (can use GitHub)
3. Click **"Create Project"**
4. Name: `adaptalabs-db`
5. Choose a region (pick closest to you/your users)
6. Click **"Create Project"**

## Step 2: Get Connection String

After creating the project:

1. You'll see a **Connection String** automatically generated
2. It looks like: `postgres://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require`
3. **Copy this connection string**

## Step 3: Add to Vercel Environment Variables

I'll help you add this to Vercel. Just paste the connection string when ready!

Alternatively, you can do it manually:
1. Go to Vercel Dashboard → Your Project → Settings → Environment Variables
2. Add: `DATABASE_URL` = (paste your Neon connection string)
3. Apply to: Production, Preview, Development

## Step 4: Run Migrations

Once the DATABASE_URL is set, I'll run the migrations for you.

---

## Why Neon?

- ✅ **Free tier** (perfect for development)
- ✅ **Serverless** (auto-scales, pay for what you use)
- ✅ **PostgreSQL compatible** (works with our existing code)
- ✅ **Branching** (create database branches for testing)
- ✅ **Great Vercel integration**

## Quick Link

[Create Neon Account →](https://neon.tech)

