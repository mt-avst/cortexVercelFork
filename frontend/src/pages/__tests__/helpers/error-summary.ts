import { screen, within } from '@testing-library/react';

/**
 * Reading the error summary from a test.
 *
 * Both the summary and each inline field message carry `role="alert"`, and
 * since D1 they carry the SAME SENTENCE - that is the point of the change, and
 * it is also why a bare `getByText('Enter a title')` now finds two nodes. These
 * helpers say which of the two a test means, so scoping is a decision rather
 * than a `getAllByText(...)[0]` that quietly stops meaning anything.
 */

/** The summary container, named by its own heading. */
export const errorSummary = () =>
  screen.getByRole('alert', { name: /There (is a problem|are \d+ problems)/i });

export const queryErrorSummary = () =>
  screen.queryByRole('alert', { name: /There (is a problem|are \d+ problems)/i });

/**
 * The validation KEYS the summary is reporting, in the order it lists them.
 *
 * Keys, not sentences. The Continue/Submit agreement test is about whether the
 * two entry points refuse the same RULES, and comparing rendered copy would
 * pass the day two different rules were given the same wording.
 */
export const summarisedErrorKeys = (): string[] =>
  Array.from(errorSummary().querySelectorAll('li[data-field]')).map(
    (item) => item.getAttribute('data-field') as string
  );

/** The sentence the summary shows for one key. */
export const summaryMessageFor = (key: string): string | undefined =>
  errorSummary()
    .querySelector(`li[data-field="${key}"] button`)
    ?.textContent?.trim();

/** The link for one key, ready to click. */
export const summaryLinkFor = (key: string): HTMLButtonElement => {
  const link = errorSummary().querySelector<HTMLButtonElement>(
    `li[data-field="${key}"] button`
  );
  if (!link) {
    throw new Error(
      `The summary lists [${summarisedErrorKeys().join(', ')}] - no entry for "${key}"`
    );
  }
  return link;
};

/**
 * The message beside the control, as distinct from the one in the summary.
 *
 * Deliberately asserts there is exactly one such node. Two would mean a field
 * message had been duplicated into the step body, which is the failure mode
 * this whole helper exists to keep visible.
 */
export const inlineErrorText = (text: string | RegExp): HTMLElement => {
  const summary = queryErrorSummary();
  const outside = screen
    .getAllByText(text)
    .filter((node) => !summary || !summary.contains(node));
  if (outside.length !== 1) {
    throw new Error(
      `Expected exactly one inline message matching ${String(text)}, found ${outside.length}`
    );
  }
  return outside[0];
};

/** Every sentence the summary is showing, for a whole-list assertion. */
export const summaryMessages = (): string[] =>
  within(errorSummary())
    .getAllByRole('button')
    .map((link) => link.textContent?.trim() ?? '');
