#!/usr/bin/env node

/**
 * Copy shared types into frontend/src/shared before build
 * This is necessary because Create React App doesn't allow imports outside src/
 */

const fs = require('fs');
const path = require('path');

// Resolve paths relative to this script's location
const frontendDir = __dirname;
const rootDir = path.resolve(frontendDir, '..');
const sharedTypesPath = path.resolve(rootDir, 'shared', 'types', 'index.ts');
const sharedConstantsPath = path.resolve(rootDir, 'shared', 'constants', 'index.ts');
const destTypesPath = path.resolve(frontendDir, 'src', 'shared', 'types.ts');
const destConstantsPath = path.resolve(frontendDir, 'src', 'shared', 'constants.ts');

// Ensure shared directory exists
const sharedDir = path.resolve(frontendDir, 'src', 'shared');
if (!fs.existsSync(sharedDir)) {
  fs.mkdirSync(sharedDir, { recursive: true });
}

// Copy types file
if (fs.existsSync(sharedTypesPath)) {
  fs.copyFileSync(sharedTypesPath, destTypesPath);
  console.log('✓ Copied shared/types/index.ts to src/shared/types.ts');
} else {
  console.error('✗ Error: shared/types/index.ts not found at', sharedTypesPath);
  console.error('  Resolved from:', frontendDir);
  console.error('  Root dir:', rootDir);
  process.exit(1);
}

// Copy constants file
if (fs.existsSync(sharedConstantsPath)) {
  fs.copyFileSync(sharedConstantsPath, destConstantsPath);
  console.log('✓ Copied shared/constants/index.ts to src/shared/constants.ts');
} else {
  console.warn('⚠ Warning: shared/constants/index.ts not found, but continuing...');
}

console.log('✓ Shared types copied successfully');
