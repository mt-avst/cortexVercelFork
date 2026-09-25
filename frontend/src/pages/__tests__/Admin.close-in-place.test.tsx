import { screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getDashboardStats, getOpportunities, updateOpportunity } from '../../api/client';
import {
  ADMIN_USER,
  STATS,
  STUDIES,
  clickClose,
  deferred,
  findStudiesTable,
  openRowMenu,
  renderAdmin,
  renderedTitles,
  rowFor,
  session,
  statusLabel,
  study,
  titleLink,
  undoButtonFor,
  undoNotice,
} from './helpers/admin-triage';

/**
 * Close study, in place (Admin table Step 2, MR B fix round; review P2, P3):
 *
 * - the closed row keeps its position while its notice shows, and the notice
 *   is a table row directly under it spanning every column; the row re-sorts
 *   when the notice ends
 * - a Close in flight is not repeated by a second click, and row clicks and
 *   the inline action are ignored meanwhile
 * - one notice slot, keyed by study id: a late Undo answer about one study
 *   never clears another's notice or steals its focus
 * - when a notice ends or an error is dismissed, focus goes to the study's
 *   title link, else the first study link, else the result count
 *
 * The 8000ms undo window is a LITERAL here, never read from the hook.
 */

const auth = vi.hoisted(() => ({
  value: {
    user: { id: 'admin-1', role: 'researcher_admin', name: 'Admin', email: 'admin@example.com' },
    loading: false,
    initialAuthCheck: true,
  } as { user: { id: string; role: string; name: string; email: string } | null; loading: boolean; initialAuthCheck: boolean },
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../components/PendingApprovals', () => ({ default: () => null }));
vi.mock('../../components/AdminFeedback', () => ({ default: () => null }));

vi.mock('../../api/client', () => ({
  getOpportunities: vi.fn(),
  getDashboardStats: vi.fn(),
  deleteOpportunity: vi.fn().mockResolvedValue(undefined),
  duplicateOpportunity: vi.fn().mockResolvedValue(undefined),
  updateOpportunity: vi.fn(),
  exportBookingsCsv: vi.fn().mockResolvedValue(undefined),
  getPendingApprovals: vi.fn().mockResolvedValue([]),
  getFeedback: vi.fn().mockResolvedValue({ items: [], has_more: false }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  auth.value = { user: ADMIN_USER, loading: false, initialAuthCheck: true };
  vi.mocked(getOpportunities).mockResolvedValue(STUDIES as never);
  vi.mocked(getDashboardStats).mockResolvedValue(STATS as never);
  vi.mocked(updateOpportunity).mockResolvedValue({} as never);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance fake time (and flush the promises it releases) inside act. */
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Loads under real timers, then closes `title` under fake ones. */
const closeUnderFakeTimers = async (title: string) => {
  const table = await findStudiesTable();
  const menu = openRowMenu(rowFor(table, title), title);
  vi.useFakeTimers();
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Close study' }));
  await advance(0);
  return table;
};

const indexOf = (table: HTMLElement, title: string) => renderedTitles(table).indexOf(title);

/** A plain, single, left click on a non-interactive cell of the row. */
const clickRowCell = (row: HTMLElement, init: MouseEventInit = {}) =>
  fireEvent.click(row.querySelector('td.col-date') as HTMLElement, { detail: 1, ...init });

describe('the closed row stays where it was until its notice ends', () => {
  it('keeps its index with the notice directly under it, then re-sorts into Closed on the lapse', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    // Status ascending: the broken study the user acts on is the top row.
    expect(renderedTitles(table)).toEqual([
      'Broken test study',
      'Second broken study',
      'Draft study',
      'Colleague study',
      'Live study',
      'Closed study',
    ]);

    await closeUnderFakeTimers('Broken test study');

    // In place: still row 0, already reading CLOSED, with the notice as the
    // very next table row.
    expect(indexOf(table, 'Broken test study')).toBe(0);
    const row = rowFor(table, 'Broken test study');
    expect(statusLabel(row)).toBe('CLOSED');
    const next = row.nextElementSibling as HTMLElement;
    expect(next).not.toBeNull();
    expect(within(next).getByRole('status')).toHaveTextContent('Closed “Broken test study”');
    expect(next.querySelector('.row-title')).toBeNull();

    // 7999ms: still in place.
    await advance(7999);
    expect(indexOf(table, 'Broken test study')).toBe(0);

    // 8000ms: the notice ends and the row sorts by what it now is - Closed,
    // no milestone, so after Live and before "Closed study" by title.
    await advance(1);
    expect(undoNotice('Broken test study')).toBeNull();
    expect(renderedTitles(table)).toEqual([
      'Second broken study',
      'Draft study',
      'Colleague study',
      'Live study',
      'Broken test study',
      'Closed study',
    ]);
  });

  it('gives the notice cell a colSpan equal to the number of columns', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    clickClose(table, 'Live study');
    await waitFor(() => expect(undoNotice('Live study')).not.toBeNull());

    const headers = table.querySelectorAll('thead th').length;
    // Pinned as a literal as well as against the header count: a span that
    // merely agreed with a wrong header count would pass the comparison.
    expect(headers).toBe(6);
    const cell = (undoNotice('Live study') as HTMLElement).closest('td') as HTMLTableCellElement;
    expect(cell.colSpan).toBe(6);
  });
});

describe("the table's scroll anchoring (round 4)", () => {
  it('is held off only while a notice is up', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    expect(table).not.toHaveClass('admin-data-table--hold-scroll');

    await closeUnderFakeTimers('Live study');
    expect(table).toHaveClass('admin-data-table--hold-scroll');

    // Focus leaves Undo, so the lapse has no hand-off to carry.
    (document.activeElement as HTMLElement).blur();
    await advance(8000);
    await advance(100);
    expect(undoNotice('Live study')).toBeNull();
    expect(table).not.toHaveClass('admin-data-table--hold-scroll');
  });
});

describe('a Close in flight', () => {
  it('sends ONE PATCH when Close study is chosen twice on the same study', async () => {
    const patch = deferred<unknown>();
    vi.mocked(updateOpportunity).mockReturnValue(patch.promise as never);
    renderAdmin();
    const table = await findStudiesTable();

    clickClose(table, 'Live study');
    // The row has not changed yet, so the menu still offers Close study.
    clickClose(table, 'Live study');

    await act(async () => {
      patch.resolve({});
      await patch.promise;
    });

    // Control: the first close did land.
    await waitFor(() => expect(undoNotice('Live study')).not.toBeNull());
    expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateOpportunity)).toHaveBeenCalledWith('opp-live', { status: 'closed' });
  });

  it('ignores a row click and the inline action until the PATCH answers', async () => {
    const patch = deferred<unknown>();
    vi.mocked(updateOpportunity).mockReturnValue(patch.promise as never);
    renderAdmin();
    const table = await findStudiesTable();

    clickClose(table, 'Live study');
    clickRowCell(rowFor(table, 'Draft study'));
    fireEvent.click(rowFor(table, 'Draft study').querySelector('.admin-action-primary') as HTMLElement, { detail: 1 });
    expect(screen.queryByTestId('probe')).toBeNull();

    await act(async () => {
      patch.resolve({});
      await patch.promise;
    });
    await waitFor(() => expect(undoNotice('Live study')).not.toBeNull());

    // Control: the same click navigates once nothing is in flight.
    clickRowCell(rowFor(table, 'Draft study'));
    expect(await screen.findByTestId('probe')).toHaveTextContent('OVERVIEW /admin/opportunities/opp-draft');
  });
});

describe('one notice slot, keyed by study', () => {
  const SECOND = study({
    id: 'opp-live-2',
    title: 'Second live study',
    sessions: [session('s-live-2', 'opp-live-2', 20, 3, 1)],
  });

  it("a pending Undo on one study does not clear the next study's notice when it answers", async () => {
    vi.mocked(getOpportunities).mockResolvedValue([...STUDIES, SECOND] as never);
    const undoLive = deferred<unknown>();
    vi.mocked(updateOpportunity).mockImplementation(((id: string, data: { status: string }) =>
      id === 'opp-live' && data.status === 'published' ? undoLive.promise : Promise.resolve({})) as never);
    renderAdmin();
    const table = await findStudiesTable();

    clickClose(table, 'Live study');
    await waitFor(() => expect(undoNotice('Live study')).not.toBeNull());
    fireEvent.click(undoButtonFor('Live study'));

    // While Live's Undo is still in flight, close a second study. Its Undo is
    // disabled until Live's answers (round 3: every Undo is disabled while
    // any Undo is in flight, so two reopen requests never race).
    clickClose(table, 'Second live study');
    await waitFor(() => expect(undoNotice('Second live study')).not.toBeNull());
    expect(undoButtonFor('Second live study')).toBeDisabled();

    // Live's Undo now answers.
    await act(async () => {
      undoLive.resolve({});
      await undoLive.promise;
    });

    // Control: it really landed - Live is published again.
    await waitFor(() => expect(statusLabel(rowFor(table, 'Live study'))).toBe('PUBLISHED'));
    // And the second study's notice survives, live again, holding focus.
    expect(undoNotice('Second live study')).not.toBeNull();
    expect(undoButtonFor('Second live study')).not.toBeDisabled();
    await waitFor(() => expect(document.activeElement).toBe(undoButtonFor('Second live study')));
    expect(vi.mocked(updateOpportunity).mock.calls).toEqual([
      ['opp-live', { status: 'closed' }],
      ['opp-live', { status: 'published' }],
      ['opp-live-2', { status: 'closed' }],
    ]);
  });

  it("a late REFUSAL of one study's Undo shows its error in the old slot and hands focus to the next notice", async () => {
    vi.mocked(getOpportunities).mockResolvedValue([...STUDIES, SECOND] as never);
    const undoLive = deferred<unknown>();
    vi.mocked(updateOpportunity).mockImplementation(((id: string, data: { status: string }) =>
      id === 'opp-live' && data.status === 'published' ? undoLive.promise : Promise.resolve({})) as never);
    renderAdmin();
    const table = await findStudiesTable();

    clickClose(table, 'Live study');
    await waitFor(() => expect(undoNotice('Live study')).not.toBeNull());
    fireEvent.click(undoButtonFor('Live study'));
    clickClose(table, 'Second live study');
    await waitFor(() => expect(undoNotice('Second live study')).not.toBeNull());

    await act(async () => {
      undoLive.reject({ response: { status: 400, data: { error: 'Add at least one upcoming time slot.' } } });
      await undoLive.promise.catch(() => undefined);
    });

    // Control: the refusal did land.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reopen “Live study”: Add at least one upcoming time slot.');
    // The user is working on the second notice: focus goes to its Undo, not
    // to the older study's error.
    expect(undoNotice('Second live study')).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(undoButtonFor('Second live study')));
    expect(document.activeElement).not.toBe(alert);
  });
});

/** The tbody, row by row: a study's title, or NOTICE / ERROR for the in-place rows. */
const tbodyLayout = (table: HTMLElement): string[] =>
  Array.from(table.querySelectorAll<HTMLElement>('tbody tr')).map(
    (tr) =>
      tr.querySelector('.row-title')?.textContent ??
      (tr.querySelector('[role="status"]') ? 'NOTICE' : tr.querySelector('[role="alert"]') ? 'ERROR' : '?')
  );

describe('where focus goes when a notice ends', () => {
  it("on the lapse, from Undo to the study's own title link", async () => {
    renderAdmin();
    const table = await closeUnderFakeTimers('Live study');
    expect(document.activeElement).toBe(undoButtonFor('Live study'));

    await advance(8000);
    await advance(0);

    expect(undoNotice('Live study')).toBeNull();
    expect(document.activeElement).toBe(titleLink(table, 'Live study'));
  });

  it("on Dismiss of a refused Undo, to the study's title link - not <body>", async () => {
    vi.mocked(updateOpportunity)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce({ response: { status: 400, data: { error: 'Add at least one upcoming time slot.' } } });
    renderAdmin();
    const table = await findStudiesTable();
    clickClose(table, 'Live study');
    await waitFor(() => expect(undoNotice('Live study')).not.toBeNull());
    // Control: the notice sits directly under the frozen row.
    expect(tbodyLayout(table)).toEqual([
      'Broken test study', 'Second broken study', 'Draft study', 'Colleague study', 'Live study', 'NOTICE', 'Closed study',
    ]);
    fireEvent.click(undoButtonFor('Live study'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reopen “Live study”: Add at least one upcoming time slot.');
    // Round 3: a refused Undo freezes nothing. The row sorts live (closed, so
    // last), and the error takes the notice's old slot on its own, so the page
    // does not move under the reader.
    expect(tbodyLayout(table)).toEqual([
      'Broken test study', 'Second broken study', 'Draft study', 'Colleague study', 'ERROR', 'Closed study', 'Live study',
    ]);

    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(titleLink(table, 'Live study')));
  });

  it('falls back to the first study link when the row has left the filtered table', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.click(screen.getByRole('button', { name: 'Broken 2' }));
    expect(renderedTitles(table)).toEqual(['Broken test study', 'Second broken study']);

    await closeUnderFakeTimers('Broken test study');
    // Round 3: filters read the LIVE study, so the closed one has left the
    // Broken chip at once - but its notice alone holds its place, so Undo is
    // still where the user left it.
    expect(tbodyLayout(table)).toEqual(['NOTICE', 'Second broken study']);
    expect(screen.getByRole('button', { name: 'Broken 1' })).toHaveAttribute('aria-pressed', 'true');

    await advance(8000);
    await advance(0);

    expect(tbodyLayout(table)).toEqual(['Second broken study']);
    expect(document.activeElement).toBe(titleLink(table, 'Second broken study'));
  });

  it("goes to the row now at the notice's slot, without scrolling, when the study's own link has moved out of view (round 4)", async () => {
    renderAdmin();
    const table = await closeUnderFakeTimers('Live study');
    // Control: the slot the reader is looking at.
    expect(tbodyLayout(table)).toEqual([
      'Broken test study', 'Second broken study', 'Draft study', 'Colleague study', 'Live study', 'NOTICE', 'Closed study',
    ]);
    // Live's own link will be off screen once it re-sorts (jsdom has no
    // layout, so the geometry is faked for that one link).
    const realRect = Element.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.matches('a.row-title[data-study-id="opp-live"]')) {
        return { top: 2000, bottom: 2020, left: 0, right: 100, width: 100, height: 20, x: 0, y: 2000, toJSON: () => ({}) } as DOMRect;
      }
      return realRect.call(this);
    });
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');

    await advance(8000);
    await advance(0);

    // Next row at the old slot takes focus - not the moved link, not the top.
    expect(document.activeElement).toBe(titleLink(table, 'Closed study'));
    const closedLink = titleLink(table, 'Closed study');
    const toClosed = focusSpy.mock.calls.filter((_, i) => (focusSpy.mock.contexts[i] as unknown) === closedLink);
    expect(toClosed.length).toBeGreaterThan(0);
    for (const [options] of toClosed) expect(options).toEqual({ preventScroll: true });
    rectSpy.mockRestore();
    focusSpy.mockRestore();
  });

  it('goes to the previous row when nothing follows the slot and the study has left the table (round 4)', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'published' } });
    await waitFor(() =>
      expect(renderedTitles(table)).toEqual(['Broken test study', 'Second broken study', 'Colleague study', 'Live study'])
    );

    await closeUnderFakeTimers('Live study');
    // Closed, so no longer Published: its notice alone holds the last slot.
    expect(tbodyLayout(table)).toEqual(['Broken test study', 'Second broken study', 'Colleague study', 'NOTICE']);

    await advance(8000);
    await advance(0);

    expect(tbodyLayout(table)).toEqual(['Broken test study', 'Second broken study', 'Colleague study']);
    // The row just above the old slot - not the first row of the table.
    expect(document.activeElement).toBe(titleLink(table, 'Colleague study'));
  });

  it('falls back to the result count when no study row is left', async () => {
    vi.mocked(getOpportunities).mockResolvedValue(STUDIES.filter((s) => s.id !== 'opp-broken-b') as never);
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.click(screen.getByRole('button', { name: 'Broken 1' }));
    expect(renderedTitles(table)).toEqual(['Broken test study']);

    await closeUnderFakeTimers('Broken test study');
    await advance(8000);
    await advance(0);

    const count = document.querySelector('.admin-result-count') as HTMLElement;
    expect(count).not.toBeNull();
    expect(count).toHaveTextContent('0 of 5 studies');
    expect(document.activeElement).toBe(count);
  });
});

describe('a Close the server refuses', () => {
  it('says so in place, with the generic reason, and leaves the row published', async () => {
    vi.mocked(updateOpportunity).mockRejectedValueOnce(new Error('Network Error'));
    renderAdmin();
    const table = await findStudiesTable();
    clickClose(table, 'Live study');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not close “Live study”. Please try again.');
    expect(statusLabel(rowFor(table, 'Live study'))).toBe('PUBLISHED');
    expect(undoNotice('Live study')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it("quotes the server's own reason when it gives one", async () => {
    vi.mocked(updateOpportunity).mockRejectedValueOnce({
      response: { status: 403, data: { error: 'Only the owner can edit this study' } },
    });
    renderAdmin();
    const table = await findStudiesTable();
    clickClose(table, 'Live study');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not close “Live study”: Only the owner can edit this study'
    );
  });
});
