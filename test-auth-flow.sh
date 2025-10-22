#!/bin/bash

echo "Testing authentication flow..."
echo ""

# Test 1: Login and get session cookie
echo "1. Logging in..."
curl -s -c cookies.txt -L http://localhost:3001/auth/login > /dev/null
echo "   ✓ Login completed"

# Test 2: Check cookies
echo "2. Checking cookies..."
cat cookies.txt | grep adaptalabs_session
echo ""

# Test 3: Make API call with cookies from port 3001
echo "3. Testing API call from backend (3001)..."
curl -s -b cookies.txt http://localhost:3001/api/me | jq -r '.name // "ERROR: " + .error'
echo ""

# Test 4: Make API call with cookies from port 3000 (simulating frontend)
echo "4. Testing API call from frontend origin (3000)..."
curl -s -b cookies.txt -H "Origin: http://localhost:3000" http://localhost:3001/api/me | jq -r '.name // "ERROR: " + .error'
echo ""

# Test 5: Check if cookie works across ports
echo "5. Checking cookie domain..."
cat cookies.txt | grep -E "(localhost|\.localhost)" | awk '{print "   Domain: " $1}'

# Cleanup
rm -f cookies.txt

echo ""
echo "Test complete!"

