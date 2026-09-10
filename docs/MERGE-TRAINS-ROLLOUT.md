# Merge trains: staged rollout to stop re-running the suite on main

Status: **trial in progress.** Merge trains + merged-results pipelines were enabled on
2026-09-10; the dry-run (!394) passed - the train pipeline ran the suite green on
`refs/merge-requests/394/train` and cut no release. This document now lands **with** the
Part C change (MR !396) that drops the redundant `main` suite; the CI edit itself stays
gated on the trial holding (Part B) with `main` never reddening.

## Why

Every test job runs twice per change: once on the MR pipeline, then again on the squashed
commit on `main`.
The `main` re-run is not waste today - it is the only thing that tests the exact squashed tree
before it becomes `main`, and it has caught real breakage (main has reddened post-merge before).
Deleting it with nothing in its place trades a modest time saving for an unguarded `main`.

Merge trains move that integration check to *before* the merge: the train builds a pipeline for
`target + everything ahead in the train + this MR` - the exact commit that will become `main` -
and only merges it if green.
So `main` can no longer be reddened by a merge race, which is what makes it safe to stop the
`main` re-run.

Measured on the #117 main pipeline (378758): ~13.7 min wall, with the mutation-canary (~8.7 min)
as the `.pre` long pole gating the build.
The flake precondition was measured over MRs 364-392: 0 same-commit red->green reruns, one infra
runner stall in 29 MRs; the suite does not flake on identical code, so train churn from flaky
*tests* would be near-zero.

## What the trial needs: nothing in `.gitlab-ci.yml`

Verified against the merged CI config (`ci/lint` on `main`):

- The component `workflow:` ends in `- when: always` and blocks no `merge_request_event`
  pipeline, so merge-train pipelines (which are `merge_request_event` source) already run.
  It also already suppresses the duplicate branch pipeline when an MR is open.
  **Do not add a root `workflow:` - it would silently replace the component's.**
- The test jobs already carry `if: $CI_PIPELINE_SOURCE == "merge_request_event"`, which fires
  in merge-train pipelines too, so the suite runs in the train with no rule change.
- The kubera deploy extends `.delivery-policy`, which runs only on `RELEASE_REF` tags or
  `PROD_REF`/`INTEG_REF` - never on `merge_request_event`.
  So a merge-train pipeline builds a throwaway snapshot and runs the suite but **cannot deploy
  or cut a release**. Enabling trains ships nothing by itself.

The trial is therefore a settings change only.

## Part A - enable the trial (settings, not YAML)

Set on project `cto/AdaptaLabs` (Settings -> Merge requests, or the API):

```
merge_pipelines_enabled          = true    # merged-results pipelines (prerequisite)
merge_trains_enabled             = true
max_pipelines_per_merge_train    = 5       # cap train length; tune to runner capacity
merge_trains_skip_train_allowed  = true    # let a hotfix bypass the train in an incident
```

Unchanged and all train-compatible: `squash_option: always`, `merge_method: merge`,
`only_allow_merge_if_pipeline_succeeds: true`, `remove_source_branch_after_merge: true`.
The merge flow for a human or agent is unchanged: arm auto-merge as today
(`merge_when_pipeline_succeeds` + `squash:true`); with trains on, that adds the MR to the train.

### Pre-arm verification (all read-only, all before relying on it)

1. **Licence.** Settings -> Merge requests must actually render the "Merge trains" section.
   The instance is `19.2.5-ee` with Ultimate-tier features active (GitLab Advanced SAST runs a
   full scan; Requirements and security policies are on), so trains are expected to be licensed -
   but the rendered toggle is the final confirmation.
2. **One dry-run MR.** Open a trivial throwaway MR, add it to the train, and confirm from the
   pipeline: (a) a `merge_train` pipeline appears and is green, (b) it did **not** run
   `semantic-release` or the kubera deploy, (c) `main` afterwards ran its normal pipeline and
   deployed. Only then let real MRs use the train.

## Part B - the trial period (~1-2 weeks, change nothing else)

`main` keeps running the full suite during the trial - trains guard the merge *and* `main` still
tests. This is deliberately belt-and-braces and costs one extra full run per merge; the payoff
comes in Part C.

Observe:

- **Evictions and their cause.** A real red kept off `main` is the system working. An infra
  stall evicting a train MR (the one flake class measured, ~3%) is churn - if it recurs, add a
  system-failure retry to the heavy jobs so a stall self-heals instead of thrashing the train:
  ```yaml
  retry:
    max: 1
    when: [runner_system_failure, stuck_or_timeout_failure, scheduler_failure]
  ```
- **Concurrency**, under 6+ sessions - the thing the mostly-serial flake sample could not show.
  Confirm throughput holds and the train does not stall.
- **Any `main` pipeline going red post-merge.** With trains working this should stop entirely.
  Zero red `main` over the window is the go signal for Part C.

## Part C - the actual win (DO NOT apply during the trial)

Once the trial shows trains holding and `main` never reddening, land this as its own MR.
This is where the deploy tail shrinks; until then it stays here, unapplied.

### C1 - drop the redundant suite from `main`

Remove the single `PROD_REF` arm from each test job's rules. Three edits in `.gitlab-ci.yml`:

- `lint` (the `- if: '$CI_COMMIT_REF_NAME =~ $PROD_REF'` line under its `rules:`)
- `.test-base` (same line - covers test-backend, test-backend-db, test-frontend, typecheck,
  test-a11y, test-scripts)
- `mutation-canary` (same line, after its `changes:` arm)

Each block goes from:

```yaml
  rules:
    - if: $CI_COMMIT_TAG
      when: never
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      # (mutation-canary keeps its changes: paths here)
    - if: '$CI_COMMIT_REF_NAME =~ $PROD_REF'    # <-- delete this arm
```

to:

```yaml
  rules:
    - if: $CI_COMMIT_TAG
      when: never
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      # (mutation-canary keeps its changes: paths here)
    # main no longer re-runs the suite: the merge-train pipeline already tested this exact tree.
    # SAFETY: only sound with merge trains ON. If trains are ever disabled, restore this arm in
    # the same change or main merges go untested.
```

`check-release-will-deploy`, the docker build, trivy, semantic-release and the kubera deploy keep
their `PROD_REF`/`.delivery-policy` rules untouched - `main` still builds, releases and deploys.

### C2 - decouple the build from the advisory scans (captures the rest of the saving)

As the file stands, `docker-kaniko-build` waits for the whole `.pre` stage, including the
~6.3 min `gitlab-advanced-sast` (allow_failure).
With the canary and suite gone from `main`, `advanced-sast` becomes the new long pole holding the
build.
Give `docker-kaniko-build` explicit `needs:` on only its real inputs (the docker/kubera secret and
token jobs it already depends on) so it starts as soon as those finish rather than after the
advisory scans.
The scans still run in `.pre`, still `allow_failure`, still report.
The exact `needs:` list comes from the docker component's job definition - resolve it against the
merged config before applying.

### Expected end state (main pipeline)

The ~8.7 min canary and the full suite leave the critical path; the deploy tail drops toward
build + publish + release (~4-5 min), the suite stops running a second time, and `main` stops
going red from merge races.

## Residual bypass routes, and the hardening Part C depends on

Once Part C lands, the `main` pipeline no longer tests. That is safe only for commits that
reach `main` **through a merge-train pipeline**. A code-review gate on the Part C MR (!396)
found the routes that reach `main` *without* one, and the project settings as measured on
2026-09-10 (`GET /projects/5005`, `GET .../protected_branches/main`) do not fully close them:

- **Direct push to `main`.** `push_access_levels` on `main` is **Maintainers**, so a maintainer
  (the CI bot included) can push straight to `main`, producing a `source == "push"` pipeline that
  now matches no test arm. **Harden:** set `main`'s push access to **No one** (merge-only).
- **Merge outside the train.** `merge_train_enforcement` is **`allow_bypass`**, so a maintainer
  can merge an MR without adding it to the train, landing an untested-on-`main` commit whose only
  check was its own MR pipeline against a possibly-stale target. **Harden:** set merge-train
  enforcement to **enforce** (require the train). `merge_trains_skip_train_allowed` is already
  `false`, which is correct and closes the "merge immediately" variant.
- **Trains disabled entirely.** If `merge_trains_enabled` is turned off while this YAML is live,
  `main` silently stops testing - no red pipeline, no named failure. That is the failure mode the
  repo's own doctrine calls the worst kind. Two ways to close it, pick one before lifting the
  Part C draft:
  1. **Enforce structurally** (preferred): the two hardening settings above plus enforcing trains
     mean no untested commit can reach `main` in the first place.
  2. **Loud guard job**: a `.pre` job on `$PROD_REF` that reads `merge_trains_enabled` via the API
     (using the token `get-gitlab-token` already mints) and **fails red** when trains are off, so
     the condition Part C depends on can fail *by name* rather than by silent absence.

Recommended: apply the two settings hardenings (No-one push + enforce trains) **and** keep the
guard job as defence in depth, since a settings toggle is one click and the guard is the only
thing that turns that click into a visible failure.

## Rollback

- Disable the trial: set `merge_trains_enabled = false` (and, if desired,
  `merge_pipelines_enabled = false`). No YAML revert needed while Part C is unapplied.
- If Part C has landed and trains are being turned off, revert the Part C MR *first* (restore the
  `PROD_REF` arms) so `main` resumes testing, then disable trains.

## Follow-up

When Part C lands and this is the settled way Cortex ships, record it as an ADR under
`docs/adr/` (next number `0007`), superseding this runbook's "proposed" status.
