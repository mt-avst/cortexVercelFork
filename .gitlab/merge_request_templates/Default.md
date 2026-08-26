## Verdict

<!-- 10 lines max. A reviewer must be able to approve from this block alone. -->

Closes #NN
<!-- The Closes line stays OUTSIDE the table: a pipe between "Closes" and "#NN"
     breaks GitLab's closing-pattern regex, and the issue silently stays open.
     Found the hard way on !276/#77. -->

| | |
|---|---|
| Change | one sentence |
| Commit type | `fix:` / `feat:` / `chore:` - and why, per ADR-0002 (deploy effect) |
| Backend jest | N passed / N suites (baseline: N / N) |
| Backend vitest | N passed / N files |
| Frontend | N passed / N files |
| Canary | N/N killed, exit 0 - or SKIPPED by path gate (docs/frontend-only) |
| Lint / typecheck | clean / the known pre-existing errors only |
| Risk | one line: what could this break and what proves it does not |

## Evidence

<details>
<summary>Full dossier - reproduction, fix, mutations that prove the tests can see the defect, sweeps</summary>

<!-- The full evidence write-up goes here, unabridged. -->

</details>
