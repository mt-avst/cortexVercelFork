import type { Opportunity } from '../../api/types';
import {
  matchesQuickFilter,
  matchesStatusFilter,
  matchesTypeFilter,
  sortStudies,
  QuickFilter,
  SortDirection,
  StatusFilter,
  StudySortField,
} from '../../utils/adminDashboard';

export type TableRowKind = 'row' | 'noticeOnly' | 'errorSlot' | 'reopenNoticeOnly';

export type TableRow = { study: Opportunity; kind: TableRowKind };

export interface BuildTableRowsInput {
  /** The pre-close study whose sort position is held while its Undo is up
   * (`closeUndo.frozenSnapshot`). */
  frozen: Opportunity | null;
  /** A refused Undo's pre-close snapshot (`closeUndo.actionError?.anchor`). */
  errorAnchor: Opportunity | null;
  /** The pre-reopen (closed) snapshot a live "Reopened" notice sorts on
   * (`closeUndo.reopenNotice?.snapshot`). */
  reopenSnapshot: Opportunity | null;
  sortedOpportunities: Opportunity[];
  quickFilteredOpportunities: Opportunity[];
  opportunities: Opportunity[];
  debouncedSearchQuery: string;
  statusFilter: StatusFilter;
  typeFilter: string;
  quickFilter: QuickFilter | null;
  sortField: StudySortField;
  sortDirection: SortDirection;
  now: Date;
}

/**
 * What the table draws. The same rows, with three in-place exceptions, all
 * sorted on the study as it was BEFORE the change that moved it, so they
 * hold the place the reader was looking at:
 *  - while a study's Close notice is up, its row sorts on that snapshot and
 *    stays under the pointer with Undo beneath it. If the live filters no
 *    longer match it (a closed study under the Broken chip), its notice
 *    stays alone in that place ('noticeOnly'), so Undo is still there.
 *  - after a refused Undo, the error takes the notice's slot on its own
 *    ('errorSlot'), while the row itself moves to its live place.
 *  - a Reopen has the same problem Close always had - reopening a study
 *    under the Closed filter (or Broken, if it was also broken) takes it
 *    out of the live list, so its "Reopened" notice (Admin.tsx's render
 *    loop) has nowhere left to render. Mirrors 'noticeOnly' exactly, sorted
 *    on the CLOSED snapshot the reopen started from (useCloseStudyUndo keeps
 *    it on `reopenNotice.snapshot`) - 'reopenNoticeOnly' renders just the
 *    "Reopened" notice, with no row above it.
 * No extra entry is counted: counts and filters read live status.
 *
 * Extracted out of Admin.tsx (cto/AdaptaLabs#163) as a pure function - the
 * page still wraps this in its own `useMemo` with the same dependency list.
 */
export function buildTableRows({
  frozen,
  errorAnchor,
  reopenSnapshot,
  sortedOpportunities,
  quickFilteredOpportunities,
  opportunities,
  debouncedSearchQuery,
  statusFilter,
  typeFilter,
  quickFilter,
  sortField,
  sortDirection,
  now,
}: BuildTableRowsInput): TableRow[] {
  if (!frozen && !errorAnchor && !reopenSnapshot) {
    return sortedOpportunities.map((study) => ({ study, kind: 'row' }));
  }
  const query = debouncedSearchQuery.toLowerCase();
  // Whether a pre-change snapshot would be on screen under the current filters.
  const wasShown = (snapshot: Opportunity) =>
    (!query ||
      snapshot.title.toLowerCase().includes(query) ||
      snapshot.purpose_one_liner.toLowerCase().includes(query) ||
      Boolean(snapshot.description_optional?.toLowerCase().includes(query))) &&
    matchesStatusFilter(snapshot, statusFilter, now) &&
    matchesTypeFilter(snapshot, typeFilter) &&
    (!quickFilter || matchesQuickFilter(snapshot, quickFilter, now));
  const frozenLive = frozen !== null && quickFilteredOpportunities.some((opp) => opp.id === frozen.id);
  // Still shown under the live filters, either way: the row
  // sorts on its pre-reopen (closed) snapshot while the notice is up - the
  // same freeze Close gives its own row - so it stays under the reader
  // rather than jumping to its new, published sort position and taking
  // focus and the notice off screen with it. Only a reopen the live
  // filters now EXCLUDE (Closed, or Broken if it was also broken) needs
  // the placeholder slot below instead.
  const reopenLive =
    reopenSnapshot !== null && quickFilteredOpportunities.some((opp) => opp.id === reopenSnapshot.id);
  let input: Opportunity[] = quickFilteredOpportunities;
  if (frozenLive) input = input.map((opp) => (opp.id === frozen!.id ? frozen! : opp));
  if (reopenLive) input = input.map((opp) => (opp.id === reopenSnapshot!.id ? reopenSnapshot! : opp));
  if (frozen && !frozenLive && wasShown(frozen)) input = [...input, frozen];
  if (errorAnchor && wasShown(errorAnchor)) input = [...input, errorAnchor];
  if (reopenSnapshot && !reopenLive && wasShown(reopenSnapshot)) input = [...input, reopenSnapshot];
  const liveById = new Map(opportunities.map((opp) => [opp.id, opp]));
  // sortStudies returns the same objects it was given, so the snapshots are
  // told apart from live rows by identity.
  return sortStudies(input, sortField, sortDirection, now).map((viewed): TableRow => {
    if (viewed === errorAnchor) return { study: viewed, kind: 'errorSlot' };
    if (viewed === reopenSnapshot) return { study: liveById.get(viewed.id) ?? viewed, kind: reopenLive ? 'row' : 'reopenNoticeOnly' };
    if (viewed === frozen) return { study: liveById.get(viewed.id) ?? viewed, kind: frozenLive ? 'row' : 'noticeOnly' };
    return { study: viewed, kind: 'row' };
  });
}
