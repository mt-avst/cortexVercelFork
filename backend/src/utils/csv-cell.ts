/**
 * ONE CSV CELL, ESCAPED AND - WHERE THE TEXT IS SOMEBODY'S - NEUTRALISED.
 *
 * cto/AdaptaLabs#65. This file exists because there were THREE implementations
 * of "turn a value into a CSV cell" in the tree and they did not agree on the
 * part that matters:
 *
 *   backend/src/firsthand/survey-csv.ts   quoted AND neutralised formulas
 *   backend/src/routes/admin.ts           quoted only
 *   backend/src/routes/feedback.ts        quoted only
 *
 * The two that only quoted are the two admin CSV exports, and both carry text
 * that somebody else typed - so both shipped the formula injection the survey
 * export had already been fixed for. A private copy per call site is how one
 * gets fixed and the others do not, which is the actual defect here; the
 * duplication is just what made it possible.
 *
 * The behaviour is survey-csv.ts's, moved rather than rewritten, so the export
 * that was already correct is unchanged by adopting this.
 */

/**
 * Excel and Google Sheets execute a cell beginning =, +, - or @ as a formula.
 * Human-authored text reaches these cells verbatim, so a value of
 * `=HYPERLINK("http://evil.test")` becomes a live formula in whoever opens the
 * spreadsheet. Prefixing with a tab neutralises it while leaving the text
 * readable, and the tab sits inside the quoted field so parsing is undisturbed.
 *
 * WHO OPENS THESE FILES IS THE POINT. The reader of an admin export is a
 * researcher_admin or a superadmin, and the writer of the text can be any
 * authenticated user - a feedback body is free text submitted by anyone. So
 * the untrusted-to-trusted direction runs from the least privileged user in
 * the system to the most privileged.
 */
export const neutraliseCsvFormula = (value: string): string =>
  /^[=+\-@]/.test(value) ? `\t${value}` : value;

/**
 * Quote when the value carries a delimiter, a quote or either newline
 * character, doubling any embedded quote.
 *
 * `\r` IS IN THE CLASS, and the two route-local copies this replaces omitted
 * it - they tested for `,`, `"` and `\n` only. A lone carriage return inside
 * an unquoted field splits the row for a strict parser, so including it is a
 * fix rather than a formatting preference. It is the only behavioural
 * difference between this and the copies in admin.ts and feedback.ts.
 */
export const escapeCsvValue = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/**
 * A cell, given whether a person wrote its contents.
 *
 * `humanAuthored` IS A REQUIRED ARGUMENT AND NOT A DEFAULT, deliberately. A
 * default in either direction is wrong somewhere: defaulting to `false` makes
 * the unsafe case the one you get by forgetting, and defaulting to `true`
 * silently prefixes generated numbers and dates so they stop being numbers and
 * dates in the sheet. Making it explicit forces the question to be answered
 * per column, which is the only place it can be answered correctly.
 *
 * Values we generate ourselves within a known shape - an ISO timestamp, a
 * uuid, a status from a fixed set - pass `false`, because prefixing them
 * would break the column's type in the spreadsheet for no gain: none of them
 * can begin with =, + or @, and a leading `-` on those shapes is not
 * reachable either.
 */
export const csvCell = (value: string, humanAuthored: boolean): string =>
  escapeCsvValue(humanAuthored ? neutraliseCsvFormula(value) : value);

/**
 * `\r\n`, matching survey-csv.ts's `CSV_LINE_ENDING`.
 *
 * The two admin exports joined their rows with a bare `\n`. RFC 4180 specifies
 * CRLF, Excel on Windows wants it, and every parser that accepts one accepts
 * the other - so this aligns the three exports on the stricter of the two
 * rather than leaving them split.
 */
export const CSV_ROW_SEPARATOR = "\r\n";
