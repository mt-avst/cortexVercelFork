import React from 'react';
import { ClipboardList, Users, Calendar, Clock } from 'lucide-react';
import { Icon } from '../ui';
import type { DashboardStats } from '../../api/client';
import type { SessionsThisWeek } from '../../utils/adminDashboard';

interface AdminSnapshotStripProps {
  dashboardStats: DashboardStats;
  sessionsThisWeek: SessionsThisWeek;
  showAllResearchers: boolean;
  onToggleShowAllResearchers: () => void;
}

/**
 * The Admin page's "Operational snapshot": one row-high strip of four
 * tiles (label, value and sub-caption inline per item, a divider between
 * items) and its own "Show all researchers" toggle. Self-contained - reads
 * only `dashboardStats` and `sessionsThisWeek`, both already computed by
 * the caller, so it owns none of the fetch/derive logic itself.
 *
 * These numbers are OWNER-SCOPED for a researcher admin - the backend
 * filters every query on owner_user_id - and global for a superadmin. Same
 * cards, different meaning, and the page used to say neither, so a count
 * read as the platform total to the person who owned part of it. The scope
 * note keeps that honest.
 *
 * "Overdue sessions" from the wireframe is omitted: the frontend has no
 * per-session completion flag to compute it from.
 */
export const AdminSnapshotStrip: React.FC<AdminSnapshotStripProps> = ({
  dashboardStats,
  sessionsThisWeek,
  showAllResearchers,
  onToggleShowAllResearchers,
}) => (
  <section className="admin-snapshot" aria-labelledby="admin-snapshot-heading">
    <div className="admin-section-head">
      <h2 id="admin-snapshot-heading" className="admin-section-title">Operational snapshot</h2>
      <div className="d-flex align-items-center gap-2">
        {/* The scope note reads the toggle, not the role: it is the
            caller's own studies until they widen it, whoever they are. */}
        <span className="stat-scope-note">
          {showAllResearchers
            ? 'Across every researcher on Cortex'
            : 'Your studies only'}
        </span>
        {/* Decision 2: one toggle for both the snapshot and the studies
            table. A pressed toggle button (stable label, aria-pressed
            carries the state) rather than a relabelling button, so a
            screen reader hears one control change state. */}
        <button
          type="button"
          className="admin-chip"
          aria-pressed={showAllResearchers}
          onClick={onToggleShowAllResearchers}
        >
          Show all researchers
        </button>
      </div>
    </div>
    {/* The four tiles collapse to one row-high strip - label, value and
        sub-caption inline per item, a divider between items - rather than
        four stacked cards each carrying a 3rem headline number. That stack
        (icon row + big number + caption, each its own line) was most of
        the ~93px this strip needed to clear the 1440x900 fold; the numbers
        themselves are unchanged. Wraps to a 2-up grid below 1024px, where
        a single row of four has no room left to shrink into. */}
    <div className="admin-snapshot-strip mb-3">
      <div className="admin-snapshot-item">
        <Icon icon={ClipboardList} size={16} aria-hidden="true" className="admin-snapshot-item__icon" />
        <span className="admin-snapshot-item__label">Active studies</span>
        <strong className="admin-snapshot-item__value">
          {dashboardStats.published_opportunities + dashboardStats.draft_opportunities}
        </strong>
        <span className="admin-snapshot-item__sub">
          {dashboardStats.published_opportunities} published · {dashboardStats.draft_opportunities} draft
        </span>
      </div>
      <div className="admin-snapshot-item">
        <Icon icon={Users} size={16} aria-hidden="true" className="admin-snapshot-item__icon" />
        <span className="admin-snapshot-item__label">Participants</span>
        <strong className="admin-snapshot-item__value">{dashboardStats.total_participants}</strong>
        <span className="admin-snapshot-item__sub">People who booked</span>
      </div>
      <div className="admin-snapshot-item">
        <Icon icon={Calendar} size={16} aria-hidden="true" className="admin-snapshot-item__icon" />
        <span className="admin-snapshot-item__label">Sessions this week</span>
        <strong className="admin-snapshot-item__value">{sessionsThisWeek.total}</strong>
        <span className="admin-snapshot-item__sub">
          {sessionsThisWeek.upcoming} upcoming · {sessionsThisWeek.completed} completed
        </span>
      </div>
      <div className="admin-snapshot-item">
        <Icon icon={Clock} size={16} aria-hidden="true" className="admin-snapshot-item__icon" />
        <span className="admin-snapshot-item__label">Open slots</span>
        <strong className="admin-snapshot-item__value">{dashboardStats.available_slots}</strong>
        <span className="admin-snapshot-item__sub">Across all published studies</span>
      </div>
    </div>
  </section>
);

export default AdminSnapshotStrip;
