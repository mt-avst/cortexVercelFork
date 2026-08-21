'use strict';

/**
 * Run with: node --test scripts/lib/build-revision.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveBuildRevision, UNKNOWN_REVISION } = require('./build-revision');

test('reports the commit the build was given', () => {
  assert.equal(
    resolveBuildRevision('e5feaf366a37f15f30e95cafcf9f03000f4640d3'),
    'e5feaf366a37f15f30e95cafcf9f03000f4640d3'
  );
});

test('accepts a short sha', () => {
  assert.equal(resolveBuildRevision('e5feaf3'), 'e5feaf3');
});

test('trims surrounding whitespace', () => {
  assert.equal(resolveBuildRevision('  e5feaf3\n'), 'e5feaf3');
});

// `unknown` rather than omitting the field or failing the build. An absent
// version.json is indistinguishable from an older deploy that predates it -
// which is the very question the file exists to answer - and a build that dies
// because a CI variable is missing would block every local `npm run build`.
test('reports unknown when the build argument never arrived', () => {
  assert.equal(resolveBuildRevision(undefined), UNKNOWN_REVISION);
  assert.equal(resolveBuildRevision(''), UNKNOWN_REVISION);
  assert.equal(resolveBuildRevision('   '), UNKNOWN_REVISION);
});

// The value is written into a file served unauthenticated from the public
// internet, and arrives from the build environment rather than this repository.
// Anything that is not a commit sha is refused rather than written through.
//
// These cases must stay in step with backend/src/utils/buildInfo.ts, which
// applies the same rule to APP_COMMIT_SHA at runtime. The two are deliberately
// separate implementations - one is a TypeScript runtime module, the other a
// CommonJS build script - so the rule is duplicated and must not drift.
for (const [label, value] of [
  ['a branch name', 'main'],
  ['an unexpanded variable', '$CI_COMMIT_SHA'],
  ['markup', '<script>alert(1)</script>'],
  ['a quote that would break the JSON', 'abc"def'],
  ['an over-long value', 'a'.repeat(41)],
  ['a too-short value', 'abc'],
  ['uppercase hex', 'E5FEAF366A37F15F30E95CAFCF9F03000F4640DA'],
]) {
  test(`refuses ${label} and reports unknown`, () => {
    assert.equal(resolveBuildRevision(value), UNKNOWN_REVISION);
  });
}
