# Deploys happen only when semantic-release cuts a version

Cortex deploys by release tag: semantic-release cuts a version from the squashed commit
type, that becomes an image tag, ArgoCD rolls it. Only `feat`, `fix`, `perf`, `revert` and
breaking changes release. A merge changing code under `backend frontend shared .kubera`
with a non-releasing type is a stranded merge - green pipeline, nothing deployed - which
`ci/check-release-will-deploy.sh` now fails loudly (it happened on !94 and cost an hour).
Docs-only and CI-only merges legitimately cut no version and pass.

Consequence: pick the squash commit type by deployment effect, not by literary accuracy.
