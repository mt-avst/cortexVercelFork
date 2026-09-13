import React, { useMemo, useState } from 'react';
import { OpportunityBookingRow, ResearcherNotesResponse } from '../../api/types';
import { VALIDATION } from '@shared/constants';
import BookingArtifactsSection from './BookingArtifactsSection';
import { BookingArtifactsController } from './useBookingArtifacts';

/**
 * The same ceiling the server enforces. Held here so the researcher is told
 * BEFORE they press Save, never to truncate what they typed: the server's
 * policy is refuse-never-truncate, and a browser `maxLength` would silently
 * drop the tail of a paste, which is the same defect wearing a different hat.
 */
const MAX_NOTES_CHARS = VALIDATION.MAX_RESEARCHER_NOTES_CHARS;

/**
 * The roster of who booked a moderated opportunity (Live session or
 * Interview), with the researcher's running note per booking (#79).
 *
 * This is the first surface to render GET /opportunities/:id/bookings at all:
 * until it existed, a researcher's only view of a moderated study was the
 * "Booked a time" count on the Overview tab. The notes column is the point -
 * the moderated types capture nothing else about the session yet, so the
 * researcher's own record is the entire research output Cortex holds.
 *
 * Saving is EXPLICIT, not autosave: a note about a named colleague should
 * land when the researcher decides it is ready, and a visible dirty state
 * ("Save note" enabled) is the honest rendering of "not stored yet".
 */

interface ParticipantsTabProps {
  bookings: OpportunityBookingRow[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onSaveNotes: (bookingId: string, notes: string) => Promise<ResearcherNotesResponse>;
  /**
   * Unsaved note text per booking id, OWNED BY THE PAGE rather than by this
   * component - the one piece of state here that must outlive it.
   *
   * The page early-returns a spinner whenever it refetches the opportunity,
   * which unmounts everything below it; holding drafts locally meant a
   * refetch silently emptied a half-written note. Found by the full frontend
   * suite, where the refetch actually races - the same test passed in
   * isolation, which is exactly how this class of loss stays hidden.
   */
  drafts: Record<string, string>;
  onDraftsChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  /**
   * Artefact state and actions (#79 step 3), owned by the page for the same
   * reason the note drafts are: an upload in flight must survive this
   * component unmounting under the opportunity-refetch spinner.
   */
  artifacts: BookingArtifactsController;
}

/** What the row's status means to a researcher, not the raw enum pair. */
export function bookingStatusLabel(booking: Pick<OpportunityBookingRow, 'status' | 'completion_status'>): string {
  if (booking.status === 'cancelled') {
    return 'Cancelled';
  }
  switch (booking.completion_status) {
    case 'completed':
      return 'Awaiting approval';
    case 'approved':
      return 'Completed';
    case 'rejected':
      return 'Rejected';
    default:
      return 'Booked';
  }
}

const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

type ParticipantSortField = 'participant' | 'status';
type SortDirection = 'asc' | 'desc';

/**
 * A booking's place in its own lifecycle, not the raw label string - a
 * booking is made, then (for a moderated session) awaits the researcher's
 * review, then lands on an outcome; cancellation can happen at any point but
 * sorts last, as the exception rather than the norm.
 *
 * There is no shared union type to pin this against the way SessionsTab pins
 * STATUS_RANK on SessionEvent['event_type'] - bookingStatusLabel's return
 * value is a derived string, not a declared type. Exported so a test can
 * assert every label bookingStatusLabel can return has an entry here; that
 * test is the drift guard this map has instead of a compiler one.
 */
export const BOOKING_STATUS_RANK: Record<string, number> = {
  Booked: 0,
  'Awaiting approval': 1,
  Completed: 2,
  Rejected: 3,
  Cancelled: 4
};

function compareBookings(
  left: OpportunityBookingRow,
  right: OpportunityBookingRow,
  field: ParticipantSortField
): number {
  if (field === 'participant') {
    const leftName = left.participant_name ?? 'Unknown participant';
    const rightName = right.participant_name ?? 'Unknown participant';
    return leftName.localeCompare(rightName);
  }

  const leftRank = BOOKING_STATUS_RANK[bookingStatusLabel(left)] ?? 99;
  const rightRank = BOOKING_STATUS_RANK[bookingStatusLabel(right)] ?? 99;
  return leftRank - rightRank;
}

const ParticipantsTab: React.FC<ParticipantsTabProps> = ({
  bookings,
  loading,
  error,
  onRefresh,
  onSaveNotes,
  drafts,
  onDraftsChange: setDrafts,
  artifacts
}) => {
  // Which rows show their artefact section. Component-local on purpose: a
  // collapse under the refetch spinner loses nothing, because everything the
  // section renders lives in the page-owned controller.
  const [expandedArtifactRows, setExpandedArtifactRows] = useState<Set<string>>(new Set());
  // Server state saved from THIS tab, layered over the roster prop - which is
  // stale the moment a save lands, until the next refresh.
  const [saved, setSaved] = useState<Record<string, ResearcherNotesResponse>>({});
  // A SET, not a scalar. With one `savingId`, a second row's save completing
  // set it to null and re-enabled the first row's still-in-flight button,
  // which is a double-submit on a field two people may now be writing.
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  // No column is sorted until the researcher clicks one - `null` preserves
  // today's default, which is just the roster order the page hands down.
  const [sortField, setSortField] = useState<ParticipantSortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = (field: ParticipantSortField) => {
    if (field === sortField) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const ariaSortFor = (field: ParticipantSortField): 'ascending' | 'descending' | 'none' =>
    sortField === field ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none';

  const sortedBookings = useMemo(() => {
    if (!sortField) {
      return bookings;
    }
    return [...bookings].sort((left, right) => {
      const comparison = compareBookings(left, right, sortField);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [bookings, sortField, sortDirection]);

  // A NEW ROSTER WINS OVER LOCAL STATE. `saved` exists to cover the window
  // between a save landing and the next fetch; keeping it past that fetch
  // shadowed a co-owner's note forever - reachable since #79 made the roster
  // owner-OR-superadmin, so two people can write the same booking's note.
  // Keyed on the prop's identity: `loadBookings` hands down a fresh array
  // every fetch, so this clears exactly when new server truth arrives, and a
  // re-render with the same array leaves an in-flight edit alone.
  const [rosterSeen, setRosterSeen] = useState(bookings);
  if (rosterSeen !== bookings) {
    setRosterSeen(bookings);
    setSaved({});
  }

  const storedNotes = (booking: OpportunityBookingRow): string =>
    saved[booking.id] !== undefined
      ? saved[booking.id].researcher_notes ?? ''
      : booking.researcher_notes ?? '';

  const storedUpdatedAt = (booking: OpportunityBookingRow): string | null =>
    saved[booking.id] !== undefined
      ? saved[booking.id].researcher_notes_updated_at
      : booking.researcher_notes_updated_at;

  const withoutId = (previous: Set<string>, id: string): Set<string> => {
    const next = new Set(previous);
    next.delete(id);
    return next;
  };

  const handleSave = async (booking: OpportunityBookingRow) => {
    const draft = drafts[booking.id];
    if (draft === undefined || draft.length > MAX_NOTES_CHARS) return;
    setSavingIds((previous) => new Set(previous).add(booking.id));
    setSaveErrors((previous) => ({ ...previous, [booking.id]: '' }));
    try {
      const response = await onSaveNotes(booking.id, draft);
      setSaved((previous) => ({ ...previous, [booking.id]: response }));
      // RECONCILE, DO NOT CLEAR. The draft is captured at click time, so
      // anything typed while the request was in flight is newer than what the
      // server just stored. Clearing unconditionally threw those keystrokes
      // away AND rendered "Updated ..." over the loss - a positive
      // confirmation of text that no longer existed. Only the draft we
      // actually sent is safe to drop.
      setDrafts((previous) => {
        if (previous[booking.id] !== draft) {
          return previous;
        }
        const next = { ...previous };
        delete next[booking.id];
        return next;
      });
    } catch {
      setSaveErrors((previous) => ({
        ...previous,
        [booking.id]: 'Could not save this note. Your text is still here - try again.'
      }));
    } finally {
      setSavingIds((previous) => withoutId(previous, booking.id));
    }
  };

  if (loading) {
    return (
      <div className="text-center py-5">
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">Loading participants...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="cortex-analytics-card" style={{ marginBottom: '24px' }}>
      <div className="cortex-chart-header">
        <h5 className="cortex-chart-title">Participants</h5>
        <button
          type="button"
          className="cortex-period-btn"
          onClick={onRefresh}
          style={{ fontSize: '0.75rem' }}
        >
          Refresh
        </button>
      </div>

      {error ? (
        <div className="cortex-no-data" style={{ padding: '32px 0' }} role="alert">
          <p>{error}</p>
        </div>
      ) : bookings.length === 0 ? (
        <div className="cortex-no-data" style={{ padding: '32px 0' }}>
          <p>Nobody has booked a session yet.</p>
          <p className="cortex-stat-subtitle" style={{ fontSize: '0.8rem', marginTop: '4px' }}>
            Participants appear here as they book time slots, with space for your notes on each session.
          </p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--cortex-border, rgba(255,255,255,0.08))' }}>
                <th
                  style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}
                  scope="col"
                  aria-sort={ariaSortFor('participant')}
                >
                  <button type="button" className="admin-th-sort" onClick={() => handleSort('participant')}>
                    Participant
                    <span className="admin-th-sort-caret" aria-hidden="true">
                      {sortField === 'participant' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
                    </span>
                  </button>
                </th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>Session</th>
                <th
                  style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}
                  scope="col"
                  aria-sort={ariaSortFor('status')}
                >
                  <button type="button" className="admin-th-sort" onClick={() => handleSort('status')}>
                    Status
                    <span className="admin-th-sort-caret" aria-hidden="true">
                      {sortField === 'status' ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
                    </span>
                  </button>
                </th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, width: '45%' }}>Researcher notes</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500 }}>Artefacts</th>
              </tr>
            </thead>
            <tbody>
              {sortedBookings.map((booking) => {
                const stored = storedNotes(booking);
                const draft = drafts[booking.id];
                const value = draft ?? stored;
                const dirty = draft !== undefined && draft !== stored;
                const updatedAt = storedUpdatedAt(booking);
                const participantLabel = booking.participant_name ?? 'Unknown participant';
                const overBy = value.length - MAX_NOTES_CHARS;
                const saving = savingIds.has(booking.id);
                const artifactsExpanded = expandedArtifactRows.has(booking.id);
                const loadedArtifacts = artifacts.artifactsByBooking[booking.id];
                const uploadInFlight = artifacts.uploads[booking.id] !== undefined;
                return (
                  <React.Fragment key={booking.id}>
                  <tr
                    style={{ borderBottom: artifactsExpanded ? 'none' : '1px solid var(--cortex-border, rgba(255,255,255,0.04))', verticalAlign: 'top' }}
                  >
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ fontWeight: 500 }}>{participantLabel}</span>
                      {booking.participant_email && (
                        <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {booking.participant_email}
                        </span>
                      )}
                      {(booking.business_unit || booking.role_title) && (
                        <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {[booking.role_title, booking.business_unit].filter(Boolean).join(', ')}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {formatDateTime(booking.session_start_time)}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span className="cortex-badge">{bookingStatusLabel(booking)}</span>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <textarea
                        className="form-control"
                        aria-label={`Researcher notes for ${participantLabel}`}
                        value={value}
                        rows={value ? Math.min(6, Math.max(2, value.split('\n').length)) : 2}
                        placeholder="What happened in this session - observations, quotes, follow-ups"
                        onChange={(event) => {
                          const text = event.target.value;
                          setDrafts((previous) => ({ ...previous, [booking.id]: text }));
                          // A stale failure message sitting under text the
                          // researcher has since rewritten describes an
                          // attempt that no longer matches what is on screen.
                          setSaveErrors((previous) =>
                            previous[booking.id] ? { ...previous, [booking.id]: '' } : previous
                          );
                        }}
                        style={{ fontSize: '0.85rem' }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px' }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={!dirty || saving || overBy > 0}
                          onClick={() => void handleSave(booking)}
                        >
                          {saving ? 'Saving...' : 'Save note'}
                        </button>
                        {overBy > 0 ? (
                          <span role="alert" style={{ fontSize: '0.75rem', color: 'var(--bs-danger, #dc3545)' }}>
                            {overBy} characters over the {MAX_NOTES_CHARS} limit
                          </span>
                        ) : saveErrors[booking.id] ? (
                          <span role="alert" style={{ fontSize: '0.75rem', color: 'var(--bs-danger, #dc3545)' }}>
                            {saveErrors[booking.id]}
                          </span>
                        ) : dirty ? (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Unsaved changes</span>
                        ) : updatedAt ? (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            Updated {formatDateTime(updatedAt)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        aria-expanded={artifactsExpanded}
                        aria-controls={`booking-artifacts-${booking.id}`}
                        onClick={() =>
                          setExpandedArtifactRows((previous) => {
                            const next = new Set(previous);
                            if (next.has(booking.id)) {
                              next.delete(booking.id);
                            } else {
                              next.add(booking.id);
                            }
                            return next;
                          })
                        }
                      >
                        {artifactsExpanded ? 'Hide' : 'Artefacts'}
                        {loadedArtifacts && loadedArtifacts.length > 0 ? ` (${loadedArtifacts.length})` : ''}
                        {uploadInFlight ? ' …' : ''}
                      </button>
                    </td>
                  </tr>
                  {artifactsExpanded && (
                    <tr style={{ borderBottom: '1px solid var(--cortex-border, rgba(255,255,255,0.04))' }}>
                      <td colSpan={5} style={{ padding: '0 12px 10px' }}>
                        <div id={`booking-artifacts-${booking.id}`}>
                          <BookingArtifactsSection booking={booking} controller={artifacts} />
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ParticipantsTab;
