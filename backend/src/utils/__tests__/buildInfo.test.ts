import { describe, it, expect, afterEach } from '@jest/globals';

import { getBuildRevision } from '../buildInfo';

const ORIGINAL = process.env.APP_COMMIT_SHA;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.APP_COMMIT_SHA;
  } else {
    process.env.APP_COMMIT_SHA = ORIGINAL;
  }
});

describe('getBuildRevision', () => {
  it('reports the commit the image was built from', () => {
    process.env.APP_COMMIT_SHA = '79e9ac615137ef892b5824bfa2b9ca8b32150dad';

    expect(getBuildRevision()).toBe('79e9ac615137ef892b5824bfa2b9ca8b32150dad');
  });

  it('accepts a short sha', () => {
    process.env.APP_COMMIT_SHA = '79e9ac6';

    expect(getBuildRevision()).toBe('79e9ac6');
  });

  // 'unknown' rather than omitting the field. An absent field cannot be told
  // apart from an older build that predates this endpoint, which is exactly
  // the question the field exists to answer; 'unknown' says "this build
  // reports a revision and the build argument did not reach it".
  it('reports unknown when the build argument never reached the image', () => {
    delete process.env.APP_COMMIT_SHA;

    expect(getBuildRevision()).toBe('unknown');
  });

  it('reports unknown for an empty or whitespace value', () => {
    process.env.APP_COMMIT_SHA = '   ';

    expect(getBuildRevision()).toBe('unknown');
  });

  // The value is echoed on an endpoint reachable unauthenticated from the
  // public internet, and it arrives from the build environment rather than
  // from this repository. Anything that is not a commit sha is refused rather
  // than passed through, so a mis-set build argument cannot put arbitrary text
  // into a public response body.
  it.each([
    ['a branch name', 'main'],
    ['an unexpanded variable', '$CI_COMMIT_SHA'],
    ['markup', '<script>alert(1)</script>'],
    ['an over-long value', 'a'.repeat(41)],
    ['a too-short value', 'abc'],
    ['uppercase hex', '79E9AC615137EF892B5824BFA2B9CA8B32150DAD'],
  ])('refuses %s and reports unknown', (_label, value) => {
    process.env.APP_COMMIT_SHA = value;

    expect(getBuildRevision()).toBe('unknown');
  });
});
