# The backend has two test runners, split by filename suffix

Jest owns the default `backend/src/**/__tests__` globs; vitest owns `*-postgres.test.ts`
(needs a real database) and `*-vitest.test.ts` (must run on the merge gate without one).
The globs are disjoint by construction - jest's `testPathIgnorePatterns` mirrors vitest's
includes. `npm run typecheck` is the only command that type-checks test files: `tsc -p`
and `npm run lint` both exclude `__tests__`, so a suite can fail to load while both exit 0.
Read the suite count, not just the pass count.
