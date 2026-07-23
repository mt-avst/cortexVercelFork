#!/bin/bash

# Alpha Testing Script
# Runs end-to-end tests and generates a test report

echo "🧪 AdaptaLabs Alpha Testing - End-to-End Test Runner"
echo "=================================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if Playwright is installed
if ! command -v npx &> /dev/null; then
    echo -e "${RED}❌ npx not found. Please install Node.js and npm.${NC}"
    exit 1
fi

# Check if Playwright browsers are installed
echo "📦 Checking Playwright installation..."
if ! npx playwright --version &> /dev/null; then
    echo -e "${YELLOW}⚠️  Playwright not found. Installing...${NC}"
    npm install
    npx playwright install
fi

# Set production URL
PRODUCTION_URL="${PRODUCTION_URL:-https://adaptalabs.kubera-playground.adaptavist.net}"
echo "🌐 Testing against: $PRODUCTION_URL"
echo ""

# Create test results directory
mkdir -p test-results/alpha-testing
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_DIR="test-results/alpha-testing/$TIMESTAMP"
mkdir -p "$REPORT_DIR"

echo "📋 Running Critical User Flow Tests..."
echo ""

# Run Playwright tests
npx playwright test \
    --config=playwright.config.ts \
    --project=chromium \
    --reporter=html,list \
    --output-dir="$REPORT_DIR" \
    e2e/critical-flows.test.ts

TEST_EXIT_CODE=$?

echo ""
echo "=================================================="

if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed!${NC}"
    echo ""
    echo "📊 Test Report: $REPORT_DIR"
    echo "📄 HTML Report: npx playwright show-report $REPORT_DIR"
else
    echo -e "${RED}❌ Some tests failed. Check the report for details.${NC}"
    echo ""
    echo "📊 Test Report: $REPORT_DIR"
    echo "📄 HTML Report: npx playwright show-report $REPORT_DIR"
fi

echo ""
echo "📝 Next Steps:"
echo "1. Review the test report"
echo "2. Check END_TO_END_TESTING_CHECKLIST.md for manual tests"
echo "3. Document any issues found"
echo "4. Fix critical bugs before alpha launch"

exit $TEST_EXIT_CODE

