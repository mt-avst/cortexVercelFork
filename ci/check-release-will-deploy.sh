#!/bin/sh
# Fail a main pipeline that has changed deployed code but will not deploy it.
#
# WHY THIS EXISTS. Cortex deploys by release tag: semantic-release cuts a
# version, that becomes a new image tag, ArgoCD rolls it. semantic-release's
# default rules only release `feat`, `fix`, `perf`, `revert` and breaking
# changes - so a merge squashed as `refactor:`, `docs:`, `chore:`, `style:`,
# `test:` or `build:` cuts NO version and therefore NEVER DEPLOYS, while every
# job in the pipeline reports success.
#
# That happened on 2026-08-13: MR !94, a user-visible copy rename squashed as
# `refactor:`, sat merged and undeployed with a fully green pipeline. It looked
# exactly like a platform stall and cost an hour to diagnose. Nothing in the
# pipeline said a word, because from CI's point of view nothing was wrong.
#
# The signal is `SEMREL_INFO_NEXT_VERSION`, published as a dotenv artifact by
# the `semantic-release-info` job. That variable is written by semantic-release's
# verifyRelease hook, which only runs WHEN THERE IS A RELEASE - so its absence
# means "no version will be cut", which means "this will not deploy".
#
# A `docs:`-only merge legitimately cuts no version, and that is correct: there
# is nothing to ship. So an empty version alone is not an error. It is only an
# error when the merge ALSO changed code that is built into the deployed image.
#
# Inputs (environment):
#   SEMREL_INFO_NEXT_VERSION  next version, empty when no release is due
#   SEMREL_INFO_LAST_VERSION  last released version; used as the diff base
#   DEPLOY_PATHS              override the deployable path list (testing)
# Args:
#   $1  optional diff base, overriding the last-version tag (testing)

set -eu

# Paths whose contents end up inside a built image or the deployment manifests.
# `docs/`, `e2e/`, `*.md` and `.gitlab-ci.yml` are deliberately NOT here: a
# change confined to them genuinely does not need to deploy.
DEPLOY_PATHS="${DEPLOY_PATHS:-backend frontend shared .kubera}"

# Both variables come from the same dotenv artifact. LAST is written on every
# run of `semantic-release-info` (its analyzeCommits hook always fires), NEXT
# only when a release is due. So both being empty means the artifact never
# arrived - not that a release is missing. Say so and pass: a check that cries
# wolf when its own input is absent gets switched off, and then it protects
# nothing.
if [ -z "${SEMREL_INFO_LAST_VERSION:-}" ] && [ -z "${SEMREL_INFO_NEXT_VERSION:-}" ]; then
  echo "WARN: no semantic-release info available (dotenv artifact missing or empty)."
  echo "      Skipping the stranded-merge check rather than guessing."
  exit 0
fi

if [ -n "${SEMREL_INFO_NEXT_VERSION:-}" ]; then
  echo "OK: release ${SEMREL_INFO_NEXT_VERSION} will be cut, so this merge will deploy."
  exit 0
fi

# No release is due. Establish what this merge actually changed, measured from
# the last thing that shipped rather than from the previous commit - if several
# non-releasing merges stack up, every one of them is still stranded.
base="${1:-}"
if [ -z "$base" ]; then
  if [ -n "${SEMREL_INFO_LAST_VERSION:-}" ] && git rev-parse -q --verify "refs/tags/${SEMREL_INFO_LAST_VERSION}" >/dev/null 2>&1; then
    base="refs/tags/${SEMREL_INFO_LAST_VERSION}"
  else
    # No usable tag: fall back to this merge alone. First parent, so the base is
    # the previous tip of main rather than the merged branch.
    base="HEAD^"
  fi
fi

if ! git rev-parse -q --verify "$base" >/dev/null 2>&1; then
  echo "WARN: cannot resolve diff base '$base'; skipping the stranded-merge check."
  echo "      (a shallow clone will do this - the job sets GIT_DEPTH: 0 to avoid it)"
  exit 0
fi

echo "No release is due. Checking whether deployed code changed since ${base}..."

# shellcheck disable=SC2086
changed=$(git diff --name-only "$base" HEAD -- $DEPLOY_PATHS)

if [ -z "$changed" ]; then
  echo "OK: no release, but nothing under [${DEPLOY_PATHS}] changed either."
  echo "    Docs-only or CI-only work does not need to deploy."
  exit 0
fi

cat <<MESSAGE

STRANDED MERGE: deployed code changed, but no release will be cut.

These files are built into the running image, and are now on main WITHOUT a
version to ship them. ArgoCD has nothing new to sync, so the change will not
reach the environment - and every other job in this pipeline will still pass.

$(echo "$changed" | sed 's/^/  /')

CAUSE: the commit type on main since ${base} is one semantic-release does not
release. It releases feat, fix, perf, revert and breaking changes only;
refactor, docs, chore, style, test and build cut nothing.

FIX: merge any follow-up typed feat: or fix: - the image is built from main's
whole tree, so the stranded change ships with it. No repair commit is needed,
and re-merging this work is not necessary.

To confirm the diagnosis yourself: git tag --points-at <merge-sha>
An empty result means it will never ship. Trust that, not the pipeline.

MESSAGE
exit 1
