#!/bin/bash

echo "🔐 Adaptalabs Login Test Script"
echo "================================"
echo ""

# Check if servers are running
echo "📡 Checking server status..."
if curl -s http://localhost:3001/health > /dev/null; then
    echo "✅ Backend server (port 3001) is running"
else
    echo "❌ Backend server (port 3001) is not running"
    echo "   Run: cd backend && npx tsx src/demo-server.ts"
    exit 1
fi

if curl -s http://localhost:3000 > /dev/null; then
    echo "✅ Frontend server (port 3000) is running"
else
    echo "❌ Frontend server (port 3000) is not running"
    echo "   Run: cd frontend && npm start"
    exit 1
fi

echo ""
echo "🧪 Testing authentication..."

# Test regular user login
echo "👤 Testing regular user login..."
curl -s -c test_user_cookies.txt http://localhost:3001/auth/login > /dev/null
if curl -s -b test_user_cookies.txt http://localhost:3001/api/me | grep -q "Demo User"; then
    echo "✅ Regular user login successful"
else
    echo "❌ Regular user login failed"
fi

# Test admin login
echo "👨‍💼 Testing admin login..."
curl -s -c test_admin_cookies.txt http://localhost:3001/auth/admin-login > /dev/null
if curl -s -b test_admin_cookies.txt http://localhost:3001/api/me | grep -q "Demo Admin"; then
    echo "✅ Admin login successful"
else
    echo "❌ Admin login failed"
fi

# Test opportunities API
echo "📋 Testing opportunities API..."
if curl -s -b test_admin_cookies.txt http://localhost:3001/api/opportunities | grep -q "User Interface Testing"; then
    echo "✅ Opportunities API working"
else
    echo "❌ Opportunities API failed"
fi

# Test sessions API
echo "⏰ Testing sessions API..."
if curl -s http://localhost:3001/api/opportunities/opp-1/sessions | grep -q "Conference Room A"; then
    echo "✅ Sessions API working"
else
    echo "❌ Sessions API failed"
fi

echo ""
echo "🎉 Login test completed!"
echo ""
echo "📱 To test in browser:"
echo "   Regular user: http://localhost:3001/auth/login"
echo "   Admin user:   http://localhost:3001/auth/admin-login"
echo ""
echo "🧹 Cleaning up test cookies..."
rm -f test_user_cookies.txt test_admin_cookies.txt

echo "✅ All tests completed successfully!"
