#!/bin/bash

# Database Setup Helper Script
# Helps set up PostgreSQL for Vercel deployment

set -e

echo "🗄️  PostgreSQL Database Setup"
echo "=============================="
echo ""

# Check if vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "❌ Vercel CLI is not installed"
    echo "Install it with: npm i -g vercel"
    exit 1
fi

echo "✅ Vercel CLI found"
echo ""

# Check if project is linked
if [ ! -f .vercel/project.json ]; then
    echo "📦 Linking Vercel project..."
    vercel link --yes
fi

echo "✅ Project linked"
echo ""

echo "🔍 Choose your database provider:"
echo ""
echo "1. Neon Postgres (Recommended - Free, Serverless)"
echo "   → Go to https://neon.tech and create a free account"
echo "   → Create a new project"
echo "   → Copy the connection string"
echo ""
echo "2. Vercel Postgres (If available in your dashboard)"
echo "   → Go to Vercel Dashboard → Storage → Create Database"
echo ""
echo "3. Other PostgreSQL (Supabase, Railway, etc.)"
echo "   → Create database and get connection string"
echo ""

read -p "Do you have a DATABASE_URL connection string ready? (y/n): " has_url

if [ "$has_url" != "y" ] && [ "$has_url" != "Y" ]; then
    echo ""
    echo "📋 Please create a database first:"
    echo ""
    echo "   Option 1 (Recommended): Neon Postgres"
    echo "   → https://neon.tech (free tier available)"
    echo "   → See setup-neon-postgres.md for detailed guide"
    echo ""
    echo "   Option 2: Check if Vercel Postgres is available"
    echo "   → Vercel Dashboard → Storage → Create Database"
    echo ""
    exit 0
fi

echo ""
read -p "Paste your DATABASE_URL connection string: " db_url

if [ -z "$db_url" ]; then
    echo "❌ No connection string provided"
    exit 1
fi

echo ""
echo "🔐 Adding DATABASE_URL to Vercel environment variables..."
echo ""

# Add environment variable via Vercel CLI
echo "$db_url" | vercel env add DATABASE_URL production

echo ""
echo "✅ DATABASE_URL added to Production"
echo ""

read -p "Add to Preview and Development environments too? (y/n): " add_all

if [ "$add_all" == "y" ] || [ "$add_all" == "Y" ]; then
    echo "$db_url" | vercel env add DATABASE_URL preview
    echo "$db_url" | vercel env add DATABASE_URL development
    echo "✅ Added to all environments"
fi

echo ""
echo "📥 Pulling environment variables..."
vercel env pull .env.production

echo ""
echo "🚀 Running database migrations..."
echo ""

export $(grep DATABASE_URL .env.production | xargs)

if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL not found in .env.production"
    exit 1
fi

cd backend
echo "Running migrations..."
DATABASE_URL="$DATABASE_URL" npm run migrate

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  - Your database is ready to use"
echo "  - Deploy to Vercel: git push"
echo "  - Optional: Seed demo data: cd backend && DATABASE_URL=\"\$DATABASE_URL\" npm run seed"
echo ""












