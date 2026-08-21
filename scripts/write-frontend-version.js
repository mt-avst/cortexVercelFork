'use strict';

/**
 * Write `frontend/dist/version.json` after a frontend build.
 *
 * Run as part of `npm run build` rather than only in the Dockerfile, so the
 * file is an ordinary build artifact: it exists after any local build, is
 * served by `vite preview`, and can be checked without building an image.
 *
 * Deliberately does NOT fail the build when APP_COMMIT_SHA is absent or
 * malformed - it writes `unknown` instead. A local `npm run build` has no CI
 * variables and must not break, and a deploy that reports `unknown` is more
 * useful than one that never shipped: it says the pod rolled but the build
 * argument did not reach it. See scripts/lib/build-revision.js.
 */

const fs = require('node:fs');
const path = require('node:path');

const { resolveBuildRevision } = require('./lib/build-revision');

const OUTPUT_DIR = path.resolve(__dirname, '..', 'frontend', 'dist');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'version.json');

function main() {
  const revision = resolveBuildRevision(process.env.APP_COMMIT_SHA);

  if (!fs.existsSync(OUTPUT_DIR)) {
    // The build is what creates dist/. If it is missing, this script ran
    // without one, and writing the directory ourselves would leave a
    // version.json describing a build that does not exist.
    console.error(
      `[write-frontend-version] ${OUTPUT_DIR} does not exist - run the frontend build first.`
    );
    process.exit(1);
  }

  // JSON.stringify rather than a template string: revision is already
  // validated to be a commit sha, so this cannot currently emit anything
  // needing escaping, but building JSON by concatenation is how that stops
  // being true after the next edit.
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify({ revision })}\n`, 'utf8');
  console.log(`[write-frontend-version] wrote ${OUTPUT_FILE} (revision: ${revision})`);
}

main();
