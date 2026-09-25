import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Navigate, Link } from 'react-router-dom';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { useAuth } from '../contexts/AuthContext';
import { getOpportunity, getOpportunityBookings } from '../api/client';
import { Opportunity, OpportunityBookingRow } from '../api/types';
import ErrorState from '../components/ErrorState';
import { Icon } from '../components/ui';
import { ArrowLeft, ArrowRight, AlertTriangle, CheckCircle, Calendar, Users } from 'lucide-react';
import { CREATE_AND_MANAGE } from '@shared/pageNames';
import { findPublishProblems, PUBLISH_PROBLEM_MESSAGES } from '@shared/firsthand/publish-readiness';
import { MODERATED_CONSENT_TYPES } from '@shared/firsthand/consent-templates';
import {
  canManageStudy,
  getAdminTypeLabel,
  getDisplayStatus,
  getStudyProgress,
  isAutoClosed,
  studyAnalyticsPath,
  studyEditPath,
  studyPreviewPath,
} from '../utils/adminDashboard';
import { getTypeBadgeClass } from '../utils/opportunityUtils';
import { getStudyTypeGlyph } from '../utils/studyTypeIcons';
import {
  hasUpcomingSlot,
  PUBLISHED_NOT_WORKING_LABEL,
  PUBLISHED_NOT_WORKING_PREFIX,
  PUBLISHED_NOT_WORKING_DESCRIPTION,
} from '../lib/opportunity-authoring/step-status';
import { formatStudyDate, formatClockTime, formatTimeRange, formatTimeZoneLabel } from '../utils/datetime';
import { bookingStatusLabel } from '../components/opportunity-analytics/ParticipantsTab';

/**
 * The study overview page (cto/AdaptaLabs#163): what a manager (owner or
 * superadmin) lands on from the Research Studies table now, instead of going
 * straight to the edit form. One screen answering "what state is this study
 * in, and what does it need" - the edit form for making changes, Analytics
 * for the numbers over time.
 *
 * Pattern copied from OpportunityAnalytics.tsx: auth redirect, an owner-only
 * 403 rendered as its own page (not a section), "Back to {CREATE_AND_MANAGE}",
 * `cortex-page-header`, `useDocumentTitle`.
 */
const OpportunityOverview: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();

  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  useDocumentTitle(opportunity?.title ? `${opportunity.title} · Cortex` : 'Study overview · Cortex');
  const [loadingOpportunity, setLoadingOpportunity] = useState(true);
  const [error, setError] = useState('');

  const [bookings, setBookings] = useState<OpportunityBookingRow[]>([]);
  const [loadingBookings, setLoadingBookings] = useState(false);
  const [bookingsError, setBookingsError] = useState(false);
  // Bumped by the Bookings section's own Retry - the bookings effect below
  // depends on it, so a bump re-runs the fetch without disturbing anything
  // else on the page.
  const [bookingsReloadToken, setBookingsReloadToken] = useState(0);

  // Bookings are owner-only on the server (GET /bookings/opportunities/:id/
  // bookings), and so is this whole page in practice - see `canManage`
  // below and the gate in the opportunity-fetch effect. Kept as its own flag
  // (not derived from `canManage`) because a stale client-side read of the
  // study's owner is still possible, and the bookings fetch's own 403
  // (caught below) falls back to the same state.
  const [permissionDenied, setPermissionDenied] = useState(false);

  // One clock reading per mount, the same pattern Admin.tsx's `now` uses, so
  // "upcoming" and "Broken" agree with each other for the whole render.
  const now = useMemo(() => new Date(), []);

  // Owner or superadmin: the server's own gate on bookings/analytics/edit
  // for this study. Computed here (not only inside the opportunity-fetch
  // effect) so the bookings effect and the render body read the same value.
  const canManage = useMemo(
    () => (opportunity ? canManageStudy(opportunity, user) : false),
    [opportunity, user],
  );
  // Sessions and bookings only mean anything for a booked study (live
  // session or interview) - a poll/survey/question/unmoderated study never
  // has either.
  const moderated = useMemo(
    () => Boolean(opportunity && MODERATED_CONSENT_TYPES.has(opportunity.type)),
    [opportunity],
  );

  // Bumped by the "Unable to load study" error state's own Retry - the
  // fetch effect below depends on it, so a bump re-runs the fetch without a
  // second copy of the fetch logic.
  const [reloadToken, setReloadToken] = useState(0);

  // Gated on auth being settled (`loading` false, `user` present) before it
  // fetches anything: `canManageStudy` needs the real signed-in user, not
  // the `null` every visitor starts as while auth is still resolving, so
  // this waits for both rather than guessing with a placeholder. One
  // `getOpportunity` call per settled `[id, user, loading, reloadToken]`
  // combination, guarded by `cancelled` against a superseded request (a
  // fast id change, or Retry firing again before the first request lands)
  // writing over a newer one's state.
  useEffect(() => {
    if (loading || !user || !id) return;
    let cancelled = false;
    setLoadingOpportunity(true);
    setError('');
    setPermissionDenied(false);
    getOpportunity(id)
      .then((opp) => {
        if (cancelled) return;
        setOpportunity(opp);

        // Gated here, right after the study loads, for every study type -
        // not only the two that carry bookings. Nothing on this page
        // belongs to anyone but the owner or a superadmin (bookings are
        // owner-only on the server for the two moderated types; the other
        // types have nothing else here a manager would need to hide), so a
        // non-manager gets the owner-only state below and this page makes
        // no bookings request at all.
        if (!canManageStudy(opp, user)) {
          setPermissionDenied(true);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { response?: { status?: number } }).response?.status;
        setError(status === 404 ? 'Study not found' : 'Failed to load this study');
      })
      .finally(() => {
        if (!cancelled) setLoadingOpportunity(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, user, loading, reloadToken]);

  // A different study's bookings must never flash under the new one's
  // heading while its own fetch is still in flight - cleared as soon as the
  // route param changes, ahead of the fetch below.
  useEffect(() => {
    setBookings([]);
    setBookingsError(false);
  }, [id]);

  // Loaded independently of the opportunity fetch above, in its own effect,
  // so a slow bookings request does not hold up first paint of the rest of
  // the page - `loadingBookings` is therefore a state this can actually be
  // caught in, not one that always resolves in the same render as
  // `loadingOpportunity`. The `cancelled` flag is the standard guard against
  // a stale response landing after a newer request has started (a fast
  // second id, or the Retry button bumping `bookingsReloadToken`).
  useEffect(() => {
    if (!id || !opportunity || !moderated || !canManage) return;
    let cancelled = false;
    setLoadingBookings(true);
    setBookingsError(false);
    getOpportunityBookings(id)
      .then((rows) => {
        if (!cancelled) setBookings(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 403) {
          setPermissionDenied(true);
        } else {
          setBookingsError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingBookings(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, opportunity, moderated, canManage, bookingsReloadToken]);

  if (!loading && !user) {
    return <Navigate to="/" replace />;
  }

  if (loading || loadingOpportunity) {
    return (
      <div className="loading-container">
        <div className="text-center">
          <div className="spinner-border text-primary" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
          <p className="mt-3 text-muted">Loading study...</p>
        </div>
      </div>
    );
  }

  if (permissionDenied) {
    const ownerName = opportunity?.owner_name;
    return (
      <div className="container py-5">
        <div className="row">
          <div className="col-12">
            <button
              className="btn btn-outline-secondary btn-sm"
              onClick={() => navigate('/admin')}
              style={{ borderRadius: '6px', fontSize: '0.8125rem', fontWeight: '500', marginBottom: '1.5rem' }}
            >
              <ArrowLeft size={14} style={{ marginRight: '6px' }} />
              Back to {CREATE_AND_MANAGE}
            </button>
            {/* A real heading, not only `ErrorState`'s own `<h2>` - this is
                a full page on its own, and a page needs one `<h1>` whoever
                lands on it. */}
            <h1 className="cortex-page-title mb-3">{opportunity?.title || 'Study overview'}</h1>
            <ErrorState
              headingLevel={2}
              title="Study overview is owner-only"
              message={
                ownerName
                  ? `Only ${ownerName} can view this study's overview. Ask them to share what you need.`
                  : "Only the study owner can view this study's overview."
              }
            />
          </div>
        </div>
      </div>
    );
  }

  if (error || !opportunity) {
    return (
      <div className="container py-5">
        <div className="row">
          <div className="col-12">
            <button className="btn btn-outline-secondary mb-4" onClick={() => navigate('/admin')}>
              <ArrowLeft size={16} className="me-2" />
              Back to {CREATE_AND_MANAGE}
            </button>
            {/* A real heading, not only ErrorState's own <h2> - this is a
                full page on its own, and a page needs one <h1> whoever
                lands on it. The study's own title is not available here
                (that is exactly what failed to load), so this names the
                page rather than the study. */}
            <h1 className="cortex-page-title mb-3">Study overview</h1>
            <ErrorState
              headingLevel={2}
              title="Unable to load study"
              message={error || 'Study not found'}
              onAction={() => setReloadToken((token) => token + 1)}
              actionLabel="Retry"
            />
          </div>
        </div>
      </div>
    );
  }

  const TypeGlyph = getStudyTypeGlyph(opportunity.type);
  const owner = opportunity.owner_name || opportunity.owner_email;
  const hasUpcoming = hasUpcomingSlot(opportunity.sessions ?? [], now);

  /**
   * Every unmet publish requirement this study has right now - the SAME
   * function the authoring form's Review step previews, asked of the real,
   * persisted study rather than an in-progress edit.
   *
   * `hasInlineStudy`/`hasInlineSurvey` are `false` here, not the dashboard
   * row's benefit-of-the-doubt `true` (`isStudyBroken` in adminDashboard.ts):
   * once a study is SAVED, whatever content it was authored with - inline or
   * linked - is reachable through `firsthand_study_id` (the server attaches
   * one the moment inline content is written), so `hasLinkedStudy` from that
   * field is the real answer here, not a guess. The admin table cannot do
   * this - its list response has no per-row way to prove the negative - which
   * is exactly the blind spot this page closes for a study it already has
   * the full detail payload for.
   */
  const publishProblems = findPublishProblems({
    willBePublished: true,
    type: opportunity.type,
    deliveryMode: opportunity.delivery_mode ?? 'external',
    hasLinkedStudy: Boolean(opportunity.firsthand_study_id?.trim()),
    hasInlineStudy: false,
    hasInlineSurvey: false,
    externalLink: opportunity.external_link_optional,
    hasBookableSlot: hasUpcoming,
    hasMeetingLocation: Boolean(opportunity.meeting_location_optional?.trim()),
  });

  // The status pill and the Fix/Edit label read THIS page's own
  // `publishProblems` above, not the table's `isStudyBroken` - deliberately
  // stricter, since a study can only be "not working" here once it is
  // published AND this page's own, unforgiving check has actually found
  // something wrong with it. The table's reading stays the benefit-of-the-
  // doubt one described above (it has no per-row way to prove the
  // negative), so the two can disagree on the same study - this page saying
  // Broken where the table still says Published. That gap is tracked, not a
  // bug here: cto/AdaptaLabs#170.
  const notWorking = opportunity.status === 'published' && publishProblems.length > 0;
  const statusLabel = notWorking ? PUBLISHED_NOT_WORKING_LABEL : getDisplayStatus(opportunity.status);

  const sessions = opportunity.sessions ?? [];
  const upcomingSessions = sessions
    .filter((session) => new Date(session.end_time).getTime() > now.getTime())
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  const pastSessions = sessions
    .filter((session) => new Date(session.end_time).getTime() <= now.getTime())
    .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());

  const sortedBookings = [...bookings].sort(
    (a, b) => new Date(a.session_start_time).getTime() - new Date(b.session_start_time).getTime(),
  );

  const progress = getStudyProgress(opportunity);

  return (
    <div className="analytics-page-wrapper opportunity-overview-page" style={{ position: 'relative', minHeight: '100vh' }}>
      <div className="container-fluid py-4 analytics-container">
        <button
          className="btn btn-outline-secondary btn-sm"
          onClick={() => navigate('/admin')}
          style={{ borderRadius: '6px', fontSize: '0.8125rem', fontWeight: '500', marginBottom: '1.5rem' }}
        >
          <ArrowLeft size={14} style={{ marginRight: '6px' }} />
          Back to {CREATE_AND_MANAGE}
        </button>

        <div className="cortex-page-header">
          <div className="cortex-title-block">
            <span className="cortex-page-kicker">Study overview</span>
            <h1 className="cortex-page-title">{opportunity.title}</h1>
            <div className="admin-study-meta" style={{ marginTop: '8px' }}>
              <span className={`admin-pill ${getTypeBadgeClass(opportunity.type)} badge--${opportunity.type}`}>
                {TypeGlyph && <Icon icon={TypeGlyph} size={14} aria-hidden="true" className="lozenge__glyph" />}
                {getAdminTypeLabel(opportunity.type)}
              </span>
              <span
                className={`admin-pill admin-study-status admin-study-status--${opportunity.status}${
                  notWorking ? ' admin-study-status--not-working' : ''
                }`}
              >
                {notWorking && <Icon icon={AlertTriangle} size={14} aria-hidden="true" className="admin-study-status__glyph" />}
                {notWorking && <span className="visually-hidden">{PUBLISHED_NOT_WORKING_PREFIX}</span>}
                <span className="admin-study-status__label" title={notWorking ? PUBLISHED_NOT_WORKING_DESCRIPTION : statusLabel}>
                  {statusLabel}
                </span>
              </span>
              {isAutoClosed(opportunity) && (
                <span className="admin-pill admin-pill--auto-closed">Auto-closed</span>
              )}
              {owner && (
                <span className="admin-study-owner" title={`Owner: ${owner}`}>
                  <span className="visually-hidden">Owner: </span>
                  {owner}
                </span>
              )}
            </div>
          </div>

          {/* Real links, not buttons calling `navigate` - the same reasoning
              StudyRow.tsx uses for the table's own primary action: every one
              of these is a page, so a modifier-click has to open a new tab.
              `canManage` is always true by the time this renders - a
              non-manager already left through the owner-only state above. */}
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <Link
              to={studyEditPath(opportunity.id)}
              className={`btn btn-outline-secondary btn-sm${notWorking ? ' admin-action-primary--fix' : ''}`}
            >
              {notWorking && <Icon icon={AlertTriangle} size={14} aria-hidden="true" className="me-1" />}
              {notWorking ? 'Fix' : 'Edit'}
            </Link>
            <Link to={studyPreviewPath(opportunity.id)} className="btn btn-outline-secondary btn-sm">
              Preview as participant
            </Link>
            <Link to={studyAnalyticsPath(opportunity.id)} className="btn btn-outline-secondary btn-sm">
              Analytics
            </Link>
          </div>
        </div>

        {/* Setup status: "why Broken", built from the same publish rule the
            authoring form's Review step previews - see `publishProblems`
            above. Rendered whatever the status: a draft sees the same
            checklist a publish attempt would meet, same reasoning as
            Review's own `publishProblemCodes`. */}
        <div className="card mb-4">
          <div className="card-body">
            <h2 className="h5 mb-3">Setup status</h2>
            {publishProblems.length === 0 ? (
              <p className="mb-0 d-flex align-items-center gap-2">
                <Icon icon={CheckCircle} size={16} aria-hidden="true" className="text-success" />
                Ready to take part
              </p>
            ) : (
              <ul className="mb-0 ps-0" style={{ listStyle: 'none' }}>
                {publishProblems.map((problem) => (
                  <li key={problem.code} className="d-flex align-items-start gap-2 mb-2">
                    <Icon icon={AlertTriangle} size={16} aria-hidden="true" className="admin-study-status__glyph mt-1" />
                    <span>
                      {PUBLISH_PROBLEM_MESSAGES[problem.code]}
                      {' '}
                      {/*
                        The edit form has no step deep link (no query param or
                        location.state it reads on mount) - checked in
                        OpportunityForm.tsx before writing this. Every problem
                        links to the form itself rather than a step it cannot
                        jump to.
                      */}
                      {/* Unstyled apart from the underline below - takes
                          the global `a` colour (`--link`), the same token
                          every other plain link in the app reads (e.g. the
                          Recent bookings study link); in light theme it
                          resolves to the 800-step orange chosen there
                          specifically because 500 fails AA as text (see
                          "ACCESSIBLE ACCENT ROLES" in _themes.css).
                          Underlined at rest (`.link-underline`), since
                          colour on its own does not read as 3:1 against this
                          inline text (WCAG 1.4.1). */}
                      {canManage && (
                        <Link to={studyEditPath(opportunity.id)} className="link-underline">
                          Edit study
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Sessions and bookings: live session / interview only - the two
            types that leave a booking rather than a native answer or a
            click. */}
        {moderated && (
          <div className="card mb-4">
            <div className="card-body">
              <h2 className="h5 mb-3 d-flex align-items-center gap-2">
                <Icon icon={Calendar} size={16} aria-hidden="true" />
                Sessions
              </h2>
              {sessions.length === 0 ? (
                <p className="text-muted mb-0">No sessions scheduled yet.</p>
              ) : (
                <>
                  <h3 className="h6 text-muted">Upcoming</h3>
                  {upcomingSessions.length === 0 ? (
                    <p className="text-muted">No upcoming sessions.</p>
                  ) : (
                    <ul className="mb-3 ps-0" style={{ listStyle: 'none' }}>
                      {upcomingSessions.map((session) => (
                        <li key={session.id} className="mb-1">
                          {/* Same date/time/zone markup as Admin.tsx's own
                              Recent bookings table (~line 1543): the zone is
                              read per row, at that row's own instant, never a
                              single header offset for the whole list. */}
                          <span className="admin-recent-session-date">{formatStudyDate(session.start_time)} ·</span>{' '}
                          <span className="admin-recent-session-time">
                            {formatTimeRange(session.start_time, session.end_time)}{' '}
                            <span className="admin-recent-session-zone">{formatTimeZoneLabel(session.start_time)}</span>
                          </span>
                          {' - '}
                          <span className="admin-recruitment__ratio">{session.booked_count} / {session.capacity}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3 className="h6 text-muted">Past</h3>
                  {pastSessions.length === 0 ? (
                    <p className="text-muted mb-0">No past sessions.</p>
                  ) : (
                    <ul className="mb-0 ps-0" style={{ listStyle: 'none' }}>
                      {pastSessions.map((session) => (
                        <li key={session.id} className="mb-1">
                          <span className="admin-recent-session-date">{formatStudyDate(session.start_time)} ·</span>{' '}
                          <span className="admin-recent-session-time">
                            {formatTimeRange(session.start_time, session.end_time)}{' '}
                            <span className="admin-recent-session-zone">{formatTimeZoneLabel(session.start_time)}</span>
                          </span>
                          {' - '}
                          <span className="admin-recruitment__ratio">{session.booked_count} / {session.capacity}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              <h2 className="h5 mt-4 mb-3 d-flex align-items-center gap-2">
                <Icon icon={Users} size={16} aria-hidden="true" />
                Bookings
              </h2>
              {loadingBookings ? (
                <p className="text-muted mb-0">Loading bookings…</p>
              ) : bookingsError ? (
                <ErrorState
                  headingLevel={3}
                  title="Couldn't load bookings"
                  message="Something went wrong loading this study's bookings."
                  onAction={() => setBookingsReloadToken((token) => token + 1)}
                  actionLabel="Retry"
                />
              ) : bookings.length === 0 ? (
                <p className="text-muted mb-0">No bookings yet.</p>
              ) : (
                <ul className="mb-0 ps-0" style={{ listStyle: 'none' }}>
                  {sortedBookings.map((booking) => (
                    <li key={booking.id} className="mb-1">
                      {booking.participant_name || booking.participant_email || 'Unknown participant'}
                      {' - '}
                      {/* Same date/time/zone markup as the session rows
                          above and Admin.tsx's own Recent bookings table. */}
                      <span className="admin-recent-session-date">{formatStudyDate(booking.session_start_time)} ·</span>{' '}
                      <span className="admin-recent-session-time">
                        {formatClockTime(booking.session_start_time)}{' '}
                        <span className="admin-recent-session-zone">{formatTimeZoneLabel(booking.session_start_time)}</span>
                      </span>
                      {' - '}
                      {bookingStatusLabel(booking)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Results: the table's own headline figure for this row
            (booked/capacity) when it has sessions.
            ponytail: `responses_total`/`clicks_total` - the table's headline
            for a poll/survey/question/unmoderated study with no sessions -
            are computed only by the admin LIST route's batch queries
            (backend/src/routes/opportunities.ts), not carried on the single
            opportunity GET this page reads, and this page's data is
            deliberately limited to `getOpportunity`/`getOpportunityBookings`
            (cto/AdaptaLabs#163). Closing this needs either a backend change
            to the single-opportunity route, or this page also calling the
            admin list endpoint for this one study - not a NEW endpoint,
            since that route already exists; cto/AdaptaLabs#163 ruled out a
            new endpoint, not a second fetch. Analytics already has the real
            number for every type, so the link below is the honest way there
            today. */}
        <div className="card mb-4">
          <div className="card-body d-flex align-items-center justify-content-between flex-wrap gap-3">
            <div>
              <h2 className="h5 mb-1">Results</h2>
              {progress ? (
                <p className="mb-0">
                  <span className="admin-recruitment__ratio">{progress.booked} / {progress.capacity}</span> booked
                  {' '}({progress.pct}%)
                </p>
              ) : (
                <p className="text-muted mb-0">See Analytics for participation figures.</p>
              )}
            </div>
            <Link to={studyAnalyticsPath(opportunity.id)} className="btn btn-outline-secondary btn-sm">
              Analytics <Icon icon={ArrowRight} size={14} aria-hidden="true" className="ms-1" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OpportunityOverview;
