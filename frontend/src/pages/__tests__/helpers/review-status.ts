import { fireEvent, screen, within } from '@testing-library/react';

/**
 * Driving Review's Status control (#167).
 *
 * Two pods, Draft and Published, in a `role="radiogroup"` labelled "Status" -
 * replacing the `<select id="status">` a test used to drive with
 * `selectOptions`/`fireEvent.change`. A test that used to read
 * `document.getElementById('status').value` now clicks the pod named for the
 * status it wants; `statusIsChecked` reads which one is checked without
 * relying on a page-wide `document.getElementById` lookup.
 */

/** The status radiogroup, scoped to Review (the only step that renders it). */
export const statusGroup = () =>
  within(screen.getByTestId('review-step')).getByRole('radiogroup', { name: 'Status' });

/** The Draft or Published pod's radio input, scoped to Review. */
export const statusRadio = (status: 'draft' | 'published') =>
  within(screen.getByTestId('review-step')).getByRole('radio', {
    name: status === 'draft' ? /Draft/ : /Published/
  }) as HTMLInputElement;

/** Choose Status from wherever Review currently is. */
export const setStatus = (status: 'draft' | 'published') => {
  fireEvent.click(statusRadio(status));
};

/** Whether the given status is the one currently checked. */
export const statusIsChecked = (status: 'draft' | 'published') => statusRadio(status).checked;
