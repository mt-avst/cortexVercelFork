#!/usr/bin/env node

/**
 * Copy shared types, constants, and config into frontend/src/shared before build
 * This is necessary because Create React App doesn't allow imports outside src/
 * 
 * Files copied:
 * - shared/types/index.ts → src/shared/types.ts
 * - shared/constants/index.ts → src/shared/constants.ts
 * - shared/config/environment.ts → src/shared/config/environment.ts
 */

const fs = require('fs');
const path = require('path');

// Auto-generated header to add to copied files
const AUTO_GENERATED_HEADER = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 * 
 * This file is automatically copied from the shared/ directory during the build process.
 * Any changes should be made to the source file in the shared/ directory.
 * 
 * Source: See copy-shared-types.js for the source path
 * Generated: ${new Date().toISOString()}
 */

`;

// Resolve paths relative to this script's location
const frontendDir = __dirname;
const rootDir = path.resolve(frontendDir, '..');

// Define source and destination mappings
const filesToCopy = [
  {
    source: path.resolve(rootDir, 'shared', 'types', 'index.ts'),
    dest: path.resolve(frontendDir, 'src', 'shared', 'types.ts'),
    name: 'types',
    required: true,
  },
  {
    source: path.resolve(rootDir, 'shared', 'constants', 'index.ts'),
    dest: path.resolve(frontendDir, 'src', 'shared', 'constants.ts'),
    name: 'constants',
    required: false,
  },
  {
    source: path.resolve(rootDir, 'shared', 'config', 'environment.ts'),
    dest: path.resolve(frontendDir, 'src', 'shared', 'config', 'environment.ts'),
    name: 'config/environment',
    required: false,
  },
  {
    source: path.resolve(rootDir, 'shared', 'test-utils', 'index.ts'),
    dest: path.resolve(frontendDir, 'src', 'shared', 'test-utils.ts'),
    name: 'test-utils',
    required: false,
  },
];

// Ensure directories exist
const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// Copy file with auto-generated header
const copyFileWithHeader = (source, dest, name) => {
  const content = fs.readFileSync(source, 'utf8');
  
  // Check if file already has an auto-generated header (don't double-add)
  const hasHeader = content.includes('AUTO-GENERATED FILE');
  
  const finalContent = hasHeader ? content : AUTO_GENERATED_HEADER + content;
  
  ensureDir(dest);
  fs.writeFileSync(dest, finalContent, 'utf8');
  console.log(`✓ Copied shared/${name} to src/shared/${name.includes('/') ? name : name + '.ts'}`);
};

// Process all files
let hasErrors = false;

for (const file of filesToCopy) {
  if (fs.existsSync(file.source)) {
    try {
      copyFileWithHeader(file.source, file.dest, file.name);
    } catch (error) {
      console.error(`✗ Error copying ${file.name}:`, error.message);
      if (file.required) {
        hasErrors = true;
      }
    }
  } else {
    if (file.required) {
      console.error(`✗ Error: shared/${file.name} not found at`, file.source);
      hasErrors = true;
    } else {
      console.warn(`⚠ Warning: shared/${file.name} not found, skipping...`);
    }
  }
}

if (hasErrors) {
  console.error('\n✗ Some required files could not be copied');
  process.exit(1);
}

console.log('\n✓ All shared files copied successfully');
