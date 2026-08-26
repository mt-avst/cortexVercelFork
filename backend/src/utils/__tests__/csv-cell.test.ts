import { describe, it, expect } from '@jest/globals';

import {
  csvCell,
  escapeCsvValue,
  neutraliseCsvFormula,
  CSV_ROW_SEPARATOR
} from '../csv-cell';

/**
 * THE CSV CELL HELPERS, TESTED WHERE THE DISTINCTION IS OBSERVABLE.
 * cto/AdaptaLabs#65.
 *
 * THIS FILE EXISTS BECAUSE A ROUTE-LEVEL CONTROL COULD NOT DO THE JOB, and
 * that was found by mutation rather than by reading. The first version of the
 * streaming suite carried an arm asserting that "generated columns are left
 * unprefixed", driven through the feedback export with a uuid and an ISO
 * timestamp. Flipping that export's `csvCell(id, false)` to `true` - the exact
 * over-prefixing the arm claimed to catch - passed 11 of 11.
 *
 * It had to. `neutraliseCsvFormula` fires only on a leading =, +, - or @, and
 * a uuid begins with a hex digit while an ISO timestamp begins with a decimal
 * one. NEITHER CAN EVER TRIGGER IT, so for those columns the two branches are
 * the same function and the mutant is equivalent. An arm asserting a
 * difference that cannot exist is not a weak test, it is a test of nothing,
 * and its comment was claiming a verification the fixture made impossible.
 *
 * So the `humanAuthored` branch is pinned HERE, against values that actually
 * differ between the two, and the route suite now only asserts what it can
 * genuinely see.
 */

describe('neutraliseCsvFormula (#65)', () => {
  // The four prefixes Excel and Google Sheets treat as the start of a formula.
  it.each(['=', '+', '-', '@'])('prefixes a value beginning %s with a tab', (lead) => {
    expect(neutraliseCsvFormula(`${lead}HYPERLINK("http://evil.test")`)).toBe(
      `\t${lead}HYPERLINK("http://evil.test")`
    );
  });

  // THE CONTROL. "It prefixed it" passes against a function that prefixes
  // everything, which would break every numeric and date column in the sheet.
  it.each(['plain text', '0900', 'a=b', ' =later', ''])(
    'leaves %p alone',
    (value) => {
      expect(neutraliseCsvFormula(value)).toBe(value);
    }
  );
});

describe('escapeCsvValue (#65)', () => {
  it.each([
    ['a,b', '"a,b"'],
    ['a"b', '"a""b"'],
    ['a\nb', '"a\nb"'],
    ['a\rb', '"a\rb"']
  ])('quotes %p', (input, expected) => {
    expect(escapeCsvValue(input)).toBe(expected);
  });

  it('leaves a value needing no quoting untouched', () => {
    expect(escapeCsvValue('plain')).toBe('plain');
  });

  /**
   * THE ONE BEHAVIOURAL DIFFERENCE from the two route-local `escapeCsvField`
   * copies this replaces. Both tested for `,`, `"` and `\n` and NOT for `\r`,
   * so a lone carriage return travelled unquoted and split the row for a strict
   * parser. Called out as its own arm because it is the only way this change
   * is observable on an export that carries no formulas.
   */
  it('quotes a lone carriage return, which the route-local copies did not', () => {
    expect(escapeCsvValue('a\rb')).toBe('"a\rb"');
  });
});

describe('csvCell (#65)', () => {
  /**
   * THE PAIR THAT MAKES THE FLAG OBSERVABLE, and the whole reason this file
   * exists. Same input, both branches, different output.
   */
  it('neutralises when the text is human-authored', () => {
    expect(csvCell('=1+1', true)).toBe('\t=1+1');
  });

  it('does NOT neutralise when the value is one we generated', () => {
    expect(csvCell('=1+1', false)).toBe('=1+1');
  });

  it('escapes after neutralising, so the tab sits inside the quotes', () => {
    // A formula that also needs quoting: the tab must be inside the quoted
    // field or it would disturb parsing rather than the formula.
    expect(csvCell('=A1,B2', true)).toBe('"\t=A1,B2"');
  });

  it('escapes a generated value that needs it, without prefixing it', () => {
    expect(csvCell('a,b', false)).toBe('"a,b"');
  });
});

describe('CSV_ROW_SEPARATOR (#65)', () => {
  // A literal, written out rather than compared to itself. The two admin
  // exports joined rows with a bare \n before this.
  it('is CRLF, matching RFC 4180 and survey-csv.ts', () => {
    expect(CSV_ROW_SEPARATOR).toBe('\r\n');
  });
});
