#!/bin/bash

# Adaptalabs Development Startup Script
# This script provides multiple ways to start the development environment

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if a port is in use
check_port() {
    local port=$1
    if lsof -i :$port >/dev/null 2>&1; then
        return 0  # Port is in use
    else
        return 1  # Port is free
    fi
}

# Function to kill processes on specific ports
kill_port() {
    local port=$1
    local pids=$(lsof -ti :$port)
    if [ ! -z "$pids" ]; then
        print_warning "Killing processes on port $port: $pids"
        echo $pids | xargs kill -9 2>/dev/null || true
    fi
}

# Function to clean up macOS extended attributes
cleanup_macos_attributes() {
    print_status "Cleaning up macOS extended attributes..."
    find . -name "._*" -type f -delete 2>/dev/null || true
    print_success "macOS extended attributes cleaned up"
}

# Function to start with Docker
start_docker() {
    print_status "Starting services with Docker..."
    
    # Clean up macOS attributes first
    cleanup_macos_attributes
    
    # Check if Docker is running
    if ! docker info >/dev/null 2>&1; then
        print_error "Docker is not running. Please start Docker Desktop first."
        exit 1
    fi
    
    # Use development compose file
    docker-compose -f docker-compose.dev.yml up -d
    
    print_success "Docker services started!"
    print_status "Frontend: http://localhost:3003"
    print_status "Backend: http://localhost:3002"
    print_status "Database: localhost:5433"
}

# Function to start with npm (development mode)
start_npm() {
    print_status "Starting services with npm (development mode)..."
    
    # Check if ports are available
    if check_port 3000; then
        print_warning "Port 3000 is in use. Attempting to free it..."
        kill_port 3000
        sleep 2
    fi
    
    if check_port 3001; then
        print_warning "Port 3001 is in use. Attempting to free it..."
        kill_port 3001
        sleep 2
    fi
    
    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        print_status "Installing root dependencies..."
        npm install
    fi
    
    if [ ! -d "backend/node_modules" ]; then
        print_status "Installing backend dependencies..."
        cd backend && npm install && cd ..
    fi
    
    if [ ! -d "frontend/node_modules" ]; then
        print_status "Installing frontend dependencies..."
        cd frontend && npm install && cd ..
    fi
    
    # Start services
    print_status "Starting development servers..."
    npm run dev:all &
    
    # Wait a moment for services to start
    sleep 5
    
    # Check if services are running
    if check_port 3000 && check_port 3001; then
        print_success "Development servers started!"
        print_status "Frontend: http://localhost:3000"
        print_status "Backend: http://localhost:3001"
    else
        print_error "Failed to start development servers"
        exit 1
    fi
}

# Function to stop all services
stop_services() {
    print_status "Stopping all services..."
    
    # Stop Docker services
    docker-compose -f docker-compose.dev.yml down 2>/dev/null || true
    docker-compose down 2>/dev/null || true
    
    # Kill npm processes
    pkill -f "npm run dev:all" 2>/dev/null || true
    pkill -f "react-scripts start" 2>/dev/null || true
    pkill -f "nodemon" 2>/dev/null || true
    
    # Kill processes on ports
    kill_port 3000
    kill_port 3001
    kill_port 3002
    kill_port 3003
    kill_port 5432
    kill_port 5433
    
    print_success "All services stopped"
}

# Function to show status
show_status() {
    print_status "Service Status:"
    echo ""
    
    # Check Docker services
    if docker-compose -f docker-compose.dev.yml ps | grep -q "Up"; then
        print_success "Docker services are running"
        docker-compose -f docker-compose.dev.yml ps
    else
        print_warning "No Docker services running"
    fi
    
    echo ""
    
    # Check npm services
    if check_port 3000; then
        print_success "Frontend (npm) running on port 3000"
    else
        print_warning "Frontend (npm) not running"
    fi
    
    if check_port 3001; then
        print_success "Backend (npm) running on port 3001"
    else
        print_warning "Backend (npm) not running"
    fi
}

# Function to show help
show_help() {
    echo "Adaptalabs Development Startup Script"
    echo ""
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  docker    Start services using Docker Compose"
    echo "  npm       Start services using npm (development mode)"
    echo "  stop      Stop all running services"
    echo "  status    Show status of all services"
    echo "  clean     Clean up macOS extended attributes"
    echo "  help      Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 docker    # Start with Docker"
    echo "  $0 npm       # Start with npm"
    echo "  $0 stop      # Stop all services"
    echo "  $0 status    # Check service status"
}

# Main script logic
case "${1:-help}" in
    "docker")
        start_docker
        ;;
    "npm")
        start_npm
        ;;
    "stop")
        stop_services
        ;;
    "status")
        show_status
        ;;
    "clean")
        cleanup_macos_attributes
        ;;
    "help"|"-h"|"--help")
        show_help
        ;;
    *)
        print_error "Unknown command: $1"
        show_help
        exit 1
        ;;
esac



























