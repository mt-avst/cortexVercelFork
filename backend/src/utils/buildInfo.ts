/**
 * Which build of this application is running.
 *
 * WHY THIS EXISTS
 * Nothing the deployed backend served identified its own build. `/api/health`
 * answered `{status, database, databaseLatencyMs, timestamp}`, none of which
 * changes between releases, and there was no other unauthenticated surface - so
 * "has my fix actually rolled out?" could only be answered by inference from a
 * green pipeline plus a guess at the ArgoCD lag. That inference was wrong at
 * least once, and it is the wrong shape of answer for a question with a fact
 * behind it.
 *
 * WHY THE COMMIT AND NOT THE RELEASE VERSION
 * The release version is not knowable when the image is built. Cortex builds
 * its images on the main-branch pipeline and only then runs semantic-release,
 * which cuts the tag afterwards - so at `docker build` time `CI_COMMIT_REF_NAME`
 * is `main`, not `7.49.3`. Baking a "version" would bake the branch name.
 *
 * The commit sha IS knowable at that moment, is stable across the snapshot and
 * release images (both are built from the same commit), and answers the
 * question more precisely than a version does: a released version spans a range
 * of commits, whereas `git merge-base --is-ancestor <my-commit> <reported>`
 * settles whether one specific change is deployed. `git tag --contains <sha>`
 * recovers the version from it when that is what is wanted.
 *
 * Supplied as APP_COMMIT_SHA, which api/index.js copies from Vercel's
 * VERCEL_GIT_COMMIT_SHA (it was the Dockerfile build argument on Kubera).
 */

/**
 * A git commit sha and nothing else.
 *
 * The value arrives from the build environment rather than from this
 * repository, and is echoed on an endpoint reachable unauthenticated from the
 * public internet. Validating the shape rather than passing the string through
 * means a mis-set or unexpanded build argument - `$CI_COMMIT_SHA`, a branch
 * name, an accidental multi-line value - reports `unknown` instead of putting
 * arbitrary build-environment text into a public response body.
 *
 * Lowercase only, because that is what git and every CI variable produce; an
 * uppercase value did not come from where this is documented to come from.
 */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

export const UNKNOWN_REVISION = 'unknown';

/**
 * Read per call rather than captured at module load so that a test can set the
 * variable without resetting the module registry. The value does not change
 * over a process's life in any real deployment - it is baked into the image -
 * so this costs an env lookup and buys testability.
 */
export function getBuildRevision(): string {
  const raw = process.env.APP_COMMIT_SHA?.trim();

  if (!raw || !COMMIT_SHA.test(raw)) {
    return UNKNOWN_REVISION;
  }

  return raw;
}
