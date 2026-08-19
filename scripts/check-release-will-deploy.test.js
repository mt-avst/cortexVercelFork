'use strict';

/**
 * Run with: node --test scripts/check-release-will-deploy.test.js
 *
 * The stranded-merge detector, driven as the real shell script against real
 * git repositories. It had no test at all, which is how a gap in it stayed
 * invisible: it globs whole directories, so every test file under backend/ or
 * frontend/ counted as deployed code, and a test-only merge typed `test:` -
 * now a common shape, since CI runs the suites - failed a main pipeline for a
 * change that ships nothing.
 *
 * The cases that matter are the two directions. Excluding test files must not
 * also excuse a real source change, and the mixed case must still fail:
 * a weakened detector is worse than none, because it is trusted.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'ci', 'check-release-will-deploy.sh');

/**
 * These tests need a real git. The node alpine image used by CI does not ship
 * one, and the raw failure is `spawnSync git ENOENT` on all six cases at once,
 * which reads as six broken tests rather than one missing binary. Fail once,
 * clearly, instead - and fail rather than skip, because a suite that quietly
 * skips itself in CI is indistinguishable from one that passes.
 */
function requireGit() {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(
      'git is not available on PATH, so the stranded-merge detector cannot be ' +
      'tested. The CI job installs it with `apk add --no-cache git`; add that ' +
      'to any new job that runs this file.'
    );
  }
}

/** A throwaway repo with a base commit, then `files` changed on top. */
function repoWith(files) {
  requireGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crwd-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.mkdirSync(path.join(dir, 'frontend', 'src', '__tests__'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'backend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').toString().trim();

  for (const [file, body] of Object.entries(files)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  git('add', '-A');
  git('commit', '-qm', 'change');
  return { dir, base };
}

/** Runs the detector in "no release is due" mode, which is when it bites. */
function run(files) {
  const { dir, base } = repoWith(files);
  const res = spawnSync('sh', [SCRIPT, base], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      SEMREL_INFO_LAST_VERSION: '',
      SEMREL_INFO_NEXT_VERSION: '',
      // Both empty means "artifact never arrived"; one set means "no release".
      DEPLOY_PATHS: 'backend frontend shared .kubera'
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

/** As above but with LAST set, so the script proceeds to the diff. */
function runNoRelease(files) {
  const { dir, base } = repoWith(files);
  const res = spawnSync('sh', [SCRIPT, base], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      SEMREL_INFO_LAST_VERSION: '9.9.9',
      SEMREL_INFO_NEXT_VERSION: '',
      DEPLOY_PATHS: 'backend frontend shared .kubera'
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

describe('check-release-will-deploy', () => {
  test('passes when only test files changed under a deploy path', () => {
    const res = runNoRelease({
      'frontend/src/__tests__/thing.test.tsx': 'export {};\n',
      'frontend/src/components/__tests__/other.test.ts': 'export {};\n',
      'backend/src/thing.spec.ts': 'export {};\n',
      'frontend/tsconfig.test.json': '{}\n'
    });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /test-only/);
  });

  test('still fails when a real source file changed', () => {
    const res = runNoRelease({ 'frontend/src/App.tsx': 'export default null;\n' });
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /STRANDED MERGE/);
  });

  test('still fails when tests AND source changed together', () => {
    // The dangerous case: a real change hidden among test files.
    const res = runNoRelease({
      'frontend/src/__tests__/thing.test.tsx': 'export {};\n',
      'backend/src/routes/real.ts': 'export const x = 1;\n'
    });
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /STRANDED MERGE/);
    assert.match(res.stdout, /backend\/src\/routes\/real\.ts/);
    // The test file must not be listed as stranded, only the source file.
    assert.doesNotMatch(res.stdout, /thing\.test\.tsx/);
  });

  test('a manifest change is NOT excused, because it can move the image', () => {
    // package.json cannot be distinguished from a dependency bump by this
    // script, so it must keep failing. This is why !172 failed and why this
    // change would not have prevented it.
    const res = runNoRelease({ 'frontend/package.json': '{"name":"x"}\n' });
    assert.strictEqual(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /STRANDED MERGE/);
  });

  test('passes when nothing under a deploy path changed at all', () => {
    const res = runNoRelease({ 'docs/thing.md': 'hello\n' });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /nothing under/);
  });

  test('passes without crying wolf when its own inputs are missing', () => {
    const res = run({ 'frontend/src/App.tsx': 'export default null;\n' });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  });
});
