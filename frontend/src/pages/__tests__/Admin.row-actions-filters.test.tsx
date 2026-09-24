import { screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { duplicateOpportunity, getDashboardStats, getOpportunities, updateOpportunity } from '../../api/client';
import {
  ADMIN_USER,
  STATS,
  STUDIES,
  SUPERADMIN_USER,
  byId,
  deferred,
  findStudiesTable,
  inDays,
  openRowMenu,
  renderAdmin,
  renderedTitles,
  rowFor,
  showAllResearchers,
  study,
} from './helpers/admin-triage';

/**
 * Admin Research Studies table, Step 2 (MR B fix round):
 *
 * - review P4: only the owner or a superadmin is offered Fix/Edit inline, and
 *   anyone else's kebab Edit and Delete are disabled with the server's reason
 * - the inline action is a router link named "<Verb>: <title>"
 * - row clicks act on a plain single click only (no double-click, no modifier)
 * - review P1: Status and Study Type filter client-side, so "N of M" counts
 *   the whole in-scope list and Needs attention never narrows with a filter;
 *   a Needs attention card clears the other filters before applying its chip
 * - "Next / deadline" is the header and the Sort-by label (review M1)
 * - day labels round DOWN and the warning colour is a 72-hour horizon; a
 *   closed study has no next milestone (round 3)
 * - round 3: a non-manager's title link and row click go to the Preview,
 *   Copy is owner-only, and a refused Copy shows in the row's error
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

const COLLEAGUE_BROKEN = study({
  id: 'opp-colleague-broken',
  title: 'Colleague broken study',
  owner_user_id: 'someone-else',
  owner_name: 'Dana Owner',
  owner_email: 'dana@example.com',
});
const COLLEAGUE_DRAFT = study({
  id: 'opp-colleague-draft',
  title: 'Colleague draft study',
  status: 'draft',
  owner_user_id: 'someone-else',
  owner_name: 'Dana Owner',
  owner_email: 'dana@example.com',
});

const primaryAction = (row: HTMLElement) => row.querySelector<HTMLAnchorElement>('.admin-action-primary') as HTMLAnchorElement;

const clickRowCell = (row: HTMLElement, init: MouseEventInit = {}) =>
  fireEvent.click(row.querySelector('td.col-date') as HTMLElement, { detail: 1, ...init });

describe('the owner gate on the inline action (review P4)', () => {
  it('is a link named "<Verb>: <title>" to the verb\'s page', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const fix = within(rowFor(table, 'Broken test study')).getByRole('link', { name: 'Fix: Broken test study' });
    expect(fix).toHaveAttribute('href', '/admin/opportunities/opp-broken-a/edit');
    expect(fix).toHaveTextContent('Fix');
    const analytics = within(rowFor(table, 'Live study')).getByRole('link', { name: 'Analytics: Live study' });
    expect(analytics).toHaveAttribute('href', '/admin/opportunities/opp-live/analytics');
  });

  it("offers Preview, not Fix or Edit, on someone else's broken study or draft", async () => {
    vi.mocked(getOpportunities).mockResolvedValue([...STUDIES, COLLEAGUE_BROKEN, COLLEAGUE_DRAFT] as never);
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();

    // Control: your own broken study and draft do get Fix and Edit.
    expect(primaryAction(rowFor(table, 'Broken test study'))).toHaveAccessibleName('Fix: Broken test study');
    expect(primaryAction(rowFor(table, 'Draft study'))).toHaveAccessibleName('Edit: Draft study');

    const broken = primaryAction(rowFor(table, 'Colleague broken study'));
    expect(broken).toHaveAccessibleName('Preview: Colleague broken study');
    expect(broken).toHaveAttribute('href', '/opportunities/opp-colleague-broken');
    const draft = primaryAction(rowFor(table, 'Colleague draft study'));
    expect(draft).toHaveAccessibleName('Preview: Colleague draft study');
    expect(draft).toHaveAttribute('href', '/opportunities/opp-colleague-draft');
  });

  it("offers a superadmin Fix and Edit on anyone's study", async () => {
    auth.value = { user: SUPERADMIN_USER, loading: false, initialAuthCheck: true };
    vi.mocked(getOpportunities).mockResolvedValue([...STUDIES, COLLEAGUE_BROKEN, COLLEAGUE_DRAFT] as never);
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();

    expect(primaryAction(rowFor(table, 'Colleague broken study'))).toHaveAccessibleName('Fix: Colleague broken study');
    expect(primaryAction(rowFor(table, 'Colleague draft study'))).toHaveAccessibleName('Edit: Colleague draft study');
  });
});

describe('the owner gate on the row menu (review P4 follow-up)', () => {
  it("disables Edit and Delete on someone else's study, each with the server's reason", async () => {
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();

    // Control: on your own study both are live - Edit a link to the page.
    const own = openRowMenu(rowFor(table, 'Live study'), 'Live study');
    expect(within(own).getByRole('menuitem', { name: 'Edit' })).toHaveAttribute('href', '/admin/opportunities/opp-live/edit');
    expect(within(own).getByRole('menuitem', { name: 'Delete' })).not.toBeDisabled();
    fireEvent.click(within(rowFor(table, 'Live study')).getByRole('button', { name: 'Actions for Live study' }));

    const menu = openRowMenu(rowFor(table, 'Colleague study'), 'Colleague study');
    const edit = within(menu).getByRole('menuitem', { name: 'Edit' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'Only the owner can edit this study');
    expect(edit).not.toHaveAttribute('href');
    const del = within(menu).getByRole('menuitem', { name: 'Delete' });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('title', 'Only the owner can delete this study');
  });

  it("keeps Edit and Delete live for a superadmin on someone else's study", async () => {
    auth.value = { user: SUPERADMIN_USER, loading: false, initialAuthCheck: true };
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();

    const menu = openRowMenu(rowFor(table, 'Colleague study'), 'Colleague study');
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/admin/opportunities/opp-colleague/edit'
    );
    const del = within(menu).getByRole('menuitem', { name: 'Delete' });
    expect(del).not.toBeDisabled();
    fireEvent.click(del);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('a row click is a plain single click only', () => {
  it('navigates to the edit page on a plain single click (the control)', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    clickRowCell(rowFor(table, 'Live study'));
    expect(await screen.findByTestId('probe')).toHaveTextContent('EDIT /admin/opportunities/opp-live/edit');
  });

  it.each([
    ['metaKey', { metaKey: true }],
    ['ctrlKey', { ctrlKey: true }],
    ['shiftKey', { shiftKey: true }],
    ['altKey', { altKey: true }],
    ['the second click of a double-click', { detail: 2 }],
    ['a keyboard-synthesised click', { detail: 0 }],
  ] as const)('does nothing on %s', async (_label, init) => {
    renderAdmin();
    const table = await findStudiesTable();
    clickRowCell(rowFor(table, 'Live study'), init);
    // Let any navigation settle before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('probe')).toBeNull();
    expect(screen.getByRole('columnheader', { name: /^progress$/i })).toBeInTheDocument();
  });

  it('ignores the second click of a double-click on the inline action, and follows a single one', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.click(primaryAction(rowFor(table, 'Live study')), { detail: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('probe')).toBeNull();

    fireEvent.click(primaryAction(rowFor(table, 'Live study')), { detail: 1 });
    expect(await screen.findByTestId('probe')).toHaveTextContent('ANALYTICS /admin/opportunities/opp-live/analytics');
  });
});

describe('Status and Study Type filter client-side (review P1)', () => {
  const resultCount = () => document.querySelector('.admin-result-count');
  const attention = () => screen.getByRole('region', { name: 'Needs attention' });

  it('Draft narrows the table, counts against all 6, and keeps the Broken card', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    expect(within(attention()).getByText('2 studies broken')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'draft' } });

    await waitFor(() => expect(renderedTitles(table)).toEqual(['Draft study']));
    expect(resultCount()).toHaveTextContent('1 of 6 studies');
    // Triage is for the whole list, not a view of the table.
    expect(within(attention()).getByText('2 studies broken')).toBeInTheDocument();
    // No refetch, and nothing but the scope on the wire.
    expect(vi.mocked(getOpportunities)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getOpportunities)).toHaveBeenCalledWith({ scope: 'mine' });
  });

  it('Published counts 4 of 6 - the broken ones are published too', async () => {
    renderAdmin();
    await findStudiesTable();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'published' } });
    await waitFor(() => expect(resultCount()).toHaveTextContent('4 of 6 studies'));
  });

  it('Study Type narrows client-side too', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.change(screen.getByLabelText('Study Type'), { target: { value: 'interview' } });
    await waitFor(() => expect(renderedTitles(table)).toEqual(['Second broken study']));
    expect(resultCount()).toHaveTextContent('1 of 6 studies');
    expect(vi.mocked(getOpportunities)).toHaveBeenCalledTimes(1);
  });

  it('the Broken card clears search, status and type before applying its chip', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'draft' } });
    fireEvent.change(screen.getByLabelText('Study Type'), { target: { value: 'test' } });
    await waitFor(() => expect(renderedTitles(table)).toEqual(['Draft study']));

    fireEvent.click(within(attention()).getByText('2 studies broken').closest('button') as HTMLButtonElement);

    await waitFor(() => expect(renderedTitles(table)).toEqual(['Broken test study', 'Second broken study']));
    expect(screen.getByLabelText('Status')).toHaveValue('');
    expect(screen.getByLabelText('Study Type')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Broken 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(resultCount()).toHaveTextContent('2 of 6 studies');
  });
});

describe('the Next / deadline column (review M1)', () => {
  it('is labelled "Next / deadline" on the header and in the Sort-by control', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    expect(within(table).getByRole('columnheader', { name: /^Next \/ deadline/ })).toBeInTheDocument();
    const option = within(screen.getByLabelText('Sort by')).getByRole('option', { name: 'Next / deadline' });
    expect(option).toHaveValue('next');
  });
});

describe('day labels round DOWN; the warning colour is a 72-hour horizon (round 3)', () => {
  // Round 3 put the labels back to round-down, like every other surface, and
  // accepted that between 3.0 and 4.0 days a note reads "3 days" uncoloured
  // (Petra LATER). The page reads the clock at mount, so only Date is faked
  // here (timers stay real, so findBy still polls), pinned to 09:00 local on a
  // Wednesday with no clock change in the following week.
  const PINNED = new Date(2026, 8, 23, 9, 0, 0);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const at = (days: number) => new Date(PINNED.getTime() + days * DAY_MS).toISOString();
  const deadline = (id: string, title: string, days: number) =>
    study({ id, title, type: 'unmoderated', end_date: at(days) });
  const sessionAt = (id: string, title: string, days: number) =>
    study({
      id,
      title,
      sessions: [
        {
          id: `s-${id}`,
          opportunity_id: id,
          start_time: at(days),
          end_time: new Date(PINNED.getTime() + days * DAY_MS + 60 * 60 * 1000).toISOString(),
          capacity: 3,
          booked_count: 1,
          remaining: 2,
          created_at: '2026-07-01T10:00:00.000Z',
          updated_at: '2026-07-01T10:00:00.000Z',
        },
      ],
    });

  const note = (table: HTMLElement, title: string) =>
    rowFor(table, title).querySelector('.admin-next__note') as HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PINNED);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // GUARD: passes on main too - a deadline-only study (no sessions) already
  // used this floor-day arithmetic there. It is kept (not deleted) because it
  // still pins the boundary the branch's session-override tests below build
  // on, and a regression in the underlying floor(daysLeft) math would fail it
  // on both.
  it('a deadline 2.9 days away reads "2 days left", coloured; a full 4 days away reads "4 days left", uncoloured (D1: floor(daysLeft) <= 3)', async () => {
    // D1 replaced the 72-hour horizon with the close label's own rule: "the
    // close label reads 3 days or fewer" - floor(daysLeft) <= 3, so 3.2 and
    // even 3.99 days still count as soon (see adminDashboard.triage.test.ts,
    // "the closing-soon horizon"). Only a full 4th day away is uncoloured.
    vi.mocked(getOpportunities).mockResolvedValue([
      deadline('opp-d29', 'Closes in 2.9 days', 2.9),
      deadline('opp-d40', 'Closes in 4.0 days', 4.0),
    ] as never);
    renderAdmin();
    const table = await findStudiesTable();

    expect(note(table, 'Closes in 2.9 days')).toHaveTextContent('Closes · 2 days left');
    expect(note(table, 'Closes in 2.9 days')).toHaveClass('admin-next__note--soon');
    expect(note(table, 'Closes in 4.0 days')).toHaveTextContent('Closes · 4 days left');
    expect(note(table, 'Closes in 4.0 days')).not.toHaveClass('admin-next__note--soon');
  });

  it('a session that is also the closing time (no end_date) shows "Closes · N days left" once inside the horizon - a session 5 days out reads "in 5 days", uncoloured', async () => {
    // With no end_date, getClosingTime falls back to the session's own end,
    // so a session inside the closing-soon horizon IS the closing time: D1's
    // "the note shows its close milestone" branch fires for it too, and the
    // note switches from session phrasing ("in N days") to close phrasing
    // ("Closes · N days left") - see the "shows the CLOSE milestone" test
    // below for the same effect with a session that sits genuinely later
    // than a separate end_date.
    vi.mocked(getOpportunities).mockResolvedValue([
      sessionAt('opp-s29', 'Session in 2.9 days', 2.9),
      sessionAt('opp-s5', 'Session in 5 days', 5),
    ] as never);
    renderAdmin();
    const table = await findStudiesTable();

    expect(note(table, 'Session in 2.9 days')).toHaveTextContent('Closes · 2 days left');
    expect(note(table, 'Session in 2.9 days')).toHaveClass('admin-next__note--soon');
    expect(note(table, 'Session in 5 days')).toHaveTextContent(/in 5 days$/);
    expect(note(table, 'Session in 5 days')).not.toHaveClass('admin-next__note--soon');
  });

  it('colours up to (and including) 3.99 days away, and not at a full 4.0 days (D1 boundary)', async () => {
    vi.mocked(getOpportunities).mockResolvedValue([
      deadline('opp-399', 'Closes in 3.99 days', 3.99),
      deadline('opp-400', 'Closes in 4.00 days', 4.0),
    ] as never);
    renderAdmin();
    const table = await findStudiesTable();
    expect(note(table, 'Closes in 3.99 days')).toHaveClass('admin-next__note--soon');
    expect(note(table, 'Closes in 4.00 days')).not.toHaveClass('admin-next__note--soon');
  });

  it('shows the CLOSE milestone, not the next session, whenever the study is closing soon - even though a session sits later (D1)', async () => {
    vi.mocked(getOpportunities).mockResolvedValue([
      { ...sessionAt('opp-window', 'Window ends in 2 days', 5), end_date: at(2) },
      // Control: the same session with no closing window inside the horizon.
      sessionAt('opp-no-window', 'No window, session in 5 days', 5),
    ] as never);
    renderAdmin();
    const table = await findStudiesTable();

    // The note now names the CLOSE date, not the later session...
    expect(note(table, 'Window ends in 2 days')).toHaveTextContent('Closes · 2 days left');
    // ...and is coloured, because the study is in the Closing soon chip.
    expect(note(table, 'Window ends in 2 days')).toHaveClass('admin-next__note--soon');
    expect(note(table, 'No window, session in 5 days')).toHaveTextContent(/in 5 days$/);
    expect(note(table, 'No window, session in 5 days')).not.toHaveClass('admin-next__note--soon');
    expect(screen.getByRole('button', { name: 'Closing soon 1' })).toBeInTheDocument();
  });

  it('a closed study reads "Closed early", never coloured, whatever is still ahead of it (round 3)', async () => {
    // Closed by hand with its window and a slot still ahead: nothing is next.
    vi.mocked(getOpportunities).mockResolvedValue([
      { ...sessionAt('opp-closed-early', 'Closed with a slot tomorrow', 1), status: 'closed', end_date: at(2) },
      // Control: the same dates on a published study ARE coloured, and (D1)
      // name the close date rather than the session.
      { ...sessionAt('opp-open', 'Open with a slot tomorrow', 1), end_date: at(2) },
    ] as never);
    renderAdmin();
    const table = await findStudiesTable();

    expect(note(table, 'Closed with a slot tomorrow')).toHaveTextContent('Closed early');
    expect(note(table, 'Closed with a slot tomorrow')).not.toHaveClass('admin-next__note--soon');
    expect(note(table, 'Open with a slot tomorrow')).toHaveClass('admin-next__note--soon');
    expect(note(table, 'Open with a slot tomorrow')).toHaveTextContent('Closes · 2 days left');
  });
});

describe('the Closing soon card (round 3 copy)', () => {
  it('names the horizon: "Recruitment windows ending in the next 3 days"', async () => {
    vi.mocked(getOpportunities).mockResolvedValue([
      study({ id: 'opp-c1', title: 'Closing one', type: 'unmoderated', end_date: inDays(1) }),
      study({ id: 'opp-c2', title: 'Closing two', type: 'unmoderated', end_date: inDays(2) }),
    ] as never);
    renderAdmin();
    await findStudiesTable();
    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByText('Recruitment windows ending in the next 3 days')).toBeInTheDocument();
  });
});

describe("a non-manager's row goes to the participant Preview (round 3)", () => {
  it('points the title link at the Preview for someone else\'s study, and at the edit page for your own', async () => {
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();

    expect(within(rowFor(table, 'Colleague study')).getByRole('link', { name: 'Colleague study' })).toHaveAttribute(
      'href',
      '/opportunities/opp-colleague'
    );
    // Control: your own study's title goes to its edit page.
    expect(within(rowFor(table, 'Live study')).getByRole('link', { name: 'Live study' })).toHaveAttribute(
      'href',
      '/admin/opportunities/opp-live/edit'
    );
  });

  it("sends a row click on someone else's study to the Preview", async () => {
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();
    clickRowCell(rowFor(table, 'Colleague study'));
    expect(await screen.findByTestId('probe')).toHaveTextContent('PREVIEW /opportunities/opp-colleague');
  });

  it("gives a superadmin the edit page for anyone's study (the control)", async () => {
    auth.value = { user: SUPERADMIN_USER, loading: false, initialAuthCheck: true };
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();
    expect(within(rowFor(table, 'Colleague study')).getByRole('link', { name: 'Colleague study' })).toHaveAttribute(
      'href',
      '/admin/opportunities/opp-colleague/edit'
    );
  });
});

describe('Copy (round 3)', () => {
  it("is disabled on someone else's study, with the reason", async () => {
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();
    // Control: live on your own study.
    const own = openRowMenu(rowFor(table, 'Live study'), 'Live study');
    expect(within(own).getByRole('menuitem', { name: 'Copy' })).not.toBeDisabled();
    fireEvent.click(within(rowFor(table, 'Live study')).getByRole('button', { name: 'Actions for Live study' }));

    const menu = openRowMenu(rowFor(table, 'Colleague study'), 'Colleague study');
    const copy = within(menu).getByRole('menuitem', { name: 'Copy' });
    expect(copy).toBeDisabled();
    expect(copy).toHaveAttribute('title', 'Only the owner can copy this study');
  });

  it('shows a refused Copy in place under the row, not as the page-level load error', async () => {
    vi.mocked(duplicateOpportunity).mockRejectedValueOnce({ response: { status: 500, data: { error: 'Copy failed upstream.' } } });
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.click(within(openRowMenu(rowFor(table, 'Live study'), 'Live study')).getByRole('menuitem', { name: 'Copy' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not copy “Live study”: Copy failed upstream.');
    expect(rowFor(table, 'Live study').nextElementSibling?.contains(alert)).toBe(true);
    // The table is still there - not replaced by the load-failure state.
    expect(screen.queryByText('Failed to load studies')).toBeNull();
    expect(renderedTitles(table)).toHaveLength(6);
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it('announces a successful Copy in place, as a status, BEFORE the list refreshes (round 4)', async () => {
    const refresh = deferred<unknown>();
    vi.mocked(getOpportunities).mockResolvedValueOnce(STUDIES as never).mockReturnValueOnce(refresh.promise as never);
    vi.mocked(duplicateOpportunity).mockResolvedValueOnce({ ...byId('opp-live'), id: 'opp-live-copy' } as never);
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.click(within(openRowMenu(rowFor(table, 'Live study'), 'Live study')).getByRole('menuitem', { name: 'Copy' }));

    // The refresh has not answered, and the copy is already announced.
    const copied = await screen.findByText('Copied “Live study”');
    const status = copied.closest('[role="status"]') as HTMLElement;
    expect(status).not.toBeNull();
    expect(rowFor(table, 'Live study').nextElementSibling?.contains(status)).toBe(true);
    expect(vi.mocked(getOpportunities)).toHaveBeenCalledTimes(2);

    await act(async () => {
      refresh.resolve([...STUDIES, { ...byId('opp-live'), id: 'opp-live-copy', title: 'Live study (copy)' }]);
      await refresh.promise;
    });
    expect(await within(table).findByText('Live study (copy)')).toBeInTheDocument();
  });

  it('keeps the list on screen when the refresh after a Copy fails, says so, and offers Retry (round 4)', async () => {
    vi.mocked(getOpportunities)
      .mockResolvedValueOnce(STUDIES as never)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(STUDIES as never);
    vi.mocked(duplicateOpportunity).mockResolvedValueOnce({ ...byId('opp-live'), id: 'opp-live-copy' } as never);
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.click(within(openRowMenu(rowFor(table, 'Live study'), 'Live study')).getByRole('menuitem', { name: 'Copy' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Copied “Live study”, but the list could not be refreshed to show the copy.');
    // Not the page-level load failure: the six rows are still there.
    expect(screen.queryByText('Failed to load studies')).toBeNull();
    expect(renderedTitles(table)).toHaveLength(6);
    expect(rowFor(table, 'Live study').nextElementSibling?.contains(alert)).toBe(true);
    const retry = within(alert).getByRole('button', { name: 'Retry' });
    await waitFor(() => expect(document.activeElement).toBe(retry));

    fireEvent.click(retry);
    await waitFor(() => expect(vi.mocked(getOpportunities)).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('Copied “Live study”').closest('[role="status"]')).not.toBeNull();
  });

  it('after a successful Retry, re-arms the 8000ms Copied lapse and hands focus to the study (L-A)', async () => {
    vi.mocked(getOpportunities)
      .mockResolvedValueOnce(STUDIES as never)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(STUDIES as never);
    vi.mocked(duplicateOpportunity).mockResolvedValueOnce({ ...byId('opp-live'), id: 'opp-live-copy' } as never);
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.click(within(openRowMenu(rowFor(table, 'Live study'), 'Live study')).getByRole('menuitem', { name: 'Copy' }));
    const retry = within(await screen.findByRole('alert')).getByRole('button', { name: 'Retry' });
    await waitFor(() => expect(document.activeElement).toBe(retry));

    vi.useFakeTimers();
    try {
      fireEvent.click(retry);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const copied = screen.getByText('Copied “Live study”').closest('[role="status"]');
      expect(copied).not.toBeNull();
      // Focus did not fall to <body> with the Retry button: it is on the study.
      expect(document.activeElement).toBe(within(rowFor(table, 'Live study')).getByRole('link', { name: 'Live study' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(7999);
      });
      expect(screen.queryByText('Copied “Live study”')).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.queryByText('Copied “Live study”')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the first Copied notice lapse after 8000ms too (the control for the Retry case)', async () => {
    vi.mocked(duplicateOpportunity).mockResolvedValueOnce({ ...byId('opp-live'), id: 'opp-live-copy' } as never);
    renderAdmin();
    const table = await findStudiesTable();
    const menu = openRowMenu(rowFor(table, 'Live study'), 'Live study');
    vi.useFakeTimers();
    try {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7999);
      });
      expect(screen.queryByText('Copied “Live study”')).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.queryByText('Copied “Live study”')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
