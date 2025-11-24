#!/bin/bash
# Run accessibility tests against production

export BASE_URL=https://adapta-labs-p62q.vercel.app
npx playwright test e2e/accessibility.test.ts --config=playwright.prod.config.ts --reporter=list



