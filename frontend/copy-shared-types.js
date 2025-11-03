#!/usr/bin/env node

/**
 * Copy shared types into frontend/src/shared before build
 * This is necessary because Create React App doesn't allow imports outside src/
 */

const fs = require('fs');
const path = require('path');

const sharedTypesPath = path.join(__dirname, '..', '..', 'shared', 'types', 'index.ts');
const sharedConstantsPath = path.join(__dirname, '..', '..', 'shared', 'constants', 'index.ts');
const destTypesPath = path.join(__dirname, 'src', 'shared', 'types.ts');
const destConstantsPath = path.join(__dirname, 'src', 'shared', 'constants.ts');

// Ensure shared directory exists
const sharedDir = path.join(__dirname, 'src', 'shared');
if (!fs.existsSync(sharedDir)) {
  fs.mkdirSync(sharedDir, { recursive: true });
}

// Copy types file
if (fs.existsSync(sharedTypesPath)) {
  fs.copyFileSync(sharedTypesPath, destTypesPath);
  console.log('✓ Copied shared/types/index.ts to src/shared/types.ts');
} else {
  console.error('✗ Error: shared/types/index.ts not found at', sharedTypesPath);
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

