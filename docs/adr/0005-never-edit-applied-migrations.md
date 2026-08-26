# Never edit an applied migration

The migration runner checksums applied migrations at startup; editing one character of an
applied file makes the backend pod CrashLoop on deploy. Fix forward with a new migration,
always. Also recorded: when a migration adds a CHECK, a composite FK or an ON DELETE rule,
the regression test must run a real database - a mocked `pg` cannot raise a constraint
(`*-postgres.test.ts` exists for exactly this).
