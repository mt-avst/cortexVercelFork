import React, { useEffect, useId, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Icon, SortCaret } from '../ui';
import {
  QUICK_FILTERS,
  QuickFilter,
  SortDirection,
  StatusFilter,
  StudySortField,
} from '../../utils/adminDashboard';
import { useScrollEdgeCue } from '../../hooks/useScrollEdgeCue';

export interface PhoneStudyFiltersProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
  statusFilter: StatusFilter;
  onStatusChange: (value: StatusFilter) => void;
  typeFilter: string;
  onTypeChange: (value: string) => void;
  /** Whether there is anything to sort - mirrors Admin.tsx's own
   * `showSortControl` (no rows yet, or the table errored). */
  showSort: boolean;
  sortField: StudySortField;
  sortDirection: SortDirection;
  onSortFieldChange: (field: StudySortField) => void;
  onToggleSortDirection: () => void;
  /** Whether sort is at Admin.tsx's own starting field/direction - the
   * "Filters" badge counts a non-default sort as an active filter alongside
   * Status and Study Type. */
  sortIsDefault: boolean;
  quickFilter: QuickFilter | null;
  quickFilterCounts: Record<QuickFilter, number>;
  onToggleQuickFilter: (filter: QuickFilter) => void;
  hasActiveFilters: boolean;
  resultShown: number;
  resultTotal: number;
  onClearFilters: () => void;
  resultCountRef: React.RefObject<HTMLSpanElement>;
  /** the whole toolbar's own root, so a Needs attention
   * card's "View studies" can scroll it into view below 576px - mirrors
   * Admin.tsx's `quickFiltersRef`, which is attached only to the >=576px
   * `.admin-quick-filters` and has nothing to find down here. */
  containerRef?: React.Ref<HTMLDivElement>;
}

/**
 * The phone (<576px) filter toolbar,
 * replacing the always-on Status/Type/Sort-by fields the >=576px layout
 * still uses (the two variants are genuinely different UIs, not one
 * responsive one - see Admin.tsx, which renders this OR the wider layout,
 * never both).
 *
 * Row 1: the search field and a "Filters" disclosure button carrying an
 * active-count badge. Row 2 (always rendered, chips never move into the
 * disclosure): the quick-filter chips on one scrolling line, with the same
 * edge-cue convention the tab strip uses. Row 3: the result count and Clear,
 * in a slot whose height is reserved whether or not either is showing, so
 * applying a filter never shifts the first list item down.
 *
 * Extracted out of `Admin.tsx` - one of two blocks pulled out to keep that
 * file's size down, the other being the kebab's own
 * item order (`components/admin/kebabOrder.tsx`).
 */
export const PhoneStudyFilters: React.FC<PhoneStudyFiltersProps> = ({
  searchQuery,
  onSearchChange,
  searchInputRef,
  statusFilter,
  onStatusChange,
  typeFilter,
  onTypeChange,
  showSort,
  sortField,
  sortDirection,
  onSortFieldChange,
  onToggleSortDirection,
  sortIsDefault,
  quickFilter,
  quickFilterCounts,
  onToggleQuickFilter,
  hasActiveFilters,
  resultShown,
  resultTotal,
  onClearFilters,
  resultCountRef,
  containerRef,
}) => {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const activeCount =
    (statusFilter ? 1 : 0) + (typeFilter ? 1 : 0) + (showSort && !sortIsDefault ? 1 : 0);

  // Focus goes into the panel on open (the Status select, its first
  // control); Escape closes it and returns focus to the toggle - the
  // standard disclosure pattern.
  useEffect(() => {
    if (open) firstFieldRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // this used to listen on `document` unconditionally, so the one
      // Escape a reader meant for an OPEN ROW MENU (elsewhere on the page)
      // also closed this panel and scrolled the page to it - scoped to the
      // panel and its own toggle, the only two elements Escape here should
      // ever answer to.
      const target = event.target as Node | null;
      const withinPanel = target && panelRef.current?.contains(target);
      const onToggle = target && toggleRef.current?.contains(target);
      if (!withinPanel && !onToggle) return;
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // The quick-filter chip row's own scroll-edge cue - the same convention
  // the tab strip uses (Admin.tsx). The chip count of studies can change
  // under the reader (a Close/Reopen, a background refresh) without the
  // viewport resizing, so `quickFilterCounts` is passed as an extra
  // recompute trigger alongside scroll/resize/box-resize.
  const { ref: chipsRef, cue: chipsScroll, update: updateChipsScroll } = useScrollEdgeCue<HTMLDivElement>([
    quickFilterCounts,
  ]);

  return (
    <div className="admin-phone-filters" ref={containerRef}>
      <div className="admin-phone-filters__row1">
        <div className="admin-phone-filters__search">
          <label htmlFor="searchFilter" className="form-label mb-0 visually-hidden">
            Search Studies
          </label>
          <input
            ref={searchInputRef}
            type="text"
            id="searchFilter"
            className="form-control"
            placeholder="Search studies..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <button
          ref={toggleRef}
          type="button"
          className="admin-phone-filters__toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
        >
          <Icon icon={SlidersHorizontal} size={16} aria-hidden="true" />
          Filters
          {activeCount > 0 && (
            <span className="admin-phone-filters__badge">{activeCount}</span>
          )}
        </button>
      </div>

      {open && (
        <div id={panelId} className="admin-phone-filters__panel" ref={panelRef}>
          <div className="admin-phone-filters__field">
            <label htmlFor="statusFilter" className="form-label mb-1">Status</label>
            <select
              ref={firstFieldRef}
              id="statusFilter"
              className="form-select"
              value={statusFilter}
              onChange={(e) => onStatusChange(e.target.value as StatusFilter)}
            >
              <option value="">All Statuses</option>
              <option value="broken">Broken</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div className="admin-phone-filters__field">
            <label htmlFor="typeFilter" className="form-label mb-1">Study Type</label>
            <select
              id="typeFilter"
              className="form-select"
              value={typeFilter}
              onChange={(e) => onTypeChange(e.target.value)}
            >
              <option value="">All Types</option>
              <option value="test">Live session</option>
              <option value="interview">Interview</option>
              <option value="unmoderated">Recorded session</option>
              <option value="poll">Poll</option>
              <option value="survey">Survey</option>
              <option value="question">One question</option>
            </select>
          </div>
          {showSort && (
            <div className="admin-phone-filters__field">
              <label htmlFor="cardSortField" className="form-label mb-1">Sort by</label>
              <div className="admin-phone-filters__sort-row">
                <select
                  id="cardSortField"
                  className="form-select"
                  value={sortField}
                  onChange={(e) => onSortFieldChange(e.target.value as StudySortField)}
                >
                  <option value="title">Study</option>
                  <option value="status">Status</option>
                  <option value="next">Next / deadline</option>
                  <option value="created_at">Created</option>
                </select>
                <button
                  type="button"
                  className="admin-card-sort-dir"
                  onClick={onToggleSortDirection}
                  aria-label={`Sort direction: ${sortDirection === 'asc' ? 'Ascending' : 'Descending'}`}
                >
                  <SortCaret active direction={sortDirection} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div
        className={`admin-phone-chips${chipsScroll.left ? ' admin-phone-chips--scroll-left' : ''}${
          chipsScroll.right ? ' admin-phone-chips--scroll-right' : ''
        }`}
      >
        <div className="admin-phone-chips__track" ref={chipsRef} onScroll={updateChipsScroll}>
          {QUICK_FILTERS.map((chip) => {
            const active = quickFilter === chip.key;
            const count = quickFilterCounts[chip.key];
            return (
              <button
                key={chip.key}
                type="button"
                className={`admin-chip admin-phone-chip ${active ? 'admin-chip--active' : ''}`}
                aria-pressed={active}
                disabled={count === 0 && !active}
                onClick={() => onToggleQuickFilter(chip.key)}
              >
                {chip.label}{' '}
                <span className="admin-chip__count">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* The result-count/Clear slot is always rendered, so applying a
          filter never shifts the first list item down.
          the `role="status"` SPAN itself now stays
          mounted too, rather than absent when idle - some screen
          readers drop the first announcement from a live region that
          appears already holding text, so unmounting and remounting it on
          every filter toggle risked exactly that. Idle it reads the total
          ("16 studies"), the same text the desktop count gives (Admin.tsx)
          - it used to render empty there, leaving a permanently blank 42px
          band above the phone list with nothing in it to explain why the
          space was there. */}
      <div className="admin-phone-filters__results">
        <span
          className="admin-result-count"
          role="status"
          ref={resultCountRef}
          tabIndex={-1}
        >
          {hasActiveFilters
            ? `${resultShown} of ${resultTotal} ${resultTotal === 1 ? 'study' : 'studies'}`
            : `${resultTotal} ${resultTotal === 1 ? 'study' : 'studies'}`}
        </span>
        {hasActiveFilters && (
          <button type="button" className="admin-clear-filters" onClick={onClearFilters}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
};

export default PhoneStudyFilters;
