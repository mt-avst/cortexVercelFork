# A curated mutation canary blocks merges, and is never filtered

The most expensive recurring defect here is a test that cannot fail - fixture-shaped
assertions that pass against the defect they were written for (five on !210 alone). The
canary pins each load-bearing line to the one test that must fail when it changes, and
blocks MR pipelines. Stryker was rejected: hours per run is a gate nobody keeps.

Two hard rules. The manifest is never run filtered - a filtered run is structurally blind
to a pre-existing entry the same diff broke (!267 reddened main exactly that way), so the
runner refuses unknown arguments rather than growing a filter flag. Cost is controlled two
ways, neither of which is a filter: the job-level path gate in `.gitlab-ci.yml` (MRs touching
none of `backend/`, `frontend/`, `shared/`, `scripts/`, the root lockfile or the CI file
skip the whole
job, all-or-nothing) and sharding (!276: `parallel: 4`, a deterministic partition of the
sorted manifest whose union is always the whole manifest and whose gate is all shards green).

## Update 2026-09-18 (!477, !478): runs on the merge-train pipeline only

Cost was controlled a third way: the canary used to run three times per change - the
MR pipeline, the merge-train pipeline, and the post-merge `main` pipeline - each grading
what was essentially the same tree, and the `main` run sat on the deploy critical path
(measured !476: the deploy waited ~10 min for it). It now runs **once, on the merge
train**, gated on `$CI_MERGE_REQUEST_EVENT_TYPE == "merge_train"`. The train grades the
full manifest against the real merge result immediately before it lands, so this is the
one run that both sees the real tree and blocks the merge - the decision above is
unchanged, and nothing is filtered.

This leans hard on merge trains being ON: with trains off the canary would run nowhere
and this gate would silently vanish, so if trains are ever disabled the rule must change
back in the same commit (restore the plain `merge_request_event` MR run and the
`$PROD_REF` main run). The authoritative detail lives in the `mutation-canary` job's
`rules:` docblock and the "CI waits" section of `AGENTS.md`; keep all three in step.
