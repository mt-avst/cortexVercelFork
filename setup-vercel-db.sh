#!/bin/bash

# Vercel Postgres Database Setup Script
# This script helps set up Vercel Postgres and run migrations

set -e

echo "🚀 Vercel Postgres Setup"
echo "========================"
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

echo "📋 Next Steps (Manual):"
echo "----------------------"
echo ""
echo "1. Create Vercel Postgres Database:"
echo "   - Go to: https://vercel.com/dashboard"
echo "   - Select project: adapta-labs-p62q"
echo "   - Go to 'Storage' tab"
echo "   - Click 'Create Database' → Select 'Postgres'"
echo "   - Name it: adaptalabs-db"
echo "   - Choose a region"
echo "   - Click 'Create'"
echo ""
echo "2. Get the connection string:"
echo "   - In the Storage tab, click your database"
echo "   - Go to '.env.local' tab"
echo "   - Copy the POSTGRES_URL value"
echo ""
echo "3. Set environment variable:"
echo "   Run: vercel env add DATABASE_URL"
echo "   Paste the POSTGRES_URL value when prompted"
echo "   Select all environments (Production, Preview, Development)"
echo ""
echo "4. Run this script again with --migrate to run migrations"
echo ""
echo "Or run the migration manually:"
echo "  vercel env pull .env.production"
echo "  cd backend"
echo "  DATABASE_URL=\$(grep DATABASE_URL ../.env.production | cut -d '=' -f2-) npm run migrate"

if [ "$1" == "--migrate" ]; then
    echo ""
    echo "🔄 Running migrations..."
    
    # Pull environment variables
    if [ ! -f .env.production ]; then
        echo "📥 Pulling environment variables..."
        vercel env pull .env.production
    fi
    
    # Check if DATABASE_URL is set
    if ! grep -q "DATABASE_URL" .env.production 2>/dev/null; then
        echo "❌ DATABASE_URL not found in .env.production"
        echo "Please create the database and set DATABASE_URL first"
        exit 1
    fi
    
    # Source the env file and run migrations
    echo "🚀 Running database migrations..."
    export $(grep -v '^#' .env.production | grep DATABASE_URL | xargs)
    
    if [ -z "$DATABASE_URL" ]; then
        echo "❌ DATABASE_URL is not set"
        exit 1
    fi
    
    cd backend
    echo "Running migrations with DATABASE_URL..."
    DATABASE_URL="$DATABASE_URL" npm run migrate
    
    echo ""
    echo "✅ Migrations completed!"
    echo ""
    echo "Next: Seed the database (optional)"
    echo "  cd backend && DATABASE_URL=\"\$DATABASE_URL\" npm run seed"
fi




