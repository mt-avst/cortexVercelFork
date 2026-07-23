#!/bin/bash
# Run accessibility tests against production

export BASE_URL=https://adaptalabs.kubera-playground.adaptavist.net
npx playwright test e2e/accessibility.test.ts --config=playwright.prod.config.ts --reporter=list



