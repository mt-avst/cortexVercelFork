import { expect } from '@jest/globals';

/**
 * ASSERTIONS ABOUT WHAT A STATEMENT AFFECTS, not about what it says.
 *
 * Every write in this repository is matched by tests that check a statement
 * EXISTS - `statements.filter(sql => sql.includes('UPDATE bookings'))` and
 * friends. None of them asked what row it hits, and that gap is not
 * theoretical. Measured on `bedc2fe`, each of these passed the WHOLE backend
 * suite, 1007 of 1007:
 *
 *   - `DELETE FROM bookings WHERE session_id IN (...)` -> `DELETE FROM bookings`
 *     Empties the bookings table. Every booking, every opportunity, every user.
 *   - `DELETE FROM sessions WHERE opportunity_id = $1` -> `DELETE FROM sessions`
 *     Same, for sessions.
 *   - cancel's `UPDATE bookings ... WHERE id = $1` -> `WHERE session_id = $1`
 *   - the capacity decrement's `WHERE id = $1` -> `WHERE opportunity_id = $1`
 *   - `GREATEST(booked_count - 1, 0)` -> `booked_count - 1`, losing the floor
 *
 * WHY THE OBVIOUS TEST DOES NOT WORK. Asserting on the params array alone is
 * worthless: a bound parameter stays bound whether the SQL uses it or not. So
 * `DELETE FROM bookings` called with `[opportunityId]` still "passes the id" -
 * node-pg would raise against a real server, but every one of these suites
 * mocks `pool`, so nothing notices. This repository has already been bitten by
 * exactly that: asserting params and a GROUP BY would have shipped
 * `WHERE study_id = $1` deleted, with every study reporting every other
 * study's counts, past a green suite.
 *
 * So the assertion below ties THREE things together - the column named in the
 * WHERE clause, the `$n` placeholder it is compared against, and the value
 * actually bound at that position. Any one of them alone is satisfiable by a
 * statement that hits the wrong rows.
 */

/**
 * SQL with comments removed and whitespace collapsed.
 *
 * BOTH comment forms, deliberately. Stripping only `--` leaves a statement
 * whose WHERE clause sits inside a block comment reading as SCOPED to every
 * assertion below, while Postgres executes it unscoped - the exact failure
 * this file exists to catch, wearing a comment.
 */
export const executableSql = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The text after the first `WHERE`, or undefined when there is none.
 *
 * Undefined is the interesting answer: an unscoped `DELETE FROM bookings` has
 * no WHERE at all, and that is the difference between deleting one
 * opportunity's rows and emptying the table.
 */
export const whereClauseOf = (sql: string): string | undefined =>
  /\bWHERE\b\s+(.+)$/i.exec(executableSql(sql))?.[1];

/**
 * Asserts the statement restricts itself by `<column> = $n`, and that the value
 * bound at position n is `value`.
 *
 * `column` is matched with a word boundary so `id` does not match `session_id`
 * - which matters, because swapping those two is one of the mutations this
 * exists to kill.
 */
export function expectScopedBy(
  sql: string,
  params: readonly unknown[],
  column: string,
  value: unknown
): void {
  const where = whereClauseOf(sql);
  // Fails first and loudest for an unscoped write, so the message names the
  // real problem rather than "cannot read property of undefined".
  expect(where ?? `<no WHERE clause: ${executableSql(sql)}>`).toContain('=');

  const match = new RegExp(`(?:^|[^_a-z0-9])${column}\\s*=\\s*\\$(\\d+)`, 'i').exec(where as string);
  // ONE ASSERTION, AND IT CARRIES THE DIAGNOSTIC.
  //
  // Two earlier drafts of these four lines were both the defect this file
  // exists to hunt, which is worth the comment:
  //
  //   `expect(match ? match[0] : '<...>').toBeTruthy()` cannot fail - both
  //   branches are non-empty strings - so the real failure was a bare
  //   `Received: null` naming neither the column nor the statement.
  //
  //   Replacing it with `.toMatch(/<column> = \$\d+/)` on the same expression
  //   was WORSE: the diagnostic string embeds the WHERE clause, so for column
  //   `id` the message `<id is not ... in: opportunity_id = $1>` MATCHES the
  //   pattern. It passed on the very statement it was meant to reject, and the
  //   test then died a line later on a null dereference.
  //
  // Comparing against a fixed sentinel cannot do either: the failure branch is
  // a different string by construction, and the message prints both.
  expect(
    match ? `${column} is bound` : `<${column} is not compared to a bound parameter in: ${where}>`
  ).toBe(`${column} is bound`);

  const position = Number((match as RegExpExecArray)[1]) - 1;
  // THE HALF THAT MAKES THIS A SCOPE ASSERTION. Without it the statement could
  // name the right column and bind somebody else's id to it.
  expect(params[position]).toBe(value);
}
