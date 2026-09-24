import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { getOpportunity, bookSession, trackOpportunityClick, getMyCalendarEvents, getMyBookings, getRecordedStudyBrief, startRecordedStudySession, startSurveySession, submitScreener } from '../api/client';
import type { ParticipantScreener, RecordedStudyBrief, ScreenerOutcome } from '@shared/types';
import { formatStudyDate, formatTimeRange, formatTimeZoneLabel, formatClockTime, formatDateTime } from '../utils/datetime';
import { describeCalendarClash } from '../utils/calendarClash';
import './booking-slot-list.css';
import { Opportunity, CalendarEvent, Session } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import useDocumentTitle from '../hooks/useDocumentTitle';
import CalendarGrid, { CALENDAR_LEGEND_ITEMS } from '../components/CalendarGrid';
import ConfirmationModal from '../components/ConfirmationModal';
import ScreenerCheck from '../components/ScreenerCheck';
import ShareOpportunityLink from '../components/ShareOpportunityLink';
import { RecordedStudyExpectations } from '../components/RecordedStudyExpectations';
import { getParticipantFacingType, getEligibilityNote, getTypeBadgeClass, getCardHoverColor, getClosingTime, getTimeRemainingUntil } from '../utils/opportunityUtils';
import { getStudyTypeGlyph } from '../utils/studyTypeIcons';
import { logger } from '../utils/logger';
import { runsNativeSurvey } from '@shared/firsthand/delivery';
import { bookingConsentText } from '@shared/firsthand/consent-templates';
import { isPublishableExternalLink } from '@shared/firsthand/url-safety';
import { ExternalHandoff, ExternalDestinationNote } from '../components/ExternalHandoff';
import { RefreshCw, CheckCircle, Calendar, Info, LayoutGrid, Table2, ArrowLeft } from 'lucide-react';
import { Icon } from '../components/ui';
import { PARTICIPATE } from '@shared/pageNames';

/**
 * The server's own sentence when a mint is refused because the study has closed
 * (cto/AdaptaLabs#129), or null when this failure is something else.
 *
 * KEYED ON THE CODE, not on the 403, because the two 403s the mint routes send
 * mean opposite things: `OPPORTUNITY_CLOSED` is terminal and a bare
 * "not published" 403 is a study that may yet open. Both used to render "not
 * yet available, please try again later", which for a study that has ENDED is
 * the one sentence on the page that is actively false - it will not become
 * available and there is nothing to come back for.
 *
 * The server's wording is preferred over a local copy for the same reason the
 * detail read's handler prefers it: one sentence, written once, so the page
 * cannot tell a participant something different from the API.
 */
const readClosedStudyRefusal = (err: unknown): string | null => {
  const response = (err as { response?: { data?: { error?: string; code?: string } } }).response;
  if (response?.data?.code !== 'OPPORTUNITY_CLOSED') return null;
  return response.data.error || 'This study has closed and is no longer accepting participants.';
};

// Helper function to render poll description with checkbox indicators
const renderPollDescription = (description: string) => {
  if (!description) return null;

  const lines = description.split('\n');
  const result: React.ReactNode[] = [];

  // Patterns that indicate header/footer/question text, not options
  const excludePatterns = [
    '**',                    // Bold text (headers)
    'Click below',           // Footer text
    'Takes',                 // Time estimates
    'should we prioritize',  // Question text
    'Your vote',             // Footer text
    'roadmap',               // Footer text
    '?',                     // Question marks (questions)
    'Which',                 // Question starters
    'What',                  // Question starters
    'How',                   // Question starters
  ];

  // Find where the question ends (usually after first question mark or "next?")
  let questionEndIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.includes('?') && (trimmed.includes('Which') || trimmed.includes('should'))) {
      questionEndIndex = i;
      break;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Skip empty lines but add spacing
    if (!trimmedLine) {
      result.push(<br key={`br-${i}`} />);
      continue;
    }

    // Check if this is excluded text (header, footer, or question)
    const isExcluded = excludePatterns.some(pattern =>
      trimmedLine.toLowerCase().includes(pattern.toLowerCase())
    );

    // Check if this is before or at the question line
    const isQuestion = i <= questionEndIndex;

    // This is a poll option if:
    // 1. It's not excluded text
    // 2. It comes after the question
    // 3. It's reasonably long (more than just a few words)
    // 4. It comes after an empty line (typical poll structure)
    const isOption = !isExcluded &&
                     !isQuestion &&
                     trimmedLine.length > 15 &&
                     (i > 0 && lines[i - 1]?.trim() === ''); // Must come after empty line

    if (isOption) {
      // This is a poll option - render with checkbox
      result.push(
        <div key={`option-${i}`} style={{ display: 'flex', alignItems: 'flex-start', marginBottom: '8px' }}>
          <div style={{
            width: '18px',
            height: '18px',
            border: '2px solid currentColor',
            borderRadius: '3px',
            marginRight: '10px',
            marginTop: '2px',
            flexShrink: 0,
            opacity: 0.6
          }} />
          <span>{trimmedLine}</span>
        </div>
      );
    } else {
      // Regular text line (header, question, footer)
      result.push(
        <span key={`text-${i}`} style={{ whiteSpace: 'pre-wrap' }}>{line}</span>
      );
      if (i < lines.length - 1) {
        result.push(<br key={`br-after-${i}`} />);
      }
    }
  }

  return <div>{result}</div>;
};

/**
 * Group future, non-conflicting sessions into one section per calendar day, in
 * chronological order. The Table view renders these as a date stated once with
 * its timezone, then the day's start times as chips - rather than a row per
 * slot repeating the date and zone. Grouping is by the day as the participant
 * reads it (their local zone), which is the same instant formatStudyDate and
 * the chips print, so a slot never lands under a different date than its label.
 */
interface SessionDayGroup {
  key: string;
  dateStr: string | null;
  zone: string | null;
  sessions: Session[];
}

const groupSessionsByDay = (sessions: Session[]): SessionDayGroup[] => {
  const ordered = [...sessions].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );
  const groups: SessionDayGroup[] = [];
  const byKey = new Map<string, SessionDayGroup>();

  for (const session of ordered) {
    const start = new Date(session.start_time);
    const key = start.toDateString();
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        dateStr: formatStudyDate(start),
        zone: formatTimeZoneLabel(start),
        sessions: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.sessions.push(session);
  }

  return groups;
};

const OpportunityDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isSessionCompleted = searchParams.get('completed') === '1';
  const { user } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  // Title tracks the loaded opportunity; undefined while loading no-ops, so the
  // static "Cortex" title (index.html) holds until data lands. Restored on unmount.
  useDocumentTitle(opportunity?.title);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  // Whether the current `error` is worth a Retry. A closed study, a draft, a
  // removed study or a permission refusal will answer the same way on reload,
  // so those hide the button; only a transient failure keeps it.
  const [errorRetryable, setErrorRetryable] = useState<boolean>(true);
  const [bookingLoading, setBookingLoading] = useState<string | null>(null);
  const [bookingSuccess, setBookingSuccess] = useState<string | null>(null);
  const [firstHandLoading, setFirstHandLoading] = useState(false);

  /**
   * Whether pressing the call to action will actually do anything.
   *
   * The handoff branch runs only for an unmoderated opportunity with a linked
   * study; everything else falls through to opening the external link. A native
   * poll or survey has a study and no link, so it satisfied the old
   * "has one or the other" test, rendered an ENABLED button, and did nothing at
   * all on click - not even recording the click, so analytics showed a view and
   * no action. The backend can now publish that state, and the participant
   * runner for it arrives with the survey routing, so until then the honest
   * thing is to say it is not available rather than to offer a dead control.
   *
   * Covers a native `question` since #78. It mints through the same
   * `/survey-session` route and runs in the same SurveyRunner - one question is
   * a survey of one - so nothing below it needed a third branch.
   */
  const isNativeSurvey = runsNativeSurvey(
    opportunity?.type ?? '',
    opportunity?.delivery_mode
  );

  /**
   * Whether the stored link is one this page will hand a participant.
   *
   * The second half of the fix, and the half a schema change cannot do: the
   * schema stops a NEW bad value being accepted, and says nothing about rows
   * already in the table. A `javascript:` URL was accepted for a long time -
   * `z.string().url()` is not a protocol check - and this page rendered
   * whatever it found straight into an `href`. Refusing to render it is what
   * makes those rows inert rather than merely unlikely to fire.
   *
   * Not asserted as "the store is clean". It is not, it cannot be checked
   * from here, and the render is the last place that can decline.
   */
  const externalLinkIsUsable = isPublishableExternalLink(
    opportunity?.external_link_optional
  );

  // The poll/survey/study CTA below is one button serving three destinations:
  // a native in-app run, a recorded study, or a window.open hand-off to an
  // external form. Only the last leaves Cortex, and DT-8 discloses the
  // destination on every external hand-off - so the "leaving Cortex" note is
  // shown for exactly that case (not for the two in-app ones).
  const isExternalButtonHandoff =
    !isNativeSurvey &&
    !(opportunity?.type === 'unmoderated' && opportunity?.firsthand_study_id) &&
    externalLinkIsUsable;

  // Fix-first row 7 (second-pass review). This used to check only whether a
  // study was LINKED, never whether it was still open - a native survey/poll
  // or a recorded study with an `end_date` in the past stayed enabled and
  // minted a new session for something that had already closed. Derived from
  // the same countdown the row and the "N active studies" count already read,
  // so the button cannot disagree with what the rest of the product says
  // about this study.
  const closingTime = opportunity ? getClosingTime(opportunity) : null;
  // NO LONGER CLIENT-ONLY (cto/AdaptaLabs#129). Both mint routes derive the
  // same closing time in SQL - `end_date`, else the last session's `end_time` -
  // and refuse a FRESH mint with a 403 past it, so a stale tab, a replayed
  // request or a script gets a refusal rather than a session.
  // `loadMintableOpportunity` in backend/src/routes/opportunities.ts mirrors
  // `getClosingTime` arm for arm, and a change to either belongs in both.
  //
  // ONE EXEMPTION, AND IT IS THE PRODUCT DECISION (cto/AdaptaLabs#129, Nick's
  // call). The survey mint route's deadline gate sits BELOW its resume lookup,
  // so a participant who was part-way through when the deadline passed is
  // handed back their existing session url and can finish; only a fresh start
  // is refused. The detail read follows the same split - a `closed` study
  // answers 410 to a non-admin EXCEPT when that viewer's own session is still
  // in flight, when it serves the full 200 body with
  // `completion.inProgress: true`. So `hasEnded` being true no longer implies
  // "no way in": `hasResumableNativeSurvey` below is this page's half of that
  // exemption, and it must stay keyed on the server's flag rather than on any
  // locally-derived guess at who is mid-survey.
  //
  // THIS PAGE agrees with that server rule on both arms, because the detail
  // read serves every session unfiltered. THE BROWSE ROW agrees on `end_date`
  // only: the listing attaches sessions through UPCOMING_SESSIONS_ONLY, so an
  // undated study whose slots have all run reaches the row with `sessions: []`,
  // reads as "no deadline" there and still shows its action verb - while this
  // page and the server both call it ended. Pre-existing and the safe
  // direction, the server being the stricter side, but do not read the row as
  // proof of the sessions arm.
  //
  // THE ROW CANNOT SHOW RESUME, AND ONCE THE SWEEP RUNS THERE IS NO ROW. Two
  // separate facts, and the second is the one that bounds this feature. The
  // list read never carries `inProgress` - it omits it by design - so the row
  // could not render the Resume state in any case. But it also hard-filters
  // non-admins to `o.status = 'published'` (opportunities.ts), so the moment
  // autoClosePublishedStudiesPastEndDate flips the study to `closed` the study
  // disappears from Browse and from the participant Home count altogether.
  // A participant mid-survey therefore reaches their Resume button only by a
  // direct URL - a bookmark, the browser's history, or the invitation link
  // they were sent. That is a real limit of the closed-study exemption rather
  // than an oversight in this component: the server-side fix keeps the door
  // unlocked, and nothing in the product walks them back to it. Widening the
  // list read to carry a participant's own in-flight closed studies would be
  // the fix, and it is not this ticket.
  //
  // The one path this gate still owns alone is the external hand-off, where
  // `window.open` leaves Cortex and the server sees no request at all -
  // inherent to handing off, and the same reason the screener note further down
  // this file exists.
  const hasEnded = getTimeRemainingUntil(closingTime).urgency === 'ended';
  const closedOnLabel = formatStudyDate(closingTime?.toISOString());

  /**
   * This viewer holds a live, unanswered, unexpired session on this native
   * survey/poll/one-question (cto/AdaptaLabs#129).
   *
   * Read straight off the server's `completion.inProgress`, which is the SAME
   * `isInFlightRuntimeSession` predicate the survey-session mint route's resume
   * lookup uses - so a page that offers Resume is a page whose click that route
   * will actually resume, rather than refuse with a fresh-mint 403.
   *
   * `firsthand_study_id` is required because `runTakePart`'s native branch is,
   * and without it the click would fall through to the external hand-off or to
   * nothing at all.
   *
   * NO `!completion.completed` TERM (cto/AdaptaLabs#129, LOW-8). It was here
   * and it was inert twice over: `completed` and `inProgress` are mutually
   * exclusive before this component sees them, and `hasCompletedNativeSurvey`
   * renders above the button branch anyway. Deleting it removed nothing - all
   * 17 tests in this file stayed green when it was removed, which is exactly
   * why it could not stay: a term that cannot fail reads to the next person as
   * the guard against a state it never guarded.
   *
   * WHAT CARRIES THE EXCLUSION, stated exactly, because the first version of
   * this comment pointed at one half of it and called it pinned (LOW-2 of
   * the review pass on the same ticket). TWO redundant server guards produce
   * it, either of which holds alone:
   *   - `inProgress: !completed && isInFlightRuntimeSession(...)` in
   *     `participantSessionSummaryForOpportunity`, and
   *   - `isInFlightRuntimeSession`'s OWN `isAnsweredRuntimeStatus` early
   *     return, which answers false for a completed session whatever the
   *     caller did.
   * `never reports a completed session as in progress` in
   * opportunity-detail-resume-postgres.test.ts asserts the OUTCOME rather
   * than either guard, so - measured, all three arms - it survives the
   * removal of either one and reds only when both go. It pins that the
   * invariant cannot be dismantled entirely, not that either guard is
   * individually load-bearing.
   */
  const hasResumableNativeSurvey = Boolean(
    isNativeSurvey &&
    opportunity?.firsthand_study_id &&
    opportunity?.completion?.inProgress
  );

  const hasStartablePath = Boolean(
    (!hasEnded || hasResumableNativeSurvey) &&
    (opportunity?.type === 'unmoderated' || isNativeSurvey
      ? opportunity?.firsthand_study_id
      : externalLinkIsUsable)
  );

  // The participant's own completion of this native survey/poll/one-question
  // (audit row 10). When set, the page shows the completion instead of a Start
  // button - the server already refuses a second answer with a 409, so a live
  // button here would only ever hand back an error. The date is best-effort:
  // an older completed session may have no `completed_at`, and the sentence
  // reads without it.
  const hasCompletedNativeSurvey = Boolean(
    isNativeSurvey && opportunity?.completion?.completed
  );
  const completedOnLabel = formatStudyDate(opportunity?.completion?.completedAt);
  const [recordedStudyBrief, setRecordedStudyBrief] = useState<RecordedStudyBrief | null>(null);
  // Default to the grouped-day list ('table'). For the clustered availability
  // these studies produce it reads faster than the diary grid, which spends
  // most of its height on empty hours. Calendar stays one click away.
  const [viewMode, setViewMode] = useState<'table' | 'calendar'>('table');
  const [userCalendarEvents, setUserCalendarEvents] = useState<CalendarEvent[]>([]);
  // Only the setter is read - the loading flag drives no UI here (the calendar
  // renders its own state), so the value slot is left unbound.
  const [, setLoadingCalendar] = useState(false);
  // BK-3: which of this opportunity's sessions the participant has already
  // booked, so the table view's slot chips can show "Booked" instead of
  // collapsing into the generic "Full" chip a booked-out slot also matches.
  // Sourced independently of CalendarGrid's own bookedSlots (it fetches the
  // same getMyBookings() internally) rather than lifting state into a shared
  // prop - CalendarGrid's fetch is fully self-contained and untouched here,
  // so this stays a low-risk addition instead of a cross-component refactor.
  const [bookedSlots, setBookedSlots] = useState<Set<string>>(new Set());
  // Table view booking confirmation state
  const [confirmBooking, setConfirmBooking] = useState<{ show: boolean; session: Session | null }>({ show: false, session: null });
  // The consent gate (#79 step 1b): which session is waiting on the
  // participant's consent decision. Both booking surfaces funnel through
  // handleBookSession, so one gate covers them both.
  const [consentGate, setConsentGate] = useState<{ show: boolean; sessionId: string | null }>({ show: false, sessionId: null });
  // The screener gate (MR2): the take-part action waiting on the participant's
  // eligibility check. `book` carries the session to resume; `takePart` covers
  // the single survey/recorded/external button.
  const [screenerGate, setScreenerGate] = useState<{
    show: boolean;
    pending: { kind: 'book'; sessionId: string } | { kind: 'takePart' } | null;
  }>({ show: false, pending: null });
  const errorBannerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Two things the page now owes the participant, because it no longer
   * disappears when something fails.
   *
   * TAKE THEM TO THE MESSAGE. The banner renders above the study brief, while
   * the calendar and the Start Test button are both well below the fold. The
   * old full-page takeover was destructive but never missable - the page
   * collapsed to a short alert and the browser clamped scroll to the top.
   * Someone who had scrolled down to click a slot would otherwise now see
   * literally nothing change when that slot fails. aria-live covers assistive
   * tech only; this is for everyone else.
   *
   * AND DO NOT CONTRADICT IT. bookingSuccess lives in a different panel and
   * nothing else clears it, so a booking that succeeded and a later failure -
   * a failed refresh, say - could show a green "Successfully booked" and a red
   * error at once. That was impossible while any error removed the page.
   */
  useEffect(() => {
    if (!error) return;

    setBookingSuccess(null);

    const banner = errorBannerRef.current;
    if (!banner) return;
    // Optional call: jsdom does not implement scrollIntoView, and a missing
    // scroll must not cost the focus move on the line after it.
    banner.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    banner.focus();
  }, [error]);

  const loadOpportunity = useCallback(async (forceRefresh = false) => {
    if (!id) return;

    try {
      setLoading(true);
      setError('');

      // Always use cache busting when force refreshing or when coming back to the page
      const params = forceRefresh ? { _t: Date.now() } : undefined;
      const data = await getOpportunity(id, params);

      setOpportunity(data);
    } catch (err: unknown) {
      const axiosError = err as { response?: { status?: number; data?: { error?: string; code?: string } }; message?: string };
      const status = axiosError.response?.status;
      const code = axiosError.response?.data?.code;
      const serverMessage = axiosError.response?.data?.error;

      // Provide specific error messages, and decide whether a Retry could ever
      // help. Reloading changes nothing for a study that has closed, is not yet
      // open, was removed, or that this reader may not see - so those states
      // drop the Retry button rather than offer a control that reloads into the
      // same answer. Only a transient failure (5xx, timeout, dropped
      // connection) is worth retrying.
      let retryable = false;
      if (code === 'OPPORTUNITY_CLOSED' || code === 'OPPORTUNITY_NOT_OPEN') {
        // The server words these two for the participant; keep its sentence.
        setError(serverMessage || 'This study is not currently available.');
      } else if (status === 404) {
        setError('This study could not be found. It may have been removed.');
      } else if (status === 401) {
        setError('Please log in to view this study.');
      } else if (status === 403) {
        setError('You do not have permission to view this study.');
      } else {
        const errorMessage = serverMessage || axiosError.message || 'Failed to load study';
        setError(`Failed to load study: ${errorMessage}`);
        retryable = true;
      }
      setErrorRetryable(retryable);

      // Drop the loaded study when the server said it is no longer ours to
      // show, and keep it when the server simply did not answer.
      //
      // This is what makes the page-level `error && !opportunity` gate correct
      // by construction rather than by coincidence. Without it, a study that
      // has since been deleted, unpublished or closed - or a draft whose reader
      // has lost the role that let them see it - would keep rendering from
      // stale state behind a banner, indefinitely, with a bookable calendar for
      // something that is not bookable. A 5xx, a timeout or a dropped
      // connection says nothing about entitlement, so there the content on
      // screen is still the best thing to show and the banner annotates it.
      if (status === 401 || status === 403 || status === 404 || status === 410) {
        setOpportunity(null);
      }
    } finally {
      setLoading(false);
    }
    // Only the route id: the rest are setters.
  }, [id]);

  useEffect(() => {
    // Always force refresh when component mounts to ensure fresh data
    loadOpportunity(true);
  }, [id, loadOpportunity]);

  // Track view click when user opens the study details page
  // Track the view once per study actually loaded.
  //
  // Reads the id off the LOADED opportunity rather than off the route, which
  // also removes the second dependency the rule was asking for. To be precise
  // about what this does and does not fix: on ordinary navigation the old code
  // was already correct, because the effect only re-ran once opportunity.id had
  // caught up with the route. It bites only when the two genuinely diverge -
  // an out-of-order response - where the loaded id is the truthful one.
  useEffect(() => {
    const loadedId = opportunity?.id;
    if (!loadedId) return;

    trackOpportunityClick(loadedId, 'view').catch(() => {
      // Silently fail - tracking shouldn't block user experience
    });
  }, [opportunity?.id]);

  // Load the shape of a recorded study - how many tasks, how long - so the page
  // can state it rather than relying on the description mentioning it.
  //
  // A failure here is deliberately silent and leaves the brief null. The
  // expectations block still renders its constant promises without it, and the
  // alternative - an error banner about a panel the participant has never seen
  // - would be noise on the one page that has to stay calm.
  useEffect(() => {
    let isMounted = true;
    const loadedId = opportunity?.id;

    if (!loadedId || opportunity?.type !== 'unmoderated' || !opportunity?.firsthand_study_id) {
      setRecordedStudyBrief(null);
      return;
    }

    getRecordedStudyBrief(loadedId)
      .then((brief) => {
        if (isMounted) setRecordedStudyBrief(brief);
      })
      .catch((err) => {
        // Silent to the PARTICIPANT, not to operators. An error banner about a
        // panel they have never seen would be noise on the one page that has to
        // stay calm, but if this endpoint starts failing every recorded-study
        // landing page quietly drops its task count and nothing reports it.
        logger.warn('Recorded study brief failed to load', { opportunityId: loadedId, err });
        if (isMounted) setRecordedStudyBrief(null);
      });

    return () => {
      isMounted = false;
    };
  }, [opportunity?.id, opportunity?.type, opportunity?.firsthand_study_id]);

  // Fetch calendar events when sessions are available
  useEffect(() => {
    let isMounted = true;

    const loadCalendarEvents = async () => {
      if (!opportunity?.sessions || opportunity.sessions.length === 0) {
        if (isMounted) setUserCalendarEvents([]);
        return;
      }

      try {
        if (isMounted) setLoadingCalendar(true);

        // Get date range from sessions
        const dates = opportunity.sessions
          .map(s => new Date(s.start_time))
          .sort((a, b) => a.getTime() - b.getTime());

        if (dates.length === 0) return;

        const startTime = new Date(dates[0]);
        startTime.setHours(0, 0, 0, 0);

        const endTime = new Date(dates[dates.length - 1]);
        endTime.setHours(23, 59, 59, 999);

        // Fetch calendar events
        const events = await getMyCalendarEvents(
          startTime.toISOString(),
          endTime.toISOString()
        );

        if (isMounted) setUserCalendarEvents(events);
      } catch (error: unknown) {
        // Deliberately not surfaced: the calendar overlay marks which sessions
        // clash with the participant's own diary, and the booking grid is fully
        // usable without it. It IS logged, which the comment here used to claim
        // while nothing did it - the API interceptor covers a failed request,
        // but not a throw from the date arithmetic above it.
        logger.error('Failed to load participant calendar events', {
          component: 'OpportunityDetail',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        if (isMounted) setUserCalendarEvents([]);
      } finally {
        if (isMounted) setLoadingCalendar(false);
      }
    };

    loadCalendarEvents();

    return () => {
      isMounted = false;
    };
  }, [opportunity?.sessions]);

  // BK-3: load the participant's own bookings for this opportunity's sessions,
  // mirroring CalendarGrid's loadUserBookings effect so the table view's
  // "Booked" chip agrees with the calendar view's "Your booking" slot.
  useEffect(() => {
    let isMounted = true;

    const loadBookedSlots = async () => {
      const sessions = opportunity?.sessions;
      if (!sessions || sessions.length === 0) {
        if (isMounted) setBookedSlots(new Set());
        return;
      }

      try {
        const bookings = await getMyBookings();
        const allBookings = [...bookings.upcoming, ...bookings.past];
        const sessionIds = new Set(sessions.map(s => s.id));

        const bookedSessionIds = allBookings
          .filter(booking => booking.status === 'booked' && sessionIds.has(booking.session_id))
          .map(booking => booking.session_id);

        if (isMounted) setBookedSlots(new Set(bookedSessionIds));
      } catch (error: unknown) {
        logger.error('Failed to load participant bookings for table view', {
          component: 'OpportunityDetail',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        if (isMounted) setBookedSlots(new Set());
      }
    };

    loadBookedSlots();

    return () => {
      isMounted = false;
    };
  }, [opportunity?.sessions]);

  // Return the participant's own calendar event this session clashes with, or
  // null. BK-2: the table view needs the matched event to NAME the clash, not
  // just a yes/no - a boolean cannot say what the slot conflicts with. Callers
  // that only want the yes/no read its truthiness.
  const getCalendarConflict = useCallback((session: { start_time: string; end_time: string }): CalendarEvent | null => {
    if (userCalendarEvents.length === 0) {
      return null;
    }

    const sessionStart = new Date(session.start_time);
    const sessionEnd = new Date(session.end_time);

    return userCalendarEvents.find(event => {
      // Skip cancelled or declined events
      if (event.status === 'cancelled' || event.status === 'declined') {
        return false;
      }

      const eventStart = new Date(event.start);
      const eventEnd = new Date(event.end);

      // Skip if event times are invalid
      if (isNaN(eventStart.getTime()) || isNaN(eventEnd.getTime())) {
        return false;
      }

      // Check for actual overlap (not just touching)
      // Events overlap if: sessionStart < eventEnd AND sessionEnd > eventStart
      return (sessionStart < eventEnd && sessionEnd > eventStart);
    }) ?? null;
  }, [userCalendarEvents]);

  // Refresh data when user returns to the page (handles browser back/forward)
  // Throttled to prevent excessive refreshes - only refresh if page was hidden for > 30 seconds
  useEffect(() => {
    let hiddenTime: number | null = null;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Record when page became hidden
        hiddenTime = Date.now();
      } else if (!document.hidden && id && hiddenTime) {
        // Page became visible - only refresh if hidden for > 30 seconds
        const hiddenDuration = Date.now() - hiddenTime;
        if (hiddenDuration > 30000) {
          loadOpportunity(true);
        }
        hiddenTime = null;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // `id` stays listed: the visibility handler reads it directly, so trimming
    // it as implied-by-loadOpportunity reintroduces a violation.
  }, [id, loadOpportunity]);

  // The consent a booking of THIS opportunity must present (audit row 9),
  // resolved by the shared rule the server also uses: a moderated type
  // (test/interview) always has consent - the researcher's own wording or the
  // Cortex-owned baseline - so a live session with no typed wording no longer
  // books with no consent shown. Non-moderated types resolve to '' (no gate).
  const bookingConsentWording = opportunity
    ? bookingConsentText(opportunity.type, opportunity.consent_text)
    : '';

  // The screener gate (MR2). The participant response carries the REDACTED
  // screener (no `disqualifies` flags) and the participant's own status. A
  // screener gates every take-part path until the participant has QUALIFIED: a
  // not-yet-answered participant is sent through the check, and so is one who was
  // previously screened out, because a screen-out can be retaken (latest answer
  // wins, server side). Only a stored `qualified` verdict skips the gate.
  //
  // Keyed on the screener's PRESENCE, not on `screenerStatus`'s presence, and
  // that is deliberate. `assertScreenerPassed` (backend) enforces for EVERY
  // user with a screener and no stored qualified verdict - it does not exempt
  // the owner or an admin - so the client gate must fire for exactly that set to
  // mirror it. Keying on screener presence also stays correct now the admin
  // payload DOES carry `screenerStatus` (#134, server-side verdict readback for
  // admins): a qualified admin's status clears the gate below, and an admin who
  // has not answered still sees the modal. During the internal beta
  // CORTEX_BETA_ALL_ADMIN makes every employee an admin, so that set is the
  // whole internal cohort. Both admin and external participants now receive
  // `screenerStatus` when a screener exists, so presence-of-screener and
  // presence-of-status are the same shape - but this gate keys on the screener
  // regardless, so it fails closed even if a status is ever absent.
  const participantScreener =
    (opportunity?.screener as ParticipantScreener | null | undefined) ?? null;
  const screenerGates =
    !!participantScreener &&
    opportunity?.screenerStatus?.outcome !== 'qualified';

  /**
   * Books a session and owns the message shown when that fails.
   *
   * The contract the caller depends on: if this returns normally the booking
   * happened, and if it throws it did not. CalendarGrid marks the slot booked
   * optimistically before calling in and unwinds that mark on a throw, so the
   * two guards below have to reject rather than return - a guard that returned
   * quietly would leave the slot looking booked with nothing behind it.
   */
  const handleBookSession = async (sessionId: string, opts?: { skipScreener?: boolean }) => {
    if (!user) {
      setError('Please log in to book sessions');
      throw new Error('Not signed in');
    }

    // Additional validation
    if (!user.id) {
      setError('User session invalid. Please log in again.');
      throw new Error('User session invalid');
    }

    // The screener gate (MR2), BEFORE consent: eligibility is decided before the
    // participant is asked to agree to anything. Fails closed - a screener that
    // exists always gates until the participant has qualified. Detours through
    // the check and resumes in its qualify handler; thrown rather than returned
    // so CalendarGrid unwinds its optimistic "booked" mark while they answer.
    // `skipScreener` is set only by that resume, so the re-run walks past this to
    // the consent gate below rather than re-opening the check it just cleared.
    if (!opts?.skipScreener && screenerGates) {
      setScreenerGate({ show: true, pending: { kind: 'book', sessionId } });
      throw new Error('Screener decision pending');
    }

    // The consent gate (#79 step 1b; baseline extended in audit row 9). A
    // booking that must present consent - a moderated type always, whether it
    // carries its own wording or falls back to the baseline - detours through
    // the consent modal and continues in its Accept handler. Thrown rather than
    // returned so CalendarGrid unwinds the optimistic "booked" mark while the
    // participant reads - and no setError first: a pending decision is not a
    // failure, so nothing belongs in the banner.
    if (bookingConsentWording) {
      setConsentGate({ show: true, sessionId });
      throw new Error('Consent decision pending');
    }

    return performBooking(sessionId, false);
  };

  /**
   * The booking call itself, past any consent gate. Same contract as
   * handleBookSession: returns normally only if the booking happened.
   */
  const performBooking = async (sessionId: string, consentAccepted: boolean) => {
    try {
      setBookingLoading(sessionId);
      setError('');
      setBookingSuccess(null);

      await bookSession(sessionId, {
        consentAccepted,
        // The wording THIS page displayed, echoed so the server can refuse an
        // acceptance of text the participant never saw. The resolved booking
        // wording (own or baseline), the same value the modal showed.
        consentTextSeen: consentAccepted ? bookingConsentWording : undefined,
      });

      // Track action click for successful booking
      if (id) {
        trackOpportunityClick(id, 'action').catch(() => {
          // Silently fail - tracking shouldn't block user experience
        });
      }

      setBookingSuccess('Successfully booked! Check your bookings page.');

      // Small delay to ensure database transaction is committed
      await new Promise(resolve => setTimeout(resolve, 100));

      // Reload opportunity to update remaining slots with cache busting
      await loadOpportunity(true);
    } catch (err: unknown) {
      const axiosError = err as { response?: { status?: number; data?: { error?: string } }; code?: string; message?: string };

      if (axiosError.response?.status === 409) {
        // Use the specific error message from the backend
        const errorMessage = axiosError.response?.data?.error || 'Session is full or you are already booked';
        setError(errorMessage);

        // If it's a capacity issue, refresh the opportunity data to get latest info
        if (errorMessage.includes('full') || errorMessage.includes('capacity')) {
          await loadOpportunity(true);
          // Re-assert it: loadOpportunity opens with setError(''), so the
          // message set two lines up was cleared before it could ever render.
          // This is the commonest real booking failure - two participants
          // racing for the last slot - and the loser was seeing nothing at all,
          // just a slot that stopped responding. Not a swallowed exception, but
          // the same defect one layer up, and in the block this sweep is about.
          setError(errorMessage);
        }
      } else if (axiosError.response?.status === 401) {
        setError('Please log in to book sessions');
      } else if (axiosError.response?.status === 404) {
        setError('Session not found or study not published');
      } else if (axiosError.response?.status === 400) {
        // The server's own sentence: a 400 here is either the past-session
        // refusal or the consent-acceptance refusal, and hardcoding one of
        // them showed the wrong message for the other.
        setError(axiosError.response?.data?.error || 'Cannot book past sessions');
      } else if (axiosError.response?.status === 503) {
        setError('Database not available. Please try again later.');
      } else if (axiosError.response?.status === 500) {
        setError('Server error occurred. Please try again.');
      } else if (axiosError.code === 'NETWORK_ERROR' || axiosError.message === 'Network Error') {
        setError('Network error. Please check your connection and try again.');
      } else if (axiosError.code === 'ECONNABORTED' || axiosError.message?.includes('timeout')) {
        setError('Request timed out. Please try again.');
      } else {
        // Show more detailed error information
        const errorMessage = axiosError.response?.data?.error || axiosError.message || 'Failed to book session';
        setError(`Failed to book session: ${errorMessage}`);
      }

      // Rethrow after displaying the message. This function owns the error
      // MESSAGE, but CalendarGrid owns the optimistic "booked" mark it applied
      // before calling in, and it can only unwind that if the failure reaches
      // it - swallowing here resolved its await as though the booking had
      // worked.
      //
      // Unconditional, and checked rather than assumed: bookSession is the only
      // thing in the try above that can reject. loadOpportunity catches
      // everything internally and never rethrows, and trackOpportunityClick is
      // .catch()'d - so this cannot fire for a booking that actually worked.
      // Guarding it on a "did the booking land" flag was tried and removed: the
      // flag was unreachable, and its test passed against a build without it.
      //
      // The unwind is now actually visible: the page-level early return only
      // fires when there is no opportunity to show, so a failed booking leaves
      // the study and its calendar on screen with the message in the inline
      // banner, and the slot goes back to being clickable.
      throw err;
    } finally {
      setBookingLoading(null);
    }
  };

  /**
   * Start the study on the single take-part button: a native survey / poll /
   * one-question run, a recorded study, or a window.open hand-off to an external
   * tool.
   *
   * Extracted from the button's onClick so the screener gate can re-run it
   * verbatim once the participant qualifies - one definition, so the resumed
   * path and the direct click cannot drift.
   */
  const runTakePart = async () => {
    if (!opportunity) return;
    if (isNativeSurvey && opportunity.firsthand_study_id) {
      setFirstHandLoading(true);
      try {
        await trackOpportunityClick(opportunity.id, 'action');
        const { session_url } = await startSurveySession(opportunity.id);
        window.location.assign(session_url);
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } }).response?.status;
        const closedResponse = readClosedStudyRefusal(err);
        // 404 is the API's answer for every "this is not a runnable native
        // survey" case - wrong type, external delivery, a task list linked by
        // mistake. The participant cannot act on any of them, so they get one
        // honest sentence.
        if (status === 404) {
          setError('This survey is not available. Please contact your research team.');
        } else if (closedResponse) {
          setError(closedResponse);
        } else if (status === 403) {
          setError('This study is not yet available. Please try again later.');
        } else if (status === 409) {
          // The backend refuses a second mint once a session is completed or
          // uploading, rather than resetting it - re-answering would silently
          // overwrite the stored responses, and the survey runtime keeps no
          // history of what they were.
          setError('You have already answered this survey.');
        } else {
          setError('Could not open the survey. Please try again or contact support.');
        }
      } finally {
        setFirstHandLoading(false);
      }
    } else if (opportunity.type === 'unmoderated' && opportunity.firsthand_study_id) {
      setFirstHandLoading(true);
      try {
        await trackOpportunityClick(opportunity.id, 'action');
        const { session_url } = await startRecordedStudySession(opportunity.id);
        window.location.assign(session_url);
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } }).response?.status;
        const code = (err as { response?: { data?: { code?: string } } }).response?.data?.code;
        // A database outage and an unconfigured study both answer 503; only the
        // second is the research team's to fix, so key on the code before the
        // status.
        const closedResponse = readClosedStudyRefusal(err);
        if (code === 'DB_CONNECTION_FAILED' || code === 'DB_NOT_CONFIGURED') {
          setError('Temporarily unavailable. Please try again shortly.');
        } else if (status === 503) {
          setError('This study is not yet configured. Please contact your research team.');
        } else if (closedResponse) {
          setError(closedResponse);
        } else if (status === 403) {
          setError('This study is not yet available. Please try again later.');
        } else {
          setError('Could not start session. Please try again or contact support.');
        }
      } finally {
        setFirstHandLoading(false);
      }
    } else if (externalLinkIsUsable) {
      // Guarded on the SCHEME, not on the string being non-empty. `window.open`
      // is a navigation like any other, and a stored `javascript:` URL is
      // exactly what must not reach it.
      //
      // ponytail: the screener gate on this external hand-off is CLIENT-ONLY.
      // window.open leaves Cortex and the server never sees the navigation, so a
      // determined participant can open external_link_optional directly and skip
      // the check. handleTakePartClick refuses the in-app path here, which is all
      // the client can enforce; ADR-0007 records this ceiling as accepted.
      //   -> cto/AdaptaLabs#133, breaks if a participant reaches the external
      //      link without going through this button
      await trackOpportunityClick(opportunity.id, 'action');
      window.open(opportunity.external_link_optional, '_blank', 'noopener,noreferrer');
    }
  };

  /**
   * The take-part button, gated on the screener (MR2).
   *
   * Fails closed: a screener that exists sends the participant through the check
   * before any of the four paths runs, and resumes only on a qualify.
   */
  const handleTakePartClick = () => {
    if (screenerGates) {
      setScreenerGate({ show: true, pending: { kind: 'takePart' } });
      return;
    }
    void runTakePart();
  };

  /**
   * Resume the pending take-part action once the participant qualifies.
   *
   * Optimistically marks the screener cleared so the resumed action does not
   * re-open the gate it just passed: the closures below still hold the
   * pre-submit status, so the booking path is resumed with `skipScreener` rather
   * than by re-reading it. The next loadOpportunity confirms the verdict from
   * the server.
   */
  const resumeAfterScreener = () => {
    const pending = screenerGate.pending;
    setScreenerGate({ show: false, pending: null });
    setOpportunity((previous) =>
      previous
        ? { ...previous, screenerStatus: { answered: true, outcome: 'qualified' } }
        : previous
    );
    if (!pending) return;
    if (pending.kind === 'book') {
      void handleBookSession(pending.sessionId, { skipScreener: true }).catch(() => undefined);
    } else {
      void runTakePart();
    }
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'published': return 'badge bg-success text-white';
      case 'draft': return 'badge bg-warning text-white';
      case 'closed': return 'badge bg-secondary text-white';
      default: return 'badge bg-secondary text-white';
    }
  };

  // Same rule as the error gate below, and the fix is only half applied
  // without it: a refresh of a page that is ALREADY on screen must not blank
  // it. This branch runs first, so a bare `if (loading)` undid most of the
  // point - the 409 path awaits loadOpportunity(true), so "Session is full"
  // still made the study and its calendar vanish to a spinner and come back.
  // It also meant the banner's own Refresh Data button unmounted the banner it
  // lives in, which is why its `disabled={loading}` was unreachable.
  //
  // The in-place affordance for a refresh already exists: the ghost refresh
  // control in the sessions panel spins on `loading`.
  if (loading && !opportunity) {
    return (
      <div className="container mt-4" aria-busy="true" aria-live="polite">
        <h1>Loading study</h1>
        <div className="text-center py-5">
          <div className="spinner-border" role="status" aria-label="Loading study">
            <span className="visually-hidden">Loading study...</span>
          </div>
          <p className="mt-2">Loading study...</p>
        </div>
      </div>
    );
  }

  // Only take the whole page over when there is genuinely nothing to show.
  //
  // This used to be a bare `if (error)`, which meant ANY error replaced the
  // entire page with the alert below - the study description, the session
  // calendar, all of it - leaving a full reload as the only way back. An
  // ordinary "Session is full" from two participants racing for the last slot
  // did that. So did a failed refresh of a page that was already on screen and
  // perfectly readable.
  //
  // It also made the page's own inline error banner unreachable dead code: the
  // one further down with Refresh Data, Retry Booking and a dismiss button,
  // which is obviously the intended surface for a failure that happens while
  // you are looking at a study. This restores it.
  //
  // The distinction is what the participant can still do, not how bad the error
  // is. No opportunity means the page has no content and the error IS the page.
  // An opportunity in hand means the error is about one action, and taking the
  // study away to report it costs more than it explains.
  if (error && !opportunity) {
    // A retryable (transient) failure reads as an error and offers Retry; a
    // terminal state - closed, not yet open, removed, or not permitted - reads
    // as calm information with no dead control.
    return (
      <div className="container mt-4">
        <h1>Study details</h1>
        <div className={`alert ${errorRetryable ? 'alert-danger' : 'alert-info'}`} role="alert">
          {error}
          {errorRetryable && (
            <button
              className="btn btn-sm btn-outline-danger ms-2"
              onClick={() => window.location.reload()}
              style={{ color: '#c82333', borderColor: '#c82333' }}
            >
              Retry
            </button>
          )}
          <div className="mt-3">
            <button
              className="btn btn-sm btn-outline-secondary"
              onClick={() => navigate('/')}
            >
              <Icon icon={ArrowLeft} size={16} className="me-1" aria-hidden="true" />
              Back to {PARTICIPATE}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!opportunity) {
    return (
      <div className="container mt-4">
        <h1>Study details</h1>
        <div className="alert alert-warning" role="alert">
          Study not found
        </div>
      </div>
    );
  }

  // Null whenever eligibility does not actually narrow, which is most studies.
  // Safe to compute here: every early return above has already handled a
  // missing opportunity.
  const eligibilityNote = getEligibilityNote(opportunity);

  /**
   * Whether any session is still bookable-in-principle - not yet ended.
   *
   * #113: a published live-session study whose sessions are all in the past
   * used to hand its whole calendar to the participant, who then landed on
   * past, unbookable columns. That is the #112 fallback (CalendarGrid anchors
   * on the true earliest day when nothing is upcoming) doing the wrong thing
   * for the all-past case: correct mid-run, stranding once nothing is left.
   * When this is false the participant view shows a plain "No upcoming
   * sessions" state instead of the grid; the researcher's Session Management
   * grid is a different surface and is unchanged.
   *
   * `end_time >= now` is the same boundary the table view and CalendarGrid
   * already use for "past" (`isSessionPast`), so a session still running counts
   * as upcoming and the live calendar still mounts.
   */
  const hasUpcomingSessions = Boolean(
    opportunity.sessions?.some(s => new Date(s.end_time) >= new Date())
  );

  return (
    <div className="container-fluid py-4 opportunity-detail-page mission-control">
      <section className="container mt-4" aria-label="Study details" style={{ position: 'relative', zIndex: 1 }}>
        <div className="row">
          <div className="col-12">
          {/* Back button */}
          <button
            className="btn btn-outline-secondary mb-4 mission-back-btn"
            onClick={() => navigate('/')}
          >
            <Icon icon={ArrowLeft} size={16} className="me-1" aria-hidden="true" />
            Back to {PARTICIPATE}
          </button>


          {/* Session completion confirmation - shown when returning from a recorded study */}
          {isSessionCompleted && (
            <div
              className="mission-glass-panel mb-4"
              role="status"
              aria-live="polite"
              style={{ position: 'relative', textAlign: 'center', padding: '2.25rem 1.5rem' }}
            >
              <button
                type="button"
                className={`btn-close ${isDark ? 'btn-close-white' : ''}`}
                onClick={() => navigate(`/opportunities/${id}`, { replace: true })}
                aria-label="Dismiss confirmation"
                style={{ position: 'absolute', top: '1rem', right: '1rem' }}
              />
              <CheckCircle size={44} className="mb-3" style={{ color: 'var(--brand-orange-700)' }} aria-hidden="true" />
              {/* Styled as a heading but not a semantic h2: the page's h1 (the study
                  title) renders lower in Module A, so a real heading here would break
                  document heading order. */}
              <p className="h4 mb-2">Session complete</p>
              <p className="mission-description" style={{ maxWidth: '520px', margin: '0 auto 1.5rem' }}>
                Thank you. Your recording and responses have been saved, and the research team will be in touch if they need anything more.
              </p>
              <button
                type="button"
                className="btn btn-primary mission-cta-btn"
                onClick={() => navigate('/')}
              >
                Browse more studies
              </button>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div
              ref={errorBannerRef}
              tabIndex={-1}
              className="alert alert-danger alert-dismissible fade show mission-alert"
              role="alert"
              aria-live="assertive"
            >
              {error}
              <div className="mt-2">
                <button
                  className="btn btn-sm btn-outline-danger me-2"
                  onClick={() => loadOpportunity(true)}
                  disabled={loading}
                  aria-label="Refresh study data"
                >
                  <RefreshCw size={14} className="me-1" aria-hidden="true" />
                  Refresh Data
                </button>
                {/*
                  There WAS a "Retry Booking" button here, and it is deliberately
                  gone rather than restored along with the rest of this banner.
                  It retried `sessions.find(s => s.remaining > 0)` - the first
                  session with space, NOT the one the participant had chosen - so
                  the moment this banner became reachable it would have started
                  booking people into slots they never picked. Silently, since a
                  booking that succeeds says only "Successfully booked".
                  It is also redundant now: the whole point of not taking the
                  page over is that the calendar is still there, and the previous
                  change unwinds the failed slot's optimistic mark, so retrying
                  is clicking the slot again - against the slot they actually
                  want. If a one-click retry is ever wanted here, it has to carry
                  the session id that failed.
                */}
              </div>
              <button
                type="button"
                className="btn-close"
                onClick={() => setError('')}
                aria-label="Close error message"
              ></button>
            </div>
          )}

          {/* ============================================================
              MODULE A: THE BRIEF - Glass Panel (Title, Description, Meta)
              ============================================================ */}
          <div
            className="mission-glass-panel mission-brief"
            style={{
              '--accent-border-color': getCardHoverColor(opportunity?.type)
            } as React.CSSProperties}
          >
            {/* Hero Section - Two Column Layout */}
            <div className="mission-brief-layout">
              {/* Left Column: Content (60%) */}
              <div className="mission-brief-content">
                <div className="d-flex align-items-center gap-2 mb-3">
                  {/* This page is where the shareable link lands, so for most
                      participants it is the ONLY page they see - and it used to
                      print the raw type, which is the one word participant copy
                      is not allowed to use. The status badge below stays
                      admin-only and keeps its real value. */}
                  <span className={getTypeBadgeClass(opportunity?.type)}>
                    {(() => {
                      const TypeGlyph = getStudyTypeGlyph(opportunity?.type);
                      return TypeGlyph ? (
                        <Icon icon={TypeGlyph} size={14} aria-hidden="true" className="lozenge__glyph" />
                      ) : null;
                    })()}
                    {getParticipantFacingType(opportunity?.type)}
                  </span>
                  {(user?.role === 'researcher_admin' || user?.role === 'superadmin') && (
                    <span className={getStatusBadgeClass(opportunity.status)}>
                      {opportunity.status}
                    </span>
                  )}
                </div>
                <h1 className="mission-title">{opportunity.title}</h1>
                {/* Purpose/Description */}
                {opportunity.type !== 'question' && opportunity.purpose_one_liner && (
                  <p className="mission-description">{opportunity.purpose_one_liner}</p>
                )}
                {opportunity.description_optional && (
                  <div className="mission-description" style={{ marginTop: '12px' }}>
                    {opportunity.type === 'poll'
                      ? renderPollDescription(opportunity.description_optional)
                      : <p style={{ whiteSpace: 'pre-wrap' }}>{opportunity.description_optional}</p>
                    }
                  </div>
                )}

                {/* Admin-only, published-only. Renders null for everyone else,
                    so the participant view of this page is unchanged.
                    `startable` mirrors the CTA's own disabled rule below, so a
                    published opportunity nobody can start says so here rather
                    than being shared as if it works. */}
                <ShareOpportunityLink
                  opportunityId={opportunity.id}
                  role={user?.role}
                  startable={Boolean(
                    // Bookable types start by BOOKING A SLOT - they have neither a
                    // task list nor an external link, so the old test called every
                    // usability test and interview unstartable and told the
                    // researcher to "link a task list before sharing" a study with
                    // four open sessions.
                    opportunity.type === 'test' || opportunity.type === 'interview'
                      ? opportunity.sessions && opportunity.sessions.length > 0
                      : opportunity.firsthand_study_id || externalLinkIsUsable
                  )}
                  status={opportunity.status}
                />
              </div>

              {/* Right Column: Data Box (30%) - Technical Specs.

                  Every row here is conditional, and a native survey, poll or
                  one-question study with no product and no eligibility narrowing
                  suppresses all of them - which still shipped the box, its
                  border and its padding wrapped around nothing (DT-6). Each
                  row's condition is now named once and the box is rendered only
                  when at least one is true; when it is not, the flex:6 content
                  column takes the full width on its own. */}
              {(() => {
                const showProduct = opportunity.type !== 'question' && Boolean(opportunity.product_optional);
                // Duration for bookable types comes from the opportunity (which
                // asks for it); for a recorded study it comes from the STUDY, and
                // only when a researcher set one - default_duration_minutes is
                // NOT NULL DEFAULT 30, so printing it above a consent CTA would
                // state a figure nobody chose.
                const showBookableDuration = opportunity.type === 'test' || opportunity.type === 'interview';
                const showRecordedDuration = opportunity.type === 'unmoderated' && recordedStudyBrief?.estimated_duration_minutes != null;
                // DT-7: a poll, survey or single question that Cortex RUNS
                // (native delivery, SurveyRunner) carried no time expectation
                // at all. An HONEST QUALITATIVE one - never the untouched
                // default 30, never an invented precise figure - so every type
                // says roughly how long taking part takes. Gated on
                // isNativeSurvey, NOT on type: an EXTERNAL poll/survey hands off
                // to a third-party form Cortex never sees, so claiming "A few
                // minutes" about it would be exactly the figure-nobody-chose
                // this rule exists to avoid. A poll or single question is one
                // interaction; a survey is a few.
                const nativeDurationExpectation = !isNativeSurvey
                  ? null
                  : opportunity.type === 'survey'
                  ? 'A few minutes'
                  : 'Under a minute';
                const showNativeExpectation = nativeDurationExpectation !== null;
                // Task COUNT only (never the prompts - reading them up front turns
                // the recording into a rehearsed performance), recorded only.
                const showTasks = opportunity.type === 'unmoderated' && Boolean(recordedStudyBrief);
                // Participants only when eligibility actually narrows. "Any" was
                // printed on every unrestricted study; the rule lives in
                // getEligibilityNote so the browse row and this page cannot answer
                // the same question two different ways.
                const showParticipants = Boolean(eligibilityNote);
                // Roles/skills wanted (display-only): the advertised audience, so
                // the right people self-select. Describes; does not gate.
                const targetRoles = Array.isArray(opportunity.target_roles)
                  ? opportunity.target_roles
                  : [];
                const showTargetRoles = targetRoles.length > 0;

                if (!(showProduct || showBookableDuration || showRecordedDuration || showNativeExpectation || showTasks || showParticipants || showTargetRoles)) {
                  return null;
                }

                return (
                  <div className="mission-data-box">
                    <div className="mission-data-grid">
                      {showProduct && (
                        <div className="mission-data-item">
                          <span className="mission-data-label">PRODUCT</span>
                          <span className="mission-data-value">{opportunity.product_optional}</span>
                        </div>
                      )}

                      {showBookableDuration && (
                        <div className="mission-data-item">
                          <span className="mission-data-label">DURATION</span>
                          <span className="mission-data-value">{opportunity.default_duration_minutes} min</span>
                        </div>
                      )}
                      {showRecordedDuration && (
                        <div className="mission-data-item">
                          <span className="mission-data-label">DURATION</span>
                          <span className="mission-data-value">
                            {recordedStudyBrief?.estimated_duration_minutes} min
                          </span>
                        </div>
                      )}
                      {showNativeExpectation && (
                        <div className="mission-data-item">
                          <span className="mission-data-label">DURATION</span>
                          <span className="mission-data-value">{nativeDurationExpectation}</span>
                        </div>
                      )}

                      {showTasks && (
                        <div className="mission-data-item">
                          <span className="mission-data-label">TASKS</span>
                          <span className="mission-data-value">
                            {recordedStudyBrief?.task_count}
                          </span>
                        </div>
                      )}

                      {showParticipants && (
                        <div className="mission-data-item">
                          <span className="mission-data-label">PARTICIPANTS</span>
                          <span className="mission-data-value">{eligibilityNote}</span>
                        </div>
                      )}

                      {showTargetRoles && (
                        <div className="mission-data-item">
                          <span className="mission-data-label">LOOKING FOR</span>
                          <span className="mission-data-value">{targetRoles.join(', ')}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* ============================================================
              MODULE B: THE SCHEDULER - Glass Panel (Calendar)
              Hidden on the completion screen so a just-finished participant is
              not re-offered the launch CTA alongside the "Session complete"
              confirmation. Dismissing the confirmation restores it.
              ============================================================ */}
          {!isSessionCompleted && (
          <div className="mission-glass-panel mission-scheduler">

              {/* Sessions for test and interview opportunities */}
              {(opportunity.type === 'test' || opportunity.type === 'interview') && (
                <>
                  {/* Success message for bookings */}
                  {bookingSuccess && (
                    <div className="alert alert-success d-flex justify-content-between align-items-center" style={{ marginBottom: '1.5rem' }} role="alert" aria-live="polite">
                      <div>
                        <CheckCircle size={18} className="me-2" aria-hidden="true" />
                        {bookingSuccess}
                        <button
                          className="btn btn-sm btn-outline-success ms-3"
                          onClick={() => navigate('/my-bookings')}
                          aria-label="Navigate to My bookings page"
                        >
                          <Calendar size={14} className="me-1" aria-hidden="true" />
                          View my bookings
                        </button>
                      </div>
                      <button
                        type="button"
                        className="btn-close"
                        onClick={() => setBookingSuccess(null)}
                        aria-label="Close success message"
                      ></button>
                    </div>
                  )}

                  {/* Calendar Integration */}
                  <div className="mb-4">
                    <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
                      {/* Header with inline hint */}
                      <div className="d-flex align-items-center flex-wrap gap-2">
                        <h2 className="mb-0 h5">Available Sessions</h2>
                        {/* Inline Legend - the colour key and the view toggle
                            below only make sense when there is a grid to read;
                            #113 suppresses both when every session has ended. */}
                        {hasUpcomingSessions && (
                          <>
                            <span className="calendar-hint-divider ms-2" aria-hidden="true">|</span>
                            <div className="d-flex align-items-center flex-wrap gap-3" role="list" aria-label="Calendar legend">
                              {CALENDAR_LEGEND_ITEMS.map((item) => (
                                <div key={item.label} className="d-flex align-items-center gap-1" role="listitem">
                                  <div
                                    className={`legend-swatch ${item.className}`}
                                    style={{ width: '12px', height: '12px', borderRadius: '3px' }}
                                  />
                                  <small className={`legend-label ${item.labelClass}`} style={{ fontSize: '0.7rem' }}>
                                    {item.label}
                                  </small>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                      <div className="d-flex align-items-center gap-2">
                        {/* Ghost Refresh Button */}
                        <button
                          type="button"
                          onClick={() => loadOpportunity(true)}
                          disabled={loading}
                          aria-label="Refresh sessions data"
                          title="Refresh sessions data"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '4px 8px',
                            fontSize: '0.7rem',
                            fontWeight: '500',
                            border: '1px solid var(--border-card)',
                            borderRadius: '4px',
                            cursor: loading ? 'not-allowed' : 'pointer',
                            transition: 'all 0.15s ease',
                            backgroundColor: 'transparent',
                            color: 'var(--text-muted)',
                            opacity: loading ? 0.5 : 1
                          }}
                          onMouseEnter={(e) => {
                            if (!loading) {
                              e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                              e.currentTarget.style.color = 'var(--text-primary)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'transparent';
                            e.currentTarget.style.color = 'var(--text-muted)';
                          }}
                        >
                          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
                          Refresh
                        </button>

                        {/* Segmented Control for View Mode - hidden when there
                            is nothing to view (#113, all sessions past). */}
                        {hasUpcomingSessions && (
                        <div
                          role="group"
                          aria-label="View mode selection"
                          style={{
                            display: 'inline-flex',
                            backgroundColor: 'var(--bg-card)',
                            borderRadius: '6px',
                            padding: '3px',
                            border: '1px solid var(--border-card)'
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => setViewMode('calendar')}
                            aria-pressed={viewMode === 'calendar'}
                            aria-label="Switch to calendar view"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 10px',
                              fontSize: '0.75rem',
                              fontWeight: viewMode === 'calendar' ? '600' : '500',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                              backgroundColor: viewMode === 'calendar' ? 'var(--brand-orange-700)' : 'transparent',
                              color: viewMode === 'calendar' ? '#FFFFFF' : 'var(--text-muted)',
                              boxShadow: viewMode === 'calendar' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none'
                            }}
                          >
                            <LayoutGrid size={12} aria-hidden="true" />
                            Calendar
                          </button>
                          <button
                            type="button"
                            onClick={() => setViewMode('table')}
                            aria-pressed={viewMode === 'table'}
                            aria-label="Switch to table view"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 10px',
                              fontSize: '0.75rem',
                              fontWeight: viewMode === 'table' ? '600' : '500',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                              // Text-safe step, not the identity colour: this
                              // fill carries the white "Table" label, and
                              // --brand-primary under white is 3.87 / 3.29.
                              backgroundColor: viewMode === 'table' ? 'var(--accent-fill-text-safe)' : 'transparent',
                              color: viewMode === 'table' ? '#FFFFFF' : 'var(--text-muted)',
                              boxShadow: viewMode === 'table' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none'
                            }}
                          >
                            <Table2 size={12} aria-hidden="true" />
                            Table
                          </button>
                        </div>
                        )}
                      </div>
                    </div>

                  {opportunity.sessions && opportunity.sessions.length > 0 ? (
                    !hasUpcomingSessions ? (
                      /* #113: sessions exist but every one has ended. Showing a
                         plain empty state beats handing the participant a grid
                         of past, unbookable columns with no way forward. */
                      <div className="alert alert-info d-flex align-items-center" role="status">
                        <Info size={18} className="me-2" aria-hidden="true" />
                        No upcoming sessions. Every scheduled session for this study has already taken place.
                      </div>
                    ) : (
                    <>
                      {/* BK-1: a soft warning when the participant already holds
                          a slot in this study. Session-level double booking is
                          blocked at the API (409 + partial unique index); this
                          covers the still-open case - booking a SECOND, different
                          slot of the same study - by naming the slot they hold
                          and linking to it, without disabling the booking. */}
                      {bookedSlots.size > 0 && (() => {
                        // Row 11 (second-pass review): `bookedSlots` is sourced
                        // from BOTH upcoming and past bookings (loadBookedSlots
                        // above), so a held session that has already happened
                        // used to win this sort outright whenever it was the
                        // chronologically earliest - telling a participant they
                        // were "already booked" for a date that had passed.
                        const now = Date.now();
                        const held = opportunity.sessions
                          .filter(session => bookedSlots.has(session.id) && new Date(session.end_time).getTime() > now)
                          .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())[0];
                        if (!held) return null;
                        const heldStart = new Date(held.start_time);
                        const heldDate = formatStudyDate(held.start_time);
                        const heldTime = formatClockTime(heldStart);
                        // Defensive: an unusable date would render "on  at .";
                        // a real session never produces one, so suppress rather
                        // than print blanks.
                        if (!heldDate || !heldTime) return null;
                        // Name the zone, same as the slot chips - this is the
                        // "booked an hour out" surface the datetime module guards.
                        const heldZone = formatTimeZoneLabel(heldStart);
                        return (
                          <div
                            className="alert alert-info d-flex align-items-center mb-3"
                            role="status"
                            data-testid="already-booked-notice"
                          >
                            <Info size={18} className="me-2 flex-shrink-0" aria-hidden="true" />
                            <span>
                              You are already booked for this study on {heldDate} at {heldTime} {heldZone}.{' '}
                              <Link to="/my-bookings">View my bookings</Link>
                            </span>
                          </div>
                        );
                      })()}
                      {viewMode === 'calendar' ? (
                        <CalendarGrid
                          key={`calendar-${opportunity.id}-${opportunity.sessions?.length || 0}-${opportunity.sessions?.reduce((sum, s) => sum + s.booked_count, 0) || 0}`}
                          sessions={opportunity.sessions}
                          onBookSession={handleBookSession}
                          bookingLoading={bookingLoading}
                          hideLegend={true}
                        />
                      ) : (
                        <>
                          {(() => {
                            // BK-2: show every future session, conflicts
                            // included. A slot that clashes with the
                            // participant's own diary is no longer hidden - it
                            // renders disabled, naming the clash - so no filter
                            // and no "N hidden" banner.
                            const futureSessions = opportunity.sessions.filter(
                              session => new Date(session.end_time) >= new Date()
                            );

                            return (
                              <>
                                <div className="momentum-table-container" aria-label="Available sessions">
                                  {futureSessions.length === 0 ? (
                                    <div className="text-center py-4">
                                      <small className="text-muted">
                                        No available sessions
                                      </small>
                                    </div>
                                  ) : (
                                    groupSessionsByDay(futureSessions).map((group) => (
                                      <div className="slot-day-group" key={group.key}>
                                        <div className="slot-day-header">
                                          {group.dateStr}
                                          {/* The timezone the reported "I booked an hour out"
                                              bug was about, stated once per day rather than on
                                              every row - still on the screen where the decision
                                              is made, and in every chip's aria-label below. */}
                                          {group.zone && (
                                            <span className="slot-day-zone"> · times {group.zone}</span>
                                          )}
                                        </div>
                                        <div className="slot-chips">
                                          {group.sessions.map((session) => {
                                            const startDate = new Date(session.start_time);
                                            const endDate = new Date(session.end_time);
                                            const startStr = formatClockTime(startDate);
                                            const rangeStr = `${formatTimeRange(startDate, endDate)} ${formatTimeZoneLabel(startDate)}`;
                                            const isLoading = bookingLoading === session.id;
                                            const isBooked = bookedSlots.has(session.id);

                                            // BK-3: checked before the full check, exactly as
                                            // CalendarGrid does - a slot the participant already
                                            // booked is full for everyone else, but it must never
                                            // collapse into the generic "Full" chip for them.
                                            if (isBooked) {
                                              return (
                                                <span
                                                  key={session.id}
                                                  className="slot-chip slot-chip-booked"
                                                  title={`Your booking: ${rangeStr}`}
                                                  aria-label={`${rangeStr} — your booking`}
                                                >
                                                  {startStr} · Booked
                                                </span>
                                              );
                                            }

                                            if (session.remaining <= 0) {
                                              return (
                                                <span
                                                  key={session.id}
                                                  className="slot-chip slot-chip-full"
                                                  title={`Full: ${rangeStr}`}
                                                  aria-label={`${rangeStr} is full`}
                                                >
                                                  {startStr} · Full
                                                </span>
                                              );
                                            }

                                            // BK-2: a slot that clashes with the
                                            // participant's own diary - shown
                                            // disabled, naming the clash, checked
                                            // after Full (a full slot is full for
                                            // everyone regardless of their diary),
                                            // mirroring CalendarGrid's precedence.
                                            const conflict = getCalendarConflict(session);
                                            if (conflict) {
                                              const clashLabel = describeCalendarClash(conflict);
                                              return (
                                                <span
                                                  key={session.id}
                                                  className="slot-chip slot-chip-conflict"
                                                  title={clashLabel}
                                                  aria-label={`${rangeStr} — ${clashLabel}`}
                                                >
                                                  {startStr} · Conflict
                                                </span>
                                              );
                                            }

                                            return (
                                              <button
                                                key={session.id}
                                                type="button"
                                                className="slot-chip"
                                                onClick={() => {
                                                  // Audit row 9: consent is the single
                                                  // affirmative step for a moderated booking -
                                                  // straight to the consent gate, no separate
                                                  // "Book this session?" press first (the grid
                                                  // path already does this). Non-moderated types
                                                  // keep the plain confirm.
                                                  if (bookingConsentWording) {
                                                    void handleBookSession(session.id).catch(() => undefined);
                                                  } else {
                                                    setConfirmBooking({ show: true, session });
                                                  }
                                                }}
                                                disabled={isLoading}
                                                title={rangeStr}
                                                aria-label={`Book session on ${group.dateStr} at ${rangeStr}`}
                                              >
                                                {isLoading ? (
                                                  <>
                                                    <span className="visually-hidden">Booking session...</span>
                                                    Booking…
                                                  </>
                                                ) : (
                                                  startStr
                                                )}
                                              </button>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    ))
                                  )}
                                </div>
                              </>
                            );
                          })()}
                        </>
                      )}
                    </>
                    )
                  ) : (
                    <div className="alert alert-info d-flex align-items-center" role="status">
                      <Info size={18} className="me-2" aria-hidden="true" />
                      Sessions will appear here when they are added by the researcher.
                    </div>
                  )}
                  </div>
                </>
              )}

              {/* External link for polls, surveys, questions, and unmoderated - only show if not test or interview */}
              {opportunity.type !== 'test' && opportunity.type !== 'interview' && (
                <div className="mb-4">
                  {/* What the next click actually does, stated before it is
                      clicked. Gated on a linked study rather than on the brief,
                      so a failed brief fetch still discloses the recording. */}
                  {opportunity.type === 'unmoderated' && opportunity.firsthand_study_id && (
                    <RecordedStudyExpectations brief={recordedStudyBrief} />
                  )}
                  <div className="row">
                    <div className="col-md-4">
                      {/* A native `question` joins this branch rather than the
                          anchor below it: it opens in this tab, in Cortex, and
                          the anchor's whole job is to hand off. An EXTERNAL
                          question still takes the anchor, unchanged. */}
                      {hasCompletedNativeSurvey ? (
                        <div
                          className="survey-completed-state"
                          role="status"
                          data-testid="survey-completed-state"
                        >
                          <CheckCircle
                            size={20}
                            className="survey-completed-state__icon"
                            aria-hidden="true"
                          />
                          <div>
                            <p className="survey-completed-state__title">
                              {opportunity.type === 'poll'
                                ? 'You have completed this poll'
                                : opportunity.type === 'question'
                                ? 'You have answered this question'
                                : 'You have completed this survey'}
                              {completedOnLabel ? ` on ${completedOnLabel}` : ''}
                            </p>
                            <p className="survey-completed-state__note">
                              Your response has been recorded. You can only take part once.
                            </p>
                          </div>
                        </div>
                      ) : hasEnded && !hasResumableNativeSurvey ? (
                        // Row 7 (second-pass review): checked ONLY inside the
                        // button branch below, so an EXTERNAL `question` -
                        // the one type that reaches the ExternalHandoff
                        // branch instead of the button - still handed off to
                        // a closed study's external form. Hoisted above the
                        // type branches so nothing downstream can bypass it.
                        //
                        // `!hasResumableNativeSurvey` is the #129 exemption:
                        // a participant the SERVER says is mid-survey falls
                        // through to the button branch below, which renders
                        // it as Resume and keeps this closed-on date beside
                        // it. Everyone else on a closed study still lands
                        // here, with no control at all.
                        <p className="text-muted mb-0">
                          This study closed on {closedOnLabel}.
                        </p>
                      ) : opportunity.type === 'poll' || opportunity.type === 'survey' || opportunity.type === 'unmoderated' || isNativeSurvey ? (
                        <>
                        {hasEnded && (
                          // The closed-on date does not disappear because
                          // there is a way back in: the participant is being
                          // told both that the study is over and that the run
                          // they already started can still be finished.
                          <p className="text-muted mb-2" data-testid="closed-study-resume-note">
                            This study closed on {closedOnLabel}. You can still finish the{' '}
                            {opportunity.type === 'poll'
                              ? 'poll'
                              : opportunity.type === 'question'
                              ? 'question'
                              : 'survey'}{' '}
                            you already started.
                          </p>
                        )}
                        <button
                          className="btn btn-primary w-100 mission-cta-btn"
                          onClick={handleTakePartClick}
                          disabled={
                            firstHandLoading || !hasStartablePath
                          }
                          aria-label={
                            // RESUME comes first, on both a closed study and an
                            // open one (cto/AdaptaLabs#129). The mint route
                            // resumes an in-flight session either way - the
                            // deadline gate sits below its resume lookup - so a
                            // button reading "Start" was already describing a
                            // resume on the open study too. Same visible words
                            // in the accessible name (WCAG 2.5.3).
                            hasResumableNativeSurvey && opportunity.type === 'poll' ? 'Resume poll in Cortex' :
                            hasResumableNativeSurvey && opportunity.type === 'question' ? 'Resume question in Cortex' :
                            hasResumableNativeSurvey ? 'Resume survey in Cortex' :
                            isNativeSurvey && opportunity.type === 'question' ? 'Answer question in Cortex' :
                            // A native poll's visible label is "Start poll", so its
                            // accessible name has to contain those words (WCAG 2.5.3
                            // label-in-name; voice control keys on the visible text).
                            // Without this it fell to the generic native branch below
                            // and announced "Start survey in Cortex" on a poll.
                            isNativeSurvey && opportunity.type === 'poll' ? 'Start poll in Cortex' :
                            isNativeSurvey ? 'Start survey in Cortex' :
                            opportunity.type === 'poll' ? 'Open poll in new tab' :
                            opportunity.type === 'survey' ? 'Open survey in new tab' :
                            // Participant vocabulary: "recorded study", never
                            // "test" and never "Task List" - but ONLY where a
                            // study is actually linked. An unmoderated
                            // opportunity carrying an external link and no task
                            // list falls through to window.open and records
                            // nothing, so calling that "recorded study" is the
                            // one thing on the page that would be lying.
                            opportunity.firsthand_study_id ? 'Start recorded study' : 'Open study in new tab'
                          }
                          title={
                            // A study that has ENDED only reaches this branch
                            // through the #129 resume exemption, which requires
                            // a linked study - so `!hasStartablePath` here is
                            // still only ever a missing/invalid link, on an
                            // open study, exactly as before.
                            !hasStartablePath ? 'Not available yet' : undefined
                          }
                        >
                          {firstHandLoading
                            ? hasResumableNativeSurvey
                              ? 'Resuming session...'
                              : 'Starting session...'
                            : hasResumableNativeSurvey
                            ? opportunity.type === 'poll'
                              ? 'Resume poll'
                              : opportunity.type === 'question'
                              ? 'Resume question'
                              : 'Resume survey'
                            : isNativeSurvey
                            ? opportunity.type === 'poll'
                              ? 'Start poll'
                              : opportunity.type === 'question'
                              ? 'Answer question'
                              : 'Start survey'
                            : opportunity.type === 'poll'
                            ? 'Open Poll'
                            : opportunity.type === 'survey'
                            ? 'Open Survey'
                            : opportunity.firsthand_study_id
                            ? 'Start recorded study'
                            : 'Open Study'}
                        </button>
                        {/* DT-8: the same destination disclosure the question
                            hand-off carries, for the window.open external poll /
                            survey / study path (the common external case). */}
                        {isExternalButtonHandoff && opportunity.external_link_optional && (
                          <ExternalDestinationNote url={opportunity.external_link_optional} />
                        )}
                        </>
                      ) : externalLinkIsUsable && opportunity.external_link_optional ? (
                        screenerGates ? (
                          // The screener gate on the external hand-off (MR2).
                          // This branch is the external `question` type, which
                          // can carry a screener but is not one of the four
                          // paths gated above - a raw <a href> here would let a
                          // participant navigate straight to the tool with no
                          // eligibility check. Routed through the same
                          // handleTakePartClick as the external poll/survey
                          // button, so a qualify opens the link (runTakePart's
                          // window.open) and a screen-out blocks it. Still the
                          // client-only ceiling recorded in #133, but the check
                          // is now shown rather than skipped entirely.
                          <>
                            <button
                              type="button"
                              className="btn btn-primary w-100 mission-cta-btn"
                              onClick={handleTakePartClick}
                              disabled={firstHandLoading || !hasStartablePath}
                              aria-label={opportunity.type === 'question' ? 'Answer Question' : 'Participate'}
                            >
                              {opportunity.type === 'question' ? 'Answer Question' : 'Participate'}
                            </button>
                            <ExternalDestinationNote url={opportunity.external_link_optional} />
                          </>
                        ) : (
                          // DT-8: one hand-off pattern that names where the click
                          // goes. This button used to say only "Participate" and
                          // never showed the host - the destination is disclosed
                          // here the way the recording task page and the bookings
                          // meeting link already disclose theirs.
                          <ExternalHandoff
                            url={opportunity.external_link_optional}
                            actionLabel={opportunity.type === 'question' ? 'Answer Question' : 'Participate'}
                          />
                        )
                      ) : (
                        /*
                          No anchor at all when the stored link is not a web
                          address. A disabled BUTTON rather than an anchor with
                          a neutered href, because an `href` is the thing that
                          has to not exist - and a participant is told the truth
                          rather than left pressing something inert.
                        */
                        <button
                          type="button"
                          className="btn btn-secondary w-100 mission-cta-btn"
                          disabled
                          aria-label="This study has no working link yet"
                        >
                          Link unavailable
                        </button>
                      )}
                    </div>
                  </div>
                  {/* Row 21 (second-pass review): this used to duplicate
                      ExternalDestinationNote above with a second, unnamed
                      "Opens in a new tab" line - the named disclosure (DT-8)
                      is the only one this button path needs. */}
                </div>
              )}
          </div>
          )}
          {/* End of MODULE B: THE SCHEDULER */}

          {/* Footer with owner info (admin only) */}
          {user?.role === 'researcher_admin' && opportunity.owner_name && (
            <div className="mission-footer">
              <small className="text-muted">
                <strong>Owner:</strong> {opportunity.owner_name} ({opportunity.owner_email})
              </small>
            </div>
          )}
        </div>
      </div>
      </section>

      {/* Table View Booking Confirmation Modal */}
      <ConfirmationModal
        show={confirmBooking.show}
        title="Confirm Booking"
        message={confirmBooking.session
          ? `Book this session?\n\n${formatDateTime(confirmBooking.session.start_time)}`
          : 'Book this session?'}
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        variant="primary"
        onConfirm={() => {
          if (confirmBooking.session) {
            // As with the retry path: the rethrow exists for CalendarGrid,
            // and the error banner is already the surface for this path.
            void handleBookSession(confirmBooking.session.id).catch(() => undefined);
          }
          setConfirmBooking({ show: false, session: null });
        }}
        onCancel={() => setConfirmBooking({ show: false, session: null })}
      />

      {/* The consent gate (#79 step 1b; baseline extended in audit row 9): the
          wording the participant is accepting - the opportunity's own or the
          Cortex-owned baseline. Cancel books nothing. */}
      <ConfirmationModal
        show={consentGate.show}
        title="Consent"
        message={bookingConsentWording}
        confirmLabel="Accept and book"
        cancelLabel="Cancel"
        variant="primary"
        onConfirm={() => {
          const sessionId = consentGate.sessionId;
          setConsentGate({ show: false, sessionId: null });
          if (sessionId) {
            // The error banner is the surface for a failure here, as on every
            // other booking path; the catch exists because performBooking
            // rethrows for CalendarGrid's sake and nothing above us awaits it.
            void performBooking(sessionId, true).catch(() => undefined);
          }
        }}
        onCancel={() => setConsentGate({ show: false, sessionId: null })}
      />

      {/* The screener gate (MR2): the eligibility check a participant answers
          before any take-part path runs. Reads the REDACTED screener, submits
          for the server's verdict, and resumes the pending action on a qualify.
          Cancel or a screen-out books/starts nothing. */}
      {screenerGate.show && participantScreener && opportunity && (
        <ScreenerCheck
          screener={participantScreener}
          onSubmit={async (answers): Promise<ScreenerOutcome> =>
            (await submitScreener(opportunity.id, answers)).outcome
          }
          onQualified={resumeAfterScreener}
          onClose={() => setScreenerGate({ show: false, pending: null })}
        />
      )}
    </div>
  );
};

export default OpportunityDetail;
