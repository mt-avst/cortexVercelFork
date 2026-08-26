# A curated mutation canary blocks merges, and is never filtered

The most expensive recurring defect here is a test that cannot fail - fixture-shaped
assertions that pass against the defect they were written for (five on !210 alone). The
canary pins each load-bearing line to the one test that must fail when it changes, and
blocks MR pipelines. Stryker was rejected: hours per run is a gate nobody keeps.

Two hard rules. The manifest is never run filtered - a filtered run is structurally blind
to a pre-existing entry the same diff broke (!267 reddened main exactly that way), so the
runner refuses unknown arguments rather than growing a filter flag. Cost is controlled two
ways, neither of which is a filter: the job-level path gate in `.gitlab-ci.yml` (MRs touching
none of `backend/`, `shared/`, `scripts/`, the root lockfile or the CI file skip the whole
job, all-or-nothing) and sharding (!276: `parallel: 4`, a deterministic partition of the
sorted manifest whose union is always the whole manifest and whose gate is all shards green).
