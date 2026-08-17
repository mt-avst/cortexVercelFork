#!/usr/bin/env node

/**
 * Copy shared types, constants, and config into frontend/src/shared before build
 * This is necessary because the bundler cannot import from outside frontend/src/,
 * so the committed src/shared copies are the actual bundle input.
 *
 * Files copied:
 * - shared/types/index.ts → src/shared/types.ts
 * - shared/constants/index.ts → src/shared/constants.ts
 * - shared/config/environment.ts → src/shared/config/environment.ts
 * - shared/firsthand/ (whole tree) → src/shared/firsthand/
 *
 * This is an ES module (frontend/package.json declares "type": "module").
 * Run it deliberately with `node copy-shared-types.js` when a shared source
 * changes; the frontend build does not invoke it, so re-run and commit the
 * regenerated src/shared copies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Auto-generated header to add to copied files.
//
// NOT stamped with a generation timestamp, deliberately. A timestamp makes
// every regeneration rewrite all nine files whether or not their content
// changed, which buries a real content change in noise and makes it impossible
// to tell a stale copy from a fresh one by looking. Without it, re-running this
// script is a no-op unless a shared source actually changed - which is what
// `shared-copies-are-current.test.ts` relies on.
//
// The old header also claimed the copy happened "during the build process". It
// does not: nothing invokes this script - not `npm run build`, not CI. An edit
// to shared/ therefore did NOT reach the frontend bundle, and the file that
// said otherwise was the reason nobody noticed.
const AUTO_GENERATED_HEADER = `/**
 * AUTO-GENERATED FILE - DO NOT EDIT DIRECTLY
 *
 * Copied from the shared/ directory by frontend/copy-shared-types.js. Nothing
 * runs that script for you: edit the source under shared/, then run
 * \`node copy-shared-types.js\` from frontend/ and commit the result.
 *
 * Source: See copy-shared-types.js for the source path
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

// Directory trees copied wholesale, preserving their internal structure and
// relative imports. The FirstHand contract is a small tree — contract.ts imports
// its sibling url-safety.ts and study-input.ts imports contract.ts — so the whole
// shared/firsthand/ directory must be copied together, not file by file, or the
// sibling imports would dangle in the frontend copy.
const directoriesToCopy = [
  {
    source: path.resolve(rootDir, 'shared', 'firsthand'),
    dest: path.resolve(frontendDir, 'src', 'shared', 'firsthand'),
    name: 'firsthand',
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

// Recursively copy a directory of .ts files, applying the auto-generated header
// to each and preserving the tree structure under the destination.
const copyDirWithHeader = (sourceDir, destDir, name) => {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirWithHeader(sourcePath, destPath, `${name}/${entry.name}`);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      copyFileWithHeader(sourcePath, destPath, `${name}/${entry.name}`);
    }
  }
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

// Process directory trees
for (const dir of directoriesToCopy) {
  if (fs.existsSync(dir.source)) {
    try {
      copyDirWithHeader(dir.source, dir.dest, dir.name);
    } catch (error) {
      console.error(`✗ Error copying ${dir.name}:`, error.message);
      if (dir.required) {
        hasErrors = true;
      }
    }
  } else {
    if (dir.required) {
      console.error(`✗ Error: shared/${dir.name} not found at`, dir.source);
      hasErrors = true;
    } else {
      console.warn(`⚠ Warning: shared/${dir.name} not found, skipping...`);
    }
  }
}

if (hasErrors) {
  console.error('\n✗ Some required files could not be copied');
  process.exit(1);
}

console.log('\n✓ All shared files copied successfully');
