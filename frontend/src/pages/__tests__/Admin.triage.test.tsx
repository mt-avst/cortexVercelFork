import { screen, fireEvent, within, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getDashboardStats, getOpportunities, updateOpportunity } from '../../api/client';
import {
  ADMIN_USER,
  STATS,
  STUDIES,
  SUPERADMIN_USER,
  byId,
  findStudiesTable,
  openRowMenu,
  renderAdmin,
  renderedTitles,
  rowFor,
  showAllResearchers,
  statusLabel,
  trackLapseTimers,
  undoNotice,
} from './helpers/admin-triage';

/**
 * Admin Research Studies table, Step 2 (MR B) - the triage behaviour as the
 * page renders it: the Status-ascending default order, Close study with its
 * Undo notice, the row's next-verb button, the owner on the meta line, the
 * Broken chip and the Needs attention broken card.
 *
 * Policy numbers are LITERALS here (the 8000ms undo window), never read from
 * Admin.tsx. The component computes "now" from the real clock at mount, so
 * the fixture's milestones are placed relative to the real clock too, at
 * distances (10 and 30 days) no test run can straddle.
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

describe('the default order (Petra 3.2, AC11/AC12)', () => {
  it('lists broken studies, then drafts, then live ones by next milestone, then closed', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    // Two broken (no milestone, so title A-Z), the draft, the published two
    // soonest milestone first (10 days before 30), the closed one last.
    expect(renderedTitles(table)).toEqual([
      'Broken test study',
      'Second broken study',
      'Draft study',
      'Colleague study',
      'Live study',
      'Closed study',
    ]);
  });
});

describe('Close study (Petra 3.4)', () => {
  it('closes the study with status "closed", updates the row in place and offers Undo with focus', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const row = rowFor(table, 'Live study');
    // Control: the row starts published, and the caption query below can see
    // a caption - the fixture's already-closed study carries one.
    expect(statusLabel(row)).toBe('PUBLISHED');
    expect(rowFor(table, 'Closed study').querySelector('.admin-pill--auto-closed')).not.toBeNull();

    const menu = openRowMenu(row, 'Live study');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Close study' }));

    await waitFor(() => expect(undoNotice('Live study')).not.toBeNull());
    expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateOpportunity)).toHaveBeenCalledWith('opp-live', { status: 'closed' });

    const notice = undoNotice('Live study') as HTMLElement;
    expect(notice).toHaveAttribute('role', 'status');
    const undo = within(notice).getByRole('button', { name: 'Undo' });
    expect(document.activeElement).toBe(undo);

    // In place: the same row now reads Closed, with no "Auto-closed" caption -
    // a researcher closed it, not the sweep.
    const closedRow = rowFor(table, 'Live study');
    expect(statusLabel(closedRow)).toBe('CLOSED');
    expect(closedRow.querySelector('.admin-pill--auto-closed')).toBeNull();
    expect(within(closedRow).queryByText('Auto-closed')).toBeNull();
    // No reload was needed to get there.
    expect(vi.mocked(getOpportunities)).toHaveBeenCalledTimes(1);
  });

  it('Undo reopens the study with status "published" and hands focus back to its title', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    fireEvent.click(within(openRowMenu(rowFor(table, 'Live study'), 'Live study')).getByRole('menuitem', { name: 'Close study' }));
    await waitFor(() => expect(undoNotice('Live study')).not.toBeNull());

    fireEvent.click(within(undoNotice('Live study') as HTMLElement).getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(undoNotice('Live study')).toBeNull());
    expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateOpportunity)).toHaveBeenLastCalledWith('opp-live', { status: 'published' });
    expect(statusLabel(rowFor(table, 'Live study'))).toBe('PUBLISHED');
    const titleLink = within(rowFor(table, 'Live study')).getByRole('link', { name: 'Live study' });
    await waitFor(() => expect(document.activeElement).toBe(titleLink));
  });

  it("a refused Undo shows the server's reason in an alert and leaves the row closed", async () => {
    const reason = 'This study needs at least one upcoming session before it can be published.';
    vi.mocked(updateOpportunity)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce({ response: { status: 400, data: { error: reason } } });
    renderAdmin();
    const table = await findStudiesTable();
    // Control: no alert on the page before the refusal.
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(within(openRowMenu(rowFor(table, 'Live study'), 'Live study')).getByRole('menuitem', { name: 'Close study' }));
    await waitFor(() => expect(undoNotice('Live study')).not.toBeNull());
    fireEvent.click(within(undoNotice('Live study') as HTMLElement).getByRole('button', { name: 'Undo' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`Could not reopen “Live study”: ${reason}`);
    expect(vi.mocked(updateOpportunity)).toHaveBeenLastCalledWith('opp-live', { status: 'published' });
    // The truth: it is still closed, and the Undo is spent.
    expect(statusLabel(rowFor(table, 'Live study'))).toBe('CLOSED');
    expect(undoNotice('Live study')).toBeNull();
    // The control it came from has gone, so the alert takes focus.
    expect(document.activeElement).toBe(alert);
  });

  describe('the undo window', () => {
    /** Loads under real timers, then closes the study under fake ones. */
    const closeUnderFakeTimers = async () => {
      const rendered = renderAdmin();
      const table = await findStudiesTable();
      const menu = openRowMenu(rowFor(table, 'Live study'), 'Live study');
      vi.useFakeTimers();
      const tracked = trackLapseTimers();
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Close study' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      return { ...rendered, ...tracked, table };
    };

    let restoreSpy: (() => void) | null = null;
    afterEach(() => {
      restoreSpy?.();
      restoreSpy = null;
      vi.useRealTimers();
    });

    it('stays for 8000ms and then goes', async () => {
      const { fired, spy } = await closeUnderFakeTimers();
      restoreSpy = () => spy.mockRestore();

      expect(undoNotice('Live study')).not.toBeNull();
      // Control for the unmount test below: the 8000ms timer was armed once.
      expect(fired.armed).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(7999);
      });
      expect(undoNotice('Live study')).not.toBeNull();
      expect(fired.count).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(undoNotice('Live study')).toBeNull();
      expect(fired.count).toBe(1);
      // Lapsing is not undoing: no second PATCH.
      expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(1);
    });

    it('fires nothing once the page has unmounted', async () => {
      const { fired, spy, unmount } = await closeUnderFakeTimers();
      restoreSpy = () => spy.mockRestore();

      // Control: the notice is up and its lapse timer really is armed.
      expect(undoNotice('Live study')).not.toBeNull();
      expect(fired.armed).toBe(1);

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(fired.count).toBe(0);
      expect(vi.mocked(updateOpportunity)).toHaveBeenCalledTimes(1);
    });
  });
});

describe('who is offered Close study', () => {
  const menuItemNames = (menu: HTMLElement) =>
    within(menu).getAllByRole('menuitem').map((el) => el.textContent?.trim());

  it('your own published study: Edit, Preview as participant, Analytics, Copy, Close study, Delete', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const menu = openRowMenu(rowFor(table, 'Live study'), 'Live study');
    expect(menuItemNames(menu)).toEqual(['Edit', 'Preview as participant', 'Analytics', 'Copy', 'Close study', 'Delete']);
  });

  /**
   * Control arm for every "not offered" test: the same render DOES offer
   * Close study on your own published study, so an absence below means
   * gated, not missing from the build altogether. Toggles the menu shut
   * again afterwards.
   */
  const expectOfferedOnOwnPublished = (table: HTMLElement) => {
    const row = rowFor(table, 'Live study');
    const menu = openRowMenu(row, 'Live study');
    expect(within(menu).getByRole('menuitem', { name: 'Close study' })).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Actions for Live study' }));
    expect(screen.queryByRole('menu')).toBeNull();
  };

  it.each([
    ['a draft', 'Draft study'],
    ['a closed study', 'Closed study'],
  ])('not on %s', async (_label, title) => {
    renderAdmin();
    const table = await findStudiesTable();
    expectOfferedOnOwnPublished(table);
    const menu = openRowMenu(rowFor(table, title), title);
    // Control: the menu itself rendered in full.
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Close study' })).toBeNull();
  });

  it("not on another owner's published study under Show all researchers", async () => {
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();
    expectOfferedOnOwnPublished(table);

    const menu = openRowMenu(rowFor(table, 'Colleague study'), 'Colleague study');
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Close study' })).toBeNull();
  });

  it("but a superadmin is offered it on another owner's study (the control)", async () => {
    auth.value = {
      user: SUPERADMIN_USER,
      loading: false,
      initialAuthCheck: true,
    };
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();

    const menu = openRowMenu(rowFor(table, 'Colleague study'), 'Colleague study');
    expect(within(menu).getByRole('menuitem', { name: 'Close study' })).toBeInTheDocument();
  });
});

describe("the row's inline button is the state's next verb (Petra 3.4)", () => {
  // A router link since the fix round: every verb is a page, so a
  // modifier-click opens a new tab.
  const primaryButton = (row: HTMLElement) => row.querySelector<HTMLAnchorElement>('.admin-action-primary');

  it('reads Fix, Edit, Analytics or Preview by state and owner', async () => {
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();

    expect(primaryButton(rowFor(table, 'Broken test study'))).toHaveTextContent(/^Fix$/);
    expect(primaryButton(rowFor(table, 'Draft study'))).toHaveTextContent(/^Edit$/);
    expect(primaryButton(rowFor(table, 'Live study'))).toHaveTextContent(/^Analytics$/);
    expect(primaryButton(rowFor(table, 'Closed study'))).toHaveTextContent(/^Analytics$/);
    expect(primaryButton(rowFor(table, 'Colleague study'))).toHaveTextContent(/^Preview$/);
  });

  // Draft -> Edit -> the edit page is unchanged from before Step 2 and is kept
  // as a regression guard; the other three rows are new behaviour.
  it.each([
    ['Broken test study', 'Fix', 'EDIT /admin/opportunities/opp-broken-a/edit'],
    ['Draft study', 'Edit', 'EDIT /admin/opportunities/opp-draft/edit'],
    ['Live study', 'Analytics', 'ANALYTICS /admin/opportunities/opp-live/analytics'],
    ['Colleague study', 'Preview', 'PREVIEW /opportunities/opp-colleague'],
  ])('%s: %s goes where the verb says', async (title, label, destination) => {
    renderAdmin();
    const table = await findStudiesTable();
    const button = primaryButton(rowFor(table, title)) as HTMLAnchorElement;
    expect(button).toHaveTextContent(label);
    fireEvent.click(button);
    expect(await screen.findByTestId('probe')).toHaveTextContent(destination);
  });

  it('the title is a real link to the study overview page', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const link = within(rowFor(table, 'Live study')).getByRole('link', { name: 'Live study' });
    expect(link).toHaveAttribute('href', '/admin/opportunities/opp-live');
  });
});

describe('the owner on the meta line (AC18)', () => {
  it('is absent while the table shows only your studies, and appears when Show all researchers is pressed', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    // Control: the meta line itself rendered.
    expect(rowFor(table, 'Colleague study').querySelector('.admin-study-meta')).not.toBeNull();
    expect(table.querySelector('.admin-study-owner')).toBeNull();
    expect(within(table).queryByText('Dana Owner')).toBeNull();

    // The other half of "iff": the same rows, the toggle pressed.
    const widened = await showAllResearchers();
    expect(within(rowFor(widened, 'Colleague study')).getByText('Dana Owner')).toBeInTheDocument();
  });

  it('joins the meta line, after the type pill and before the purpose, under Show all researchers', async () => {
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();

    const meta = rowFor(table, 'Colleague study').querySelector('.admin-study-meta') as HTMLElement;
    const owner = meta.querySelector('.admin-study-owner');
    expect(owner).not.toBeNull();
    expect(owner).toHaveTextContent('Dana Owner');
    const order = Array.from(meta.children).map((el) =>
      el.classList.contains('admin-pill') ? 'type' : el.classList.contains('admin-study-owner') ? 'owner' : el.classList.contains('row-desc') ? 'purpose' : 'other'
    );
    expect(order).toEqual(['type', 'owner', 'purpose']);
  });

  it('falls back to the owner email when the owner has no name', async () => {
    vi.mocked(getOpportunities).mockResolvedValue([
      { ...byId('opp-colleague'), owner_name: undefined, owner_email: 'dana@example.com' },
    ] as never);
    renderAdmin();
    await findStudiesTable();
    const table = await showAllResearchers();
    expect(rowFor(table, 'Colleague study').querySelector('.admin-study-owner')).toHaveTextContent('dana@example.com');
  });
});

describe('the Auto-closed caption', () => {
  it('shows only for auto_closed: true - not for auto_closed: false, nor a response without the field', async () => {
    vi.mocked(getOpportunities).mockResolvedValue([
      byId('opp-closed'),
      { ...byId('opp-closed'), id: 'opp-closed-by-hand', title: 'Closed by hand', auto_closed: false },
      { ...byId('opp-closed'), id: 'opp-closed-unknown', title: 'Closed, unknown how', auto_closed: undefined },
    ] as never);
    renderAdmin();
    const table = await findStudiesTable();
    expect(within(rowFor(table, 'Closed study')).getByText('Auto-closed')).toBeInTheDocument();
    expect(within(rowFor(table, 'Closed by hand')).queryByText('Auto-closed')).toBeNull();
    expect(within(rowFor(table, 'Closed, unknown how')).queryByText('Auto-closed')).toBeNull();
    // Control: all three rows really are closed.
    expect(statusLabel(rowFor(table, 'Closed by hand'))).toBe('CLOSED');
    expect(statusLabel(rowFor(table, 'Closed, unknown how'))).toBe('CLOSED');
  });
});

describe('quick-filter chips carry counts (Petra 3.3, AC16)', () => {
  const chip = (name: string) => screen.getByRole('button', { name });

  it('shows every chip with its count, Broken first', async () => {
    renderAdmin();
    await findStudiesTable();
    const chips = Array.from(document.querySelectorAll('.admin-quick-filters .admin-chip')).map((el) =>
      el.textContent?.replace(/\s+/g, ' ').trim()
    );
    expect(chips).toEqual(['Broken 2', 'Needs recruitment 1', 'Draft 1', 'Closing soon 0', 'Fully booked 1']);
  });

  it('the Broken chip is live with broken studies and narrows the table to them', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const broken = chip('Broken 2');
    expect(broken).not.toBeDisabled();
    expect(broken).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(broken);

    expect(chip('Broken 2')).toHaveAttribute('aria-pressed', 'true');
    expect(renderedTitles(table)).toEqual(['Broken test study', 'Second broken study']);
    expect(screen.getByText('2 of 6 studies')).toBeInTheDocument();
  });

  it('a zero-count chip is disabled, not hidden', async () => {
    renderAdmin();
    await findStudiesTable();
    // Control: a chip with something to show is enabled.
    expect(chip('Fully booked 1')).not.toBeDisabled();
    expect(chip('Closing soon 0')).toBeDisabled();
  });

  it('the Broken chip reads "Broken 0" and is disabled when nothing is broken', async () => {
    vi.mocked(getOpportunities).mockResolvedValue([byId('opp-live'), byId('opp-draft'), byId('opp-closed')] as never);
    renderAdmin();
    await findStudiesTable();
    expect(chip('Broken 0')).toBeInTheDocument();
    expect(chip('Broken 0')).toBeDisabled();
  });
});

describe('the Needs attention broken card (Petra 3.3, AC16)', () => {
  const attention = () => screen.getByRole('region', { name: 'Needs attention' });

  it('counts two broken studies in the plural, and its link applies the Broken chip', async () => {
    renderAdmin();
    const table = await findStudiesTable();
    const lead = within(attention()).getByText('2 studies broken');
    fireEvent.click(lead.closest('button') as HTMLButtonElement);

    expect(screen.getByRole('button', { name: 'Broken 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(renderedTitles(table)).toEqual(['Broken test study', 'Second broken study']);
  });

  it('names a single broken study in the singular, and opens it', async () => {
    vi.mocked(getOpportunities).mockResolvedValue([byId('opp-broken-a'), byId('opp-live')] as never);
    renderAdmin();
    await findStudiesTable();
    const lead = within(attention()).getByText('1 study broken');
    const card = lead.closest('button') as HTMLButtonElement;
    expect(within(card).getByText('Broken test study')).toBeInTheDocument();

    fireEvent.click(card);
    expect(await screen.findByTestId('probe')).toHaveTextContent('EDIT /admin/opportunities/opp-broken-a/edit');
  });

  it('is absent when nothing is broken', async () => {
    // Control arm first: the same queries DO find the card when one study is
    // broken, so the absence below is the rule, not a query that cannot see.
    vi.mocked(getOpportunities).mockResolvedValue([byId('opp-broken-a'), byId('opp-live')] as never);
    const first = renderAdmin();
    await findStudiesTable();
    expect(within(attention()).getByText(/stud(y|ies) broken/)).toBeInTheDocument();
    expect(document.querySelector('.admin-attention__card--broken')).not.toBeNull();
    first.unmount();

    vi.mocked(getOpportunities).mockResolvedValue([byId('opp-live'), byId('opp-draft'), byId('opp-closed')] as never);
    renderAdmin();
    await findStudiesTable();
    // The panel itself rendered, in its all-clear state.
    expect(within(attention()).getByText(/All caught up/)).toBeInTheDocument();
    expect(within(attention()).queryByText(/stud(y|ies) broken/)).toBeNull();
    expect(document.querySelector('.admin-attention__card--broken')).toBeNull();
  });
});
