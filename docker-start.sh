#!/bin/bash

# Adaptalabs Recruitment App - Docker Quick Start Script

set -e

echo "🚀 Starting Adaptalabs Recruitment App with Docker..."

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null; then
    echo "❌ docker-compose is not installed. Please install Docker Compose and try again."
    exit 1
fi

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp docker.env.example .env
    echo "⚠️  Please edit .env file with your configuration before continuing."
    echo "   You can run this script again after configuring .env"
    exit 0
fi

# Build and start services
echo "🔨 Building and starting services..."
docker-compose up --build -d

# Wait for services to be ready
echo "⏳ Waiting for services to be ready..."
sleep 10

# Run database migrations
echo "🗄️  Running database migrations..."
docker-compose exec backend npm run migrate

# Seed admin users
echo "👥 Seeding admin users..."
docker-compose exec backend npm run seed

echo ""
echo "✅ Adaptalabs Recruitment App is now running!"
echo ""
echo "🌐 Frontend: http://localhost:3000"
echo "🔧 Backend API: http://localhost:3001"
echo "🗄️  PostgreSQL: localhost:5432"
echo ""
echo "📋 Useful commands:"
echo "   View logs: docker-compose logs -f"
echo "   Stop services: docker-compose down"
echo "   Restart: docker-compose restart"
echo ""
echo "🎉 Happy coding!"
