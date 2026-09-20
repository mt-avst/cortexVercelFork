import React, { useState, useEffect, useCallback, useMemo, memo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Session, CalendarEvent } from '../api/types';
import { getMyCalendarEvents, getCalendarConnectionStatus, getMyBookings } from '../api/client';
import { logger } from '../utils/logger';
import { sharedZoneOffset } from '../utils/datetime';
import { describeCalendarClash } from '../utils/calendarClash';
import { Info, ChevronLeft, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform } from 'framer-motion';

interface CalendarGridProps {
  sessions: Session[];
  /**
   * Books the session, and rejects if it could not.
   *
   * The rejection is load-bearing, not incidental: handleConfirmBooking marks
   * the slot booked before awaiting this and unwinds that mark on a throw. The
   * old `=> void` signature let a handler that swallowed its own failures
   * typecheck cleanly while silently disabling that unwind, which is exactly
   * the bug this shape exists to stop.
   */
  onBookSession: (sessionId: string) => void | Promise<void>;
  bookingLoading: string | null;
  hideLegend?: boolean; // Allow parent to render legend elsewhere
}

// Export legend items for use in parent component
export const CALENDAR_LEGEND_ITEMS = [
  { className: 'legend-available', label: 'Available', labelClass: 'legend-label-available' },
  { className: 'legend-conflict', label: 'Conflict', labelClass: 'legend-label-conflict' },
  { className: 'legend-full', label: 'Full', labelClass: 'legend-label-full' },
  { className: 'legend-booked', label: 'Booked', labelClass: 'legend-label-booked' },
  { className: 'legend-past', label: 'Past', labelClass: 'legend-label-past' }
];

/**
 * Most columns the grid will draw at once - one full Monday-to-Sunday week.
 *
 * Weekend days are only given a column when they carry a session, so an
 * ordinary working week still draws five. Seven is the ceiling rather than the
 * norm, and it is a ceiling rather than "however many days the sessions span"
 * because that span is unbounded.
 */
const MAX_VISIBLE_DAYS = 7;

/**
 * Narrowest a day column is allowed to get before the grid stops shrinking and
 * starts overflowing.
 *
 * Measured, not guessed: the widest slot label is a session crossing noon, so
 * both meridiems are shown ("11:30 AM - 12:30 PM"), which renders at 112.5px in
 * the 11px/600 stack `.calendar-slot .timeslot-label` sets.
 *
 * The slot is inset 6px each side AND carries a 1px border on every variant
 * (_components.css), and it is `box-sizing: border-box` - so the real inset is
 * 14px, not 12. 126px left the content box at 112px, a hair UNDER the label it
 * was measured against; 128px is the measurement it claims to be.
 *
 * `.calendar-slot` is `overflow: hidden`, so going under this does not show the
 * text overflowing - it CLIPS it, which is worse, because a truncated time
 * reads as a real time.
 */
const DAY_COLUMN_MIN_WIDTH_PX = 128;

/** Gutter between day columns, and the tighter one used once the week is full. */
const DAY_COLUMN_GAP_PX = 24;
const DENSE_DAY_COLUMN_GAP_PX = 12;

/**
 * Gutter and floor for a grid of `dayCount` columns.
 *
 * Six or seven columns only happen now that a weekend day can earn one, and at
 * 24px apiece the gutters alone would take 144px of a panel that has about
 * 1100px to give - enough to push a seven-column week past the edge of the
 * card. The columns are what carry information, so the gutters give way first.
 *
 * The floor counts the gutters as well as the columns. The old one did not,
 * which left it claiming a minimum ~144px narrower than the content it was
 * meant to be protecting.
 */
const dayGridMetrics = (dayCount: number): { gap: number; minWidth: number } => {
  const gap = dayCount >= 6 ? DENSE_DAY_COLUMN_GAP_PX : DAY_COLUMN_GAP_PX;
  return {
    gap,
    minWidth: dayCount * DAY_COLUMN_MIN_WIDTH_PX + Math.max(0, dayCount - 1) * gap,
  };
};

// ============================================================
// LEVEL 4: "LIVING INTERFACE" CALENDAR GRID
// Features: Staggered entry, spring physics, cursor spotlight,
// current time indicator, glassmorphic headers
// ============================================================

// ============================================================
// BUG FIX HISTORY - GARBLED TEXT IN CALENDAR SLOTS (Dec 2024)
// ============================================================
// SYMPTOM: Calendar slot text appeared garbled/overlapping, showing
//          scrambled characters like "9:00 3:002. 001:0845. 4" instead
//          of clean time labels like "10:00 - 10:45 AM".
//
// ROOT CAUSE: The grid container div (around line 765) was missing
//             `width: '100%'` in its inline styles. This caused:
//             1. Grid columns to not expand properly within the flex parent
//             2. All session slots collapsed into a narrow vertical space
//             3. Multiple text elements overlapping, creating garbled appearance
//
// THE FIX (two parts):
//   1. Added `width: '100%'` to the Day Columns Grid div's inline styles
//      This ensures the CSS grid expands to fill the available space
//      within the .calendar-days-container (which has display: flex from CSS)
//
//   2. Updated slot styles to use explicit width: 'calc(100% - 12px)'
//      with proper left/right margins, boxSizing, and flexbox centering
//
// KEY INSIGHT: The parent .calendar-days-container has `display: flex`
//              from CSS (_components.css line ~11816). The grid child needs
//              explicit width to expand properly within a flex container.
//              The header row worked because it had `flex: 1` on its grid div.
//
// IF THIS ISSUE RECURS, check:
//   1. The grid div has `width: '100%'` in inline styles
//   2. Slot positioning uses absolute + left/right/width properly
//   3. No CSS rules overriding inline grid/width styles
// ============================================================

const CalendarGrid: React.FC<CalendarGridProps> = memo(({ sessions, onBookSession, bookingLoading, hideLegend = false }) => {
  const _navigate = useNavigate();
  const [confirmingSlot, setConfirmingSlot] = useState<string | null>(null);
  const [bookedSlots, setBookedSlots] = useState<Set<string>>(new Set());
  const [userCalendarEvents, setUserCalendarEvents] = useState<CalendarEvent[]>([]);
  const [_calendarConnected, setCalendarConnected] = useState(false);
  const [_loadingCalendar, setLoadingCalendar] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());

  /**
   * How many pages of session days the participant has stepped forward (or
   * back) from the default window computed below. Zero is "wherever the
   * default window lands" - see `anchorIndex`.
   *
   * Bug #112: this control did not exist at all, on any page. The grid drew
   * a single static window with no way to move it, so a participant whose
   * bookable days had been pushed out of that window - see the comment on
   * `daysWithSessions` below - had no route back to a bookable day.
   */
  const [navPage, setNavPage] = useState(0);

  /**
   * Resets paging whenever `sessions` changes identity - a refetch (new
   * bookings, a slot added or removed) recomputes `daysWithSessions` from
   * scratch, and a `navPage` left over from the previous data set can point
   * at a page that no longer exists, or a page that exists but is no longer
   * the one the participant was looking at. Landing back on the default
   * (bookable-anchored) window is the safe, always-valid state to return to.
   */
  useEffect(() => {
    setNavPage(0);
  }, [sessions]);

  // Cursor spotlight state - scoped to grid area only
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [_isMouseInGrid, setIsMouseInGrid] = useState(false);
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  // Smooth spring-based cursor tracking
  const smoothMouseX = useSpring(mouseX, { stiffness: 300, damping: 30 });
  const smoothMouseY = useSpring(mouseY, { stiffness: 300, damping: 30 });

  // Transform for spotlight position (hooks must be called unconditionally)
  const _spotlightX = useTransform(smoothMouseX, x => x - 200);
  const _spotlightY = useTransform(smoothMouseY, y => y - 200);
  
  // Update current time every minute for the time indicator
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000); // Update every minute
    
    return () => clearInterval(timer);
  }, []);
  
  // Track mouse position for cursor spotlight - only within grid area
  const handleGridMouseMove = useCallback((e: React.MouseEvent) => {
    if (gridContainerRef.current) {
      const rect = gridContainerRef.current.getBoundingClientRect();
      mouseX.set(e.clientX - rect.left);
      mouseY.set(e.clientY - rect.top);
    }
  }, [mouseX, mouseY]);
  
  const handleGridMouseEnter = useCallback(() => {
    setIsMouseInGrid(true);
  }, []);
  
  const handleGridMouseLeave = useCallback(() => {
    setIsMouseInGrid(false);
  }, []);
  
  // Load user bookings and populate bookedSlots when sessions change
  useEffect(() => {
    const loadUserBookings = async () => {
      if (!sessions || sessions.length === 0) {
        setBookedSlots(new Set());
        return;
      }

      try {
        const bookings = await getMyBookings();
        const allBookings = [...bookings.upcoming, ...bookings.past];
        const sessionIds = new Set(sessions.map(s => s.id));
        
        const bookedSessionIds = allBookings
          .filter(booking => booking.status === 'booked' && sessionIds.has(booking.session_id))
          .map(booking => booking.session_id);
        
        setBookedSlots(new Set(bookedSessionIds));
      } catch (error) {
        logger.error('Error loading user bookings', {
          error: error instanceof Error ? error : undefined,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        setBookedSlots(new Set());
      }
    };

    loadUserBookings();
  }, [sessions]);

  // Auto-detect calendar connection and fetch events when component mounts
  useEffect(() => {
    const checkAndFetchCalendar = async () => {
      if (!sessions || sessions.length === 0) return;

      try {
        setLoadingCalendar(true);
        
        try {
          const status = await getCalendarConnectionStatus();
          setCalendarConnected(status.connected);
        } catch (error: unknown) {
          // Not surfaced: "we could not ask" and "not connected" look the same
          // to a participant, and both correctly mean no conflict overlay. They
          // are NOT the same to anyone diagnosing it, which is why the cause is
          // logged rather than discarded.
          //
          // A 401 is excluded because it is not a fault: /opportunities/:id is
          // reachable from the shareable participant link while
          // /calendar/connection-status is requireAuth, so every logged-out
          // visitor produces one on their way to the login redirect. Logging an
          // expected condition at WARN is how a warning stops meaning anything.
          const status = (error as { response?: { status?: number } })?.response?.status;
          if (status !== 401) {
            logger.warn('Could not read calendar connection status', {
              component: 'CalendarGrid',
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          }
          setCalendarConnected(false);
        }

        const dates = sessions
          .map(s => new Date(s.start_time))
          .sort((a, b) => a.getTime() - b.getTime());
        
        if (dates.length === 0) return;

        const startTime = new Date(dates[0]);
        startTime.setHours(0, 0, 0, 0);
        
        const endTime = new Date(dates[dates.length - 1]);
        endTime.setHours(23, 59, 59, 999);

        const events = await getMyCalendarEvents(
          startTime.toISOString(),
          endTime.toISOString()
        );
        
        setUserCalendarEvents(events);
      } catch (error: unknown) {
        const axiosError = error as { response?: { status?: number } };
        if (axiosError.response?.status === 404) {
          setCalendarConnected(false);
        } else {
          setCalendarConnected(false);
        }
      } finally {
        setLoadingCalendar(false);
      }
    };

    checkAndFetchCalendar();
  }, [sessions]);

  // Return the participant's own calendar event this session clashes with, or
  // null. BK-2: the slot tooltip names the clash, so it needs the matched
  // event, not just a yes/no; callers wanting the yes/no read its truthiness.
  const getCalendarConflict = useCallback((session: Session): CalendarEvent | null => {
    if (userCalendarEvents.length === 0) {
      return null;
    }

    const sessionStart = new Date(session.start_time);
    const sessionEnd = new Date(session.end_time);

    return userCalendarEvents.find(event => {
      if (event.status === 'cancelled' || event.status === 'declined') {
        return false;
      }

      const eventStart = new Date(event.start);
      const eventEnd = new Date(event.end);

      if (isNaN(eventStart.getTime()) || isNaN(eventEnd.getTime())) {
        return false;
      }

      const overlaps = (sessionStart < eventEnd && sessionEnd > eventStart);
      return overlaps;
    }) ?? null;
  }, [userCalendarEvents]);

  // Format time for display (condensed format) — **local** wall clock (matches grid axis 7am–11pm)
  const formatTime = (dateString: string, includeAmPm: boolean = true) => {
    const date = new Date(dateString);
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const isPM = hours >= 12;
    const displayHour = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    const minuteStr = minutes.toString().padStart(2, '0');
    
    if (includeAmPm) {
      return `${displayHour}:${minuteStr} ${isPM ? 'PM' : 'AM'}`;
    }
    return `${displayHour}:${minuteStr}`;
  };

  // Format time range - drops first AM/PM if both are the same
  const formatTimeRange = (startTime: string, endTime: string) => {
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    const startIsPM = startDate.getHours() >= 12;
    const endIsPM = endDate.getHours() >= 12;
    
    // If both are AM or both are PM, drop the first suffix
    if (startIsPM === endIsPM) {
      return `${formatTime(startTime, false)} - ${formatTime(endTime, true)}`;
    }
    // Different periods, show both
    return `${formatTime(startTime, true)} - ${formatTime(endTime, true)}`;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  };

  /**
   * Local wall-clock time as decimal hours (e.g. 13.5 = 1:30 PM).
   * Must match the left axis (7–23), which uses local time, and `getCurrentTimePosition` (local).
   * Using UTC here previously shifted slots vs grid lines and made durations look wrong.
   */
  const getHourFromSlot = (timeString: string): number => {
    const date = new Date(timeString);
    return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  };

  // Helper function to calculate position percentage (7am = 0%, 11pm = 100%)
  const getTimePosition = (hour: number): number => {
    const startHour = 7;
    const endHour = 23;
    const totalHours = endHour - startHour;
    const adjustedHour = hour - startHour;
    return Math.max(0, Math.min(100, (adjustedHour / totalHours) * 100));
  };

  // Generate time markers for left column (7am to 11pm)
  const generateTimeMarkers = (): Array<{ time: number; isHour: boolean }> => {
    const markers: Array<{ time: number; isHour: boolean }> = [];
    for (let hour = 7; hour <= 23; hour++) {
      markers.push({ time: hour, isHour: true });
      if (hour < 23) {
        markers.push({ time: hour + 0.5, isHour: false });
      }
    }
    return markers;
  };

  // Format time label for display
  const formatTimeLabel = (time: number): string => {
    const hour = Math.floor(time);
    const decimal = time % 1;
    let minutes = 0;
    if (decimal === 0.5) minutes = 30;
    
    const isPM = hour >= 12;
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const ampm = isPM ? 'PM' : 'AM';
    return `${displayHour}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  };

  // Group sessions by date and generate all days in the date range
  // Memoised on `sessions`, which is the only reactive value it reads, so the
  // useMemo below can depend on it by identity. The dependency was correct
  // already - the rule simply cannot see through a plain function call.
  const groupSessionsByDate = useCallback(() => {
    if (sessions.length === 0) {
      return [];
    }

    const dates = sessions
      .map(s => new Date(s.start_time))
      .sort((a, b) => a.getTime() - b.getTime());
    
    const startDate = new Date(dates[0]);
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(dates[dates.length - 1]);
    endDate.setHours(23, 59, 59, 999);

    const sessionsByDateMap = new Map<string, Session[]>();
    
    sessions.forEach(session => {
      const date = new Date(session.start_time);
      date.setHours(0, 0, 0, 0);
      const dateKey = date.toDateString();
      
      if (!sessionsByDateMap.has(dateKey)) {
        sessionsByDateMap.set(dateKey, []);
      }
      sessionsByDateMap.get(dateKey)!.push(session);
    });

    sessionsByDateMap.forEach((sessions, _date) => {
      sessions.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    });

    const allDays: Array<[string, Session[]]> = [];
    const currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      const dayOfWeek = currentDate.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const dateKey = currentDate.toDateString();
      const dateSessions = sessionsByDateMap.get(dateKey) || [];

      // Weekdays are always given a column, so a run of days reads as a
      // continuous week even where a day happens to be empty. A weekend day
      // earns a column only by having a session in it - nothing stops an admin
      // scheduling one, and dropping it here is silent data loss, but padding
      // every ordinary Monday-to-Friday grid with two blank columns would cost
      // a third of the width to show nothing.
      if (!isWeekend || dateSessions.length > 0) {
        allDays.push([dateKey, dateSessions]);
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    return allDays;
  }, [sessions]);

  const sessionsByDate = useMemo(() => groupSessionsByDate(), [groupSessionsByDate]);

  /**
   * The window of days the grid actually draws.
   *
   * A bound is needed - `sessionsByDate` spans first session to last, which for
   * an opportunity running over a couple of months is dozens of columns - but
   * it has to be wide enough for a full Monday-to-Sunday week now that weekend
   * days can earn a column. At the old bound of five, a Saturday session in a
   * week that also had weekday sessions was sliced off the end, which is the
   * same defect as the Monday-to-Friday filter wearing a different hat.
   */
  /** Every day in `sessionsByDate` that actually carries a session, in date order. */
  const daysWithSessions = useMemo(
    () => sessionsByDate.filter(([, daySessions]) => daySessions.length > 0),
    [sessionsByDate]
  );

  /**
   * Where the current page starts within `daysWithSessions`.
   *
   * Bug #112: an opportunity carrying more than MAX_VISIBLE_DAYS distinct
   * session days used to have its whole truncation budget spent on the
   * CHRONOLOGICALLY EARLIEST of them, with no regard for whether those had
   * already passed. A study that had been open for several weeks - old
   * sessions still in the data, new ones added on top - could fill all seven
   * slots with past days and push this week, and everything after it, out of
   * the window entirely. That is the reported defect exactly: a participant
   * shown last week's (unbookable) availability with nothing on screen able
   * to reach a bookable day.
   *
   * The fix is the default page: it starts at the earliest day that has not
   * yet ended, not the earliest day full stop, whenever such a day exists.
   * `navPage` then steps a full window's worth forward or back from there,
   * so "next" and "previous" always mean "relative to a page that opened on
   * a bookable day", not "relative to the true beginning of the opportunity".
   *
   * Deliberately NOT gated on the truncation branch below - it is cheap to
   * compute unconditionally, and doing so once here rather than duplicating
   * the "which day is today" check in two places is the whole point of
   * pulling it out.
   */
  const anchorIndex = useMemo(() => {
    if (daysWithSessions.length === 0) return 0;

    // Nothing to skip forward past: every day with a session already fits in
    // one page, so paging further would only produce an empty page. This
    // mirrors the untruncated early-return below for `visibleDays` and keeps
    // `navPage` a no-op until there is genuinely more than one page.
    if (daysWithSessions.length <= MAX_VISIBLE_DAYS) return 0;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const firstUpcoming = daysWithSessions.findIndex(([dateKey]) => new Date(dateKey) >= today);
    // No day left to book at all - an opportunity that has fully lapsed has
    // nothing better to default to, so this falls back to the true earliest
    // day rather than an anchor that would show nothing.
    const defaultAnchor = firstUpcoming === -1 ? 0 : firstUpcoming;

    const paged = defaultAnchor + navPage * MAX_VISIBLE_DAYS;
    return Math.min(Math.max(paged, 0), daysWithSessions.length - 1);
  }, [daysWithSessions, navPage]);

  /** Whether there is an earlier or a later page than the one on screen. */
  const canGoToPreviousPage = anchorIndex > 0;
  const canGoToNextPage = anchorIndex + MAX_VISIBLE_DAYS < daysWithSessions.length;
  /** The navigation control only makes sense once there is more than one page to move between. */
  const showWeekNav = daysWithSessions.length > MAX_VISIBLE_DAYS;

  const visibleDays = useMemo(() => {
    if (sessionsByDate.length <= MAX_VISIBLE_DAYS) {
      return sessionsByDate;
    }

    // Over budget, so something has to go - and it must not be a day someone
    // can book.
    //
    // Taking the first seven CHRONOLOGICAL days reproduced the very defect this
    // component was being fixed for. A fortnightly Saturday opportunity spans
    // Sat 12 to Sat 26; the days between are weekdays, which always earn a
    // column whether or not they hold anything, so the window filled with six
    // empty weekdays and truncated the second bookable Saturday. Sessions
    // invisible to the participant, with the budget spent on days that carry
    // nothing.
    //
    // Days that HAVE sessions are therefore taken first, starting from
    // `anchorIndex` rather than always from the beginning - see the comment
    // there for why. If even a single page of those overflows the budget the
    // earliest of THAT page win, and the notice below reports the rest.
    const kept = new Set(
      daysWithSessions
        .slice(anchorIndex, anchorIndex + MAX_VISIBLE_DAYS)
        .map(([dateKey]) => dateKey)
    );

    // Anything left over is spent on the empty days between and after them, so
    // a run of days still reads as a week rather than as a row of disconnected
    // dates.
    //
    // Bug #112 (backfill): this walk starts at the anchored window's OWN first
    // day, not at the beginning of `sessionsByDate`. Starting from the global
    // beginning pulled in whichever empty days were chronologically earliest
    // full stop - for an anchor sitting weeks into the opportunity, that meant
    // empty days from BEFORE the anchor, reintroducing "showing last week" as
    // clutter beside the anchored days rather than as the whole window. Empty
    // fill must only ever be contiguous with, and after, the anchored bookable
    // days.
    const anchorDateKey = daysWithSessions[anchorIndex]?.[0];
    const anchorStartIndex = anchorDateKey
      ? sessionsByDate.findIndex(([dateKey]) => dateKey === anchorDateKey)
      : 0;
    for (let i = Math.max(anchorStartIndex, 0); i < sessionsByDate.length; i++) {
      if (kept.size >= MAX_VISIBLE_DAYS) break;
      const [dateKey, daySessions] = sessionsByDate[i];
      if (daySessions.length === 0) kept.add(dateKey);
    }

    // Filtered rather than assembled, so the result stays in date order
    // whichever order the two passes above added things in.
    return sessionsByDate.filter(([dateKey]) => kept.has(dateKey));
  }, [sessionsByDate, daysWithSessions, anchorIndex]);

  /**
   * What the window could not fit. Announced below the grid rather than simply
   * dropped: a participant who is shown a calendar has no way of telling a week
   * with nothing in it from a week that was truncated away.
   */
  const omittedDays = useMemo(() => {
    const visible = new Set(visibleDays.map(([dateKey]) => dateKey));
    // Derived from what is actually drawn rather than from a second slice of
    // the same bound - two independent expressions of "which days did not fit"
    // are free to disagree, and the notice is the only thing standing between a
    // truncated session and silence.
    return sessionsByDate.filter(([dateKey]) => !visible.has(dateKey));
  }, [sessionsByDate, visibleDays]);
  const omittedDaysWithSessions = useMemo(
    () => omittedDays.filter(([, daySessions]) => daySessions.length > 0).length,
    [omittedDays]
  );

  /** Shared by the sticky header row and the columns, so the two cannot drift. */
  const dayGrid = useMemo(() => dayGridMetrics(visibleDays.length), [visibleDays.length]);

  /**
   * Row 6 (second-pass review): on a phone the grid never shows more than a
   * sliver of one day column, and the only way to see the rest was a native
   * horizontal scrollbar the width of a hairline - or an accidental swipe.
   * That is distinct from `showWeekNav` above, which pages a whole
   * MAX_VISIBLE_DAYS-wide window and only appears once a study has more
   * bookable days than fit in one window; an ordinary one-week study never
   * triggers it and had no phone affordance at all. This is a plain
   * one-column-at-a-time pager, visible only where a column truly cannot
   * share the viewport with its neighbour.
   */
  const timelineRef = useRef<HTMLDivElement>(null);
  const [isNarrowViewport, setIsNarrowViewport] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 480
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 480px)');
    const handleChange = (e: MediaQueryListEvent) => setIsNarrowViewport(e.matches);
    setIsNarrowViewport(mq.matches);
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, []);

  // ponytail: only the Previous/Next buttons write this - a swipe on the
  // still-swipeable scroller below leaves it stale, and the pager renders on
  // viewport width alone rather than on whether the grid actually overflows.
  //   -> cto/AdaptaLabs#130, breaks once a real gesture or a wide-enough
  //      narrow viewport is what a real device sends.
  const [focusedDayIndex, setFocusedDayIndex] = useState(0);
  // A new set of visible days (a refetch, a week-nav page change) can leave a
  // stale index pointing past the end, or at a day that is no longer the one
  // being looked at - land back on the first column, same as `navPage` above.
  useEffect(() => {
    setFocusedDayIndex(0);
  }, [visibleDays]);
  // Clamped at RENDER time, not only by the effect above: for the one frame
  // between `visibleDays` shrinking and that effect running, `focusedDayIndex`
  // can point past the new end, and `formatDate(undefined)` would print
  // "Invalid Date" in the pager label for that frame.
  const displayedDayIndex = Math.min(focusedDayIndex, Math.max(0, visibleDays.length - 1));

  const canGoToPreviousDay = displayedDayIndex > 0;
  const canGoToNextDay = displayedDayIndex < visibleDays.length - 1;
  const goToDay = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, visibleDays.length - 1));
    setFocusedDayIndex(clamped);
    timelineRef.current?.scrollTo({
      left: clamped * (DAY_COLUMN_MIN_WIDTH_PX + dayGrid.gap),
      behavior: 'smooth',
    });
  }, [visibleDays.length, dayGrid.gap]);

  /**
   * Whether `.calendar-timeline` needs to become its own horizontal scroll
   * container (see the CSS comment above `.calendar-timeline--scrolls`).
   *
   * This CANNOT be a bare `overflow-x: auto` on `.calendar-timeline` at every
   * width: `position: sticky` (the desktop header row) computes against the
   * nearest scroll container rather than the viewport, so giving the timeline
   * an overflow rule unconditionally silently broke the sticky day-header on
   * every desktop width the moment it was added - not only the ones that
   * actually needed to scroll. A real measurement keeps a comfortably-fitting
   * calendar exactly as it was; only one that genuinely cannot fit gives up
   * the sticky header for the same scroll-contained treatment phone already
   * has.
   *
   * Phone is decided by `matchMedia` alone (matching the previously-shipped,
   * already-tested behaviour exactly, with no dependency on ResizeObserver
   * existing) rather than by measurement, so a real phone can never fail to
   * get this treatment even if the observer below never fires.
   */
  const [needsScrollContainment, setNeedsScrollContainment] = useState(
    () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 768px)');
    // Only turns it ON here; a resize back to desktop-width defers to the
    // measurement effect below rather than assuming "wide enough" on its own.
    const handleChange = (e: MediaQueryListEvent) => {
      if (e.matches) setNeedsScrollContainment(true);
    };
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Time column (90px) plus its fixed 24px gap to the day grid - the same
    // arithmetic `--cal-content-w` uses, so this measurement and that CSS
    // variable can never disagree about what "fits" means.
    const requiredWidth = dayGrid.minWidth + 90 + 24;
    const measure = () => {
      const isPhone = window.matchMedia?.('(max-width: 768px)').matches ?? false;
      setNeedsScrollContainment(isPhone || el.clientWidth < requiredWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [dayGrid.minWidth]);

  const timeMarkers = useMemo(() => generateTimeMarkers(), []);
  /** Timeline column height — slots use top/height as % of .calendar-timeline-container (same reference as grid lines). */
  const TIMELINE_HEIGHT_PX = 900;
  const timelineHeight = `${TIMELINE_HEIGHT_PX}px`;

  // Calculate current time position for the "Now" indicator
  const getCurrentTimePosition = useMemo(() => {
    const now = currentTime;
    const currentHour = now.getHours() + now.getMinutes() / 60;
    return getTimePosition(currentHour);
  }, [currentTime]);

  // Check if today is in the visible date range
  const todayColumnIndex = useMemo(() => {
    // Derived from the ticking `currentTime` rather than a fresh `new Date()`.
    // The dependency was already listed and was NOT redundant - it is what moves
    // the highlighted column when the clock crosses midnight with the page open -
    // but reading the clock independently inside the body made it look that way
    // to the linter, and left the two able to disagree by up to a minute.
    //
    // Not strictly behaviour-preserving, and worth naming: this now reads a
    // clock that only refreshes on the 60s tick, so if sessionsByDate changes
    // just after midnight the highlighted column can lag by up to that tick.
    // The consistency with getCurrentTimePosition, which reads the same clock,
    // is worth more than the sub-minute precision.
    const today = new Date(currentTime);
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toDateString();

    // Searched over the days that are DRAWN, not every day in range. The index
    // is compared against a rendered column's index and it also gates the "Now"
    // indicator, so a hit on a day outside the window used to mean either the
    // wrong column carrying the Today badge or - worse - the red line drawn
    // across a grid in which today is not a column at all.
    return visibleDays.findIndex(([date]) => {
      const sessionDate = new Date(date);
      sessionDate.setHours(0, 0, 0, 0);
      return sessionDate.toDateString() === todayStr;
    });
  }, [visibleDays, currentTime]);

  const handleSlotClick = (session: Session, slotElement: HTMLElement) => {
    const isBooked = bookedSlots.has(session.id);
    const hasConflict = !!getCalendarConflict(session);
    const isAvailable = session.remaining > 0 && new Date(session.end_time) >= new Date();
    
    if (!isBooked && !hasConflict && isAvailable && !bookingLoading) {
      checkPopoverPosition(slotElement);
      setConfirmingSlot(session.id);
    }
  };

  const handleConfirmBooking = async (sessionId: string) => {
    try {
      setBookedSlots(prev => new Set([...prev, sessionId]));
      await onBookSession(sessionId);
      setConfirmingSlot(null);
    } catch {
      // No binding, and nothing logged or shown here on purpose: the owner of
      // onBookSession displays the message and logs the cause before rethrowing.
      // All this path owes is unwinding the optimistic mark applied above, so
      // the slot goes back to being clickable rather than sitting there looking
      // booked - handleSlotClick refuses a slot it believes is booked.
      //
      // Until that rethrow existed this catch never ran for a failed booking at
      // all, because the caller resolved normally after handling the error.
      setBookedSlots(prev => {
        const newSet = new Set(prev);
        newSet.delete(sessionId);
        return newSet;
      });
      setConfirmingSlot(null);
    }
  };

  const handleCancelBooking = () => {
    setConfirmingSlot(null);
  };

  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverFlipped, setPopoverFlipped] = useState(false);
  
  // Check if popover should flip to below when slot is near top of viewport
  const checkPopoverPosition = useCallback((slotElement: HTMLElement | null) => {
    if (!slotElement) {
      setPopoverFlipped(false);
      return;
    }
    const rect = slotElement.getBoundingClientRect();
    // Popover is ~150px tall, plus 12px gap. Flip if there's not enough space above.
    // Also account for header height (~70px)
    const minSpaceAbove = 180;
    setPopoverFlipped(rect.top < minSpaceAbove);
  }, []);

  useEffect(() => {
    if (!confirmingSlot) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setConfirmingSlot(null);
      }
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [confirmingSlot]);

  // ============================================================
  // FRAMER MOTION ANIMATION VARIANTS
  // ============================================================
  
  // Staggered column entry animation
  const columnVariants = {
    hidden: { 
      opacity: 0, 
      y: 30,
      scale: 0.95
    },
    visible: (i: number) => ({
      opacity: 1,
      y: 0,
      scale: 1,
      transition: {
        delay: i * 0.1,
        duration: 0.5,
        ease: [0.25, 0.46, 0.45, 0.94] as const, // Custom easing for smooth feel
      }
    })
  };

  // Tactile slot interaction variants (no scale to prevent text artifacts)
  const _slotVariants = {
    idle: { 
      boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
    },
    hover: { 
      boxShadow: '0 8px 25px rgba(0,0,0,0.12)',
      transition: {
        type: 'spring' as const,
        stiffness: 400,
        damping: 20
      }
    },
    tap: { 
      opacity: 0.9,
      transition: {
        type: 'spring' as const,
        stiffness: 600,
        damping: 25
      }
    }
  };

  // Legend item animation
  const legendItemVariants = {
    hidden: { opacity: 0, x: -10 },
    visible: (i: number) => ({
      opacity: 1,
      x: 0,
      transition: {
        delay: 0.5 + i * 0.08,
        duration: 0.3
      }
    })
  };

  if (sessions.length === 0) {
    return (
      <motion.div 
        className="alert alert-info"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <Info size={18} className="me-2" />
        No sessions available
      </motion.div>
    );
  }

  if (sessionsByDate.length === 0) {
    return (
      <motion.div 
        className="alert alert-info d-flex align-items-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <Info size={18} className="me-2" />
        No sessions available
      </motion.div>
    );
  }

  // Use exported legend items
  const legendItems = CALENDAR_LEGEND_ITEMS;

  // BK-4: the grid draws every time in the reader's OWN zone (formatTime uses
  // getHours()), and it said so nowhere — the table view labels each row, but a
  // bare grid time is how a participant once booked "an hour out". Name the zone
  // once, but only with an offset the whole view actually shares: on a week that
  // straddles a daylight-saving change the rows carry two offsets, so we print
  // the prose alone rather than stamp a wrong "(GMT-4)" over a GMT-5 row.
  const zoneOffset = sharedZoneOffset(sessions.map((s) => s.start_time));

  return (
    <div
      className="calendar-view calendar-living-interface calendar-hud"
      style={{
        position: 'relative',
        // True width of the scrolled calendar content = time gutter (90) + its
        // gap (24) + the day-grid floor. On phone both the header row and the
        // content row are pinned to this one width so their independent grids
        // resolve to identical column widths and stay aligned while scrolling
        // (audit #114). Without a shared definite width, max-content sizes the
        // text-filled header grid wider than the empty body grid and they drift.
        ['--cal-content-w' as string]: `${dayGrid.minWidth + 90 + 24}px`,
      }}
    >
      {/* Ambient Glow Background - Dark Mode Only (via CSS) */}
      <div className="calendar-ambient-glow" aria-hidden="true" />
      <div className="calendar-ambient-glow-secondary" aria-hidden="true" />
      
      {/* Color-coded legend with staggered animation - conditionally rendered */}
      {!hideLegend && (
        <div className="calendar-legend d-flex flex-wrap gap-4 mb-4">
          {legendItems.map((item, index) => (
            <motion.div 
              key={item.label}
              className="d-flex align-items-center gap-2"
              custom={index}
              initial="hidden"
              animate="visible"
              variants={legendItemVariants}
            >
              <div className={`legend-swatch ${item.className}`}></div>
              <small className={`legend-label ${item.labelClass}`}>{item.label}</small>
            </motion.div>
          ))}
        </div>
      )}

      {/* Zone caption — rendered whether or not the legend is (BK-4). The offset
          is appended only when the whole view shares one (see sharedZoneOffset). */}
      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0 0 12px' }}>
        Times shown in your time zone{zoneOffset ? ` (${zoneOffset})` : ''}
      </p>

      {/*
        Week navigation (#112). Only rendered once there is more than one
        page of session days to move between - see `showWeekNav` - so an
        opportunity short enough to fit in one screen, which is most of
        them, is unchanged by this control's existence.
      */}
      {showWeekNav && (
        <div
          className="calendar-week-nav d-flex justify-content-between align-items-center mb-3"
          role="group"
          aria-label="Session days navigation"
        >
          <button
            type="button"
            onClick={() => setNavPage(page => page - 1)}
            disabled={!canGoToPreviousPage}
            aria-label="Show earlier session days"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              fontSize: '0.8rem',
              fontWeight: 500,
              border: '1px solid var(--border-card)',
              borderRadius: '4px',
              backgroundColor: 'transparent',
              color: 'var(--text-muted)',
              cursor: canGoToPreviousPage ? 'pointer' : 'not-allowed',
              opacity: canGoToPreviousPage ? 1 : 0.5,
            }}
          >
            <ChevronLeft size={14} aria-hidden="true" />
            Previous
          </button>
          <button
            type="button"
            onClick={() => setNavPage(page => page + 1)}
            disabled={!canGoToNextPage}
            aria-label="Show later session days"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              fontSize: '0.8rem',
              fontWeight: 500,
              border: '1px solid var(--border-card)',
              borderRadius: '4px',
              backgroundColor: 'transparent',
              color: 'var(--text-muted)',
              cursor: canGoToNextPage ? 'pointer' : 'not-allowed',
              opacity: canGoToNextPage ? 1 : 0.5,
            }}
          >
            Next
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Day pager (row 6, second-pass review). Phone-only: at that width the
          grid shows one column at a time and the horizontal scrollbar is the
          only other way to move, which is easy to miss entirely. Distinct
          from the week nav above - this steps one COLUMN, not one WINDOW, and
          exists even for a plain one-week study that never triggers that. */}
      {isNarrowViewport && visibleDays.length > 1 && (
        <div
          className="calendar-day-pager d-flex justify-content-between align-items-center mb-3"
          role="group"
          aria-label="Calendar day navigation"
        >
          <button
            type="button"
            onClick={() => goToDay(displayedDayIndex - 1)}
            disabled={!canGoToPreviousDay}
            aria-label="Previous day"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              flexShrink: 0,
              whiteSpace: 'nowrap',
              gap: '4px',
              padding: '4px 8px',
              fontSize: '0.75rem',
              fontWeight: 500,
              border: '1px solid var(--border-card)',
              borderRadius: '4px',
              backgroundColor: 'transparent',
              color: 'var(--text-muted)',
              cursor: canGoToPreviousDay ? 'pointer' : 'not-allowed',
              opacity: canGoToPreviousDay ? 1 : 0.5,
            }}
          >
            <ChevronLeft size={14} aria-hidden="true" />
            Previous day
          </button>
          <span aria-live="polite" style={{
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            fontWeight: 500,
            flex: '1 1 auto',
            minWidth: 0,
            textAlign: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            padding: '0 4px',
          }}>
            {formatDate(visibleDays[displayedDayIndex]?.[0])} · {displayedDayIndex + 1} of {visibleDays.length}
          </span>
          <button
            type="button"
            onClick={() => goToDay(displayedDayIndex + 1)}
            disabled={!canGoToNextDay}
            aria-label="Next day"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              flexShrink: 0,
              whiteSpace: 'nowrap',
              gap: '4px',
              padding: '4px 8px',
              fontSize: '0.75rem',
              fontWeight: 500,
              border: '1px solid var(--border-card)',
              borderRadius: '4px',
              backgroundColor: 'transparent',
              color: 'var(--text-muted)',
              cursor: canGoToNextDay ? 'pointer' : 'not-allowed',
              opacity: canGoToNextDay ? 1 : 0.5,
            }}
          >
            Next day
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Calendar Timeline - Page scroll with viewport-sticky headers, UNLESS
          `needsScrollContainment` says the grid does not fit - see the state
          comment above and the `.calendar-timeline--scrolls` CSS comment for
          why this has to be measured rather than a bare media query or an
          unconditional rule (audit #114, row 6). The overflow itself is left
          to CSS rather than pinned inline here, because an inline `overflow`
          would win over the class. */}
      <div
        ref={timelineRef}
        className={`calendar-timeline${needsScrollContainment ? ' calendar-timeline--scrolls' : ''}`}
        style={{ position: 'relative' }}
        // On phone this is a horizontal scroll container (audit #114); a
        // scrollable region must be keyboard-reachable so it can be scrolled
        // with the arrow keys, and named so assistive tech announces it. Native
        // slots are non-focusable div[title]s, so without this axe flags
        // scrollable-region-focusable. Harmless on desktop, where it does not
        // scroll.
        tabIndex={0}
        role="group"
        aria-label="Session calendar"
      >
        {/* Viewport-Sticky Header Row. position/top/z-index come from the
            .calendar-sticky-header-row CSS class (sticky-top on desktop), NOT
            inline, so the phone media query can override it to position:static
            (audit #114) - an inline position would silently win and leave that
            override dead. */}
        <div className="calendar-sticky-header-row" style={{
          display: 'flex',
          gap: '24px',
          paddingTop: '8px',
          paddingBottom: '12px',
          marginBottom: '0'
        }}>
          {/* Empty space for time column alignment. Pins to the left on phone
              (calendar-header-time-spacer, see _components.css) so the day
              headers stay column-aligned with the sticky time gutter below when
              the grid is scrolled horizontally (audit #114). */}
          <div className="calendar-header-time-spacer" style={{ minWidth: '90px', width: '90px' }} />
          
          {/* Day Headers */}
          <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: `repeat(${visibleDays.length}, 1fr)`,
            // Same gutter and same floor as the day columns below. Without the
            // floor the header grid keeps compressing after the columns have
            // stopped, and the two slide out of alignment - a header sitting
            // over the wrong day.
            gap: `${dayGrid.gap}px`,
            minWidth: `${dayGrid.minWidth}px`
          }}>
            {visibleDays.map(([date, dateSessions], columnIndex) => {
              const isToday = columnIndex === todayColumnIndex;
              return (
                <motion.div
                  key={`header-${date}`}
                  className="calendar-day-header-cell"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: columnIndex * 0.05 }}
                  style={{
                    textAlign: 'center',
                    padding: '8px'
                  }}
                >
                  <div 
                    className="calendar-day-title mb-1" 
                    style={{ 
                      margin: 0,
                      marginBottom: '4px',
                      fontSize: 'var(--font-size-small, 0.875rem)',
                      fontWeight: 600,
                      color: isToday ? 'var(--color-emerald-500, #10b981)' : undefined
                    }}
                  >
                    {formatDate(date)}
                    {isToday && (
                      <motion.span
                        initial={{ opacity: 0, scale: 0 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.3 }}
                        style={{
                          marginLeft: '8px',
                          fontSize: '10px',
                          fontWeight: 700,
                          color: 'white',
                          backgroundColor: '#059669',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.5px'
                        }}
                      >
                        Today
                      </motion.span>
                    )}
                  </div>
                  <small className="calendar-day-sessions">
                    {dateSessions.length} session{dateSessions.length !== 1 ? 's' : ''}
                  </small>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Calendar Content. Width is class-driven (calendar-content-row): 100%
            on desktop, but max-content on phone so the sticky time gutter has
            the full scrolled width to pin across rather than being clamped to a
            viewport-width box that scrolls away with the grid (audit #114). */}
        <div className="calendar-content-row" style={{
          display: 'flex',
          gap: '24px'
        }}>
          {/* Time Column (Left) */}
          <motion.div 
            className="calendar-time-column" 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            style={{
              minWidth: '90px',
              width: '90px',
              position: 'sticky',
              left: 0,
              zIndex: 5
            }}
          >
            {/* Time Markers */}
            <div className="calendar-time-markers" style={{
              position: 'relative',
              height: timelineHeight
            }}>
              {timeMarkers.map((marker, index) => {
                if (!marker.isHour) return null;
                
                const position = getTimePosition(marker.time);
                
                return (
                  <div
                    key={`${marker.time}-${index}`}
                    className="calendar-time-label"
                    style={{
                      position: 'absolute',
                      top: `${position}%`,
                      left: 0,
                      right: 0,
                      pointerEvents: 'none',
                      backgroundColor: 'transparent'
                    }}
                  >
                    {formatTimeLabel(marker.time)}
                  </div>
                );
              })}
            </div>
          </motion.div>

          {/* Day Columns Container - Spotlight effect scoped here */}
          <div 
            ref={gridContainerRef}
            className="calendar-days-container" 
            onMouseMove={handleGridMouseMove}
            onMouseEnter={handleGridMouseEnter}
            onMouseLeave={handleGridMouseLeave}
            style={{ 
              position: 'relative',
              flex: 1,
              minWidth: `${dayGrid.minWidth}px`,
              overflow: 'hidden'
            }}
          >
            {/* Horizontal hour dividers - HUD style grid lines */}
            <div 
              className="calendar-grid-lines"
              style={{
                position: 'absolute',
                top: '0',
                left: 0,
                right: 0,
                height: timelineHeight,
                pointerEvents: 'none',
                zIndex: 1
              }}
            >
              {timeMarkers.map((marker, index) => {
                const position = getTimePosition(marker.time);
                const isHour = marker.isHour;
                return (
                  <div
                    key={`divider-${marker.time}-${index}`}
                    className={`calendar-grid-line ${isHour ? 'calendar-grid-line-hour' : 'calendar-grid-line-half'}`}
                    style={{
                      position: 'absolute',
                      top: `${position}%`,
                      left: 0,
                      right: 0
                    }}
                  />
                );
              })}
            </div>
            
            {/* Current Time Indicator - The "Red Line" */}
            {todayColumnIndex >= 0 && getCurrentTimePosition >= 0 && getCurrentTimePosition <= 100 && (
              <motion.div
                className="current-time-indicator"
                initial={{ opacity: 0, scaleX: 0 }}
                animate={{ opacity: 1, scaleX: 1 }}
                transition={{ duration: 0.6, delay: 0.8, ease: 'easeOut' }}
                style={{
                  position: 'absolute',
                  top: `${getCurrentTimePosition}%`,
                  left: 0,
                  right: 0,
                  zIndex: 10,
                  pointerEvents: 'none',
                  transformOrigin: 'left center'
                }}
              >
                {/* Live dot with pulse animation */}
                <motion.div
                  className="current-time-dot"
                  animate={{
                    scale: [1, 1.3, 1],
                    opacity: [1, 0.7, 1]
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity,
                    ease: 'easeInOut'
                  }}
                  style={{
                    position: 'absolute',
                    left: -6,
                    top: -4,
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    backgroundColor: '#ef4444',
                    boxShadow: '0 0 8px rgba(239, 68, 68, 0.6)'
                  }}
                />
                {/* The red line */}
                <div
                  style={{
                    height: '2px',
                    backgroundColor: '#ef4444',
                    boxShadow: '0 0 4px rgba(239, 68, 68, 0.4)'
                  }}
                />
                {/* Time label */}
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1 }}
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: -20,
                    fontSize: '11px',
                    fontWeight: 600,
                    color: '#ef4444',
                    backgroundColor: 'var(--bg-card, white)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                  }}
                >
                  NOW
                </motion.span>
              </motion.div>
            )}

            {/* Day Columns Grid - Content scrolls under sticky header; raise above sticky when confirm popover is open */}
            <div style={{ 
              display: 'grid',
              gridTemplateColumns: `repeat(${visibleDays.length}, 1fr)`,
              gap: `${dayGrid.gap}px`,
              position: 'relative',
              zIndex: confirmingSlot ? 101 : 3,
              width: '100%',
            }}>
              {visibleDays.map(([date, dateSessions], columnIndex) => {
                const isToday = columnIndex === todayColumnIndex;
                const isPast = (() => {
                  const sessionDate = new Date(date);
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  sessionDate.setHours(0, 0, 0, 0);
                  return sessionDate < today;
                })();

                const isColumnWithPopover = Boolean(confirmingSlot && dateSessions.some(s => s.id === confirmingSlot));

                return (
                  <motion.div 
                    key={date} 
                    className={`calendar-day-column ${isToday ? 'calendar-day-today' : ''} ${isPast ? 'calendar-day-past' : ''}`}
                    custom={columnIndex}
                    initial="hidden"
                    animate="visible"
                    variants={columnVariants}
                    style={{ position: 'relative', width: '100%', zIndex: isColumnWithPopover ? 101 : undefined }}
                  >
                    {/* Timeline Container with Ghost Hover Effect */}
                    <div className="calendar-timeline-container calendar-timeline-interactive" style={{ 
                      position: 'relative',
                      width: '100%',
                      height: timelineHeight,
                      border: 'none',
                      overflow: 'visible',
                      zIndex: 1,
                      opacity: isPast ? 0.7 : 1,
                      filter: isPast ? 'grayscale(15%)' : 'none',
                      transition: 'opacity 0.3s ease, filter 0.3s ease'
                    }}>
                      
                      {dateSessions.map((session, _slotIndex) => {
                        const isBooked = bookedSlots.has(session.id);
                        const conflict = getCalendarConflict(session);
                        const hasConflict = !!conflict;
                        const isFull = session.remaining <= 0;
                        const isAvailable = session.remaining > 0 && new Date(session.end_time) >= new Date();
                        const isSessionPast = new Date(session.end_time) < currentTime;
                        
                        const slotStartHour = getHourFromSlot(session.start_time);
                        const slotEndHour = getHourFromSlot(session.end_time);
                        
                        const topPosition = Math.max(0, Math.min(100, getTimePosition(slotStartHour)));
                        const bottomPosition = Math.max(0, Math.min(100, getTimePosition(slotEndHour)));
                        
                        const rawHeight = bottomPosition - topPosition;
                        const height = Math.max(0.01, rawHeight);
                        
                        const roundedTop = Math.round(topPosition * 10000) / 10000;
                        /** Min ~0.02% so sub-pixel durations still render; % matches .calendar-grid-lines (same containing block). */
                        const roundedHeight = Math.max(0.02, Math.round(height * 10000) / 10000);

                        const canClick = !isBooked && !hasConflict && isAvailable && !isFull && !bookingLoading && !isSessionPast;
                        const isConfirming = confirmingSlot === session.id;

                        let slotClass = 'calendar-slot calendar-slot-btn calendar-slot-booking-timeline position-absolute ';
                        
                        if (isConfirming) {
                          slotClass += 'calendar-slot-selected';
                        } else if (isBooked) {
                          slotClass += 'calendar-slot-booked';
                        } else if (isFull) {
                          slotClass += 'calendar-slot-full';
                        } else if (hasConflict) {
                          slotClass += 'calendar-slot-conflict';
                        } else if (isSessionPast) {
                          slotClass += 'calendar-slot-past';
                        } else {
                          slotClass += 'calendar-slot-ghost';
                        }

                        return (
                          <div
                            key={session.id}
                            className={slotClass}
                            style={{ 
                              position: 'absolute',
                              top: `${roundedTop}%`,
                              height: `${roundedHeight}%`,
                              left: '6px',
                              right: '6px',
                              width: 'calc(100% - 12px)',
                              boxSizing: 'border-box',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: canClick ? 'pointer' : 'not-allowed',
                              zIndex: isConfirming ? 9999 : (isBooked ? 5 : 2),
                              pointerEvents: canClick || isBooked ? 'auto' : 'none',
                              opacity: isSessionPast ? 0.65 : 1,
                            }}
                            title={(() => {
                              const startTime = formatTime(session.start_time);
                              const endTime = formatTime(session.end_time);
                              if (isBooked) return `Your booking: ${startTime} - ${endTime}`;
                              if (isFull) return `Full: ${startTime} - ${endTime}`;
                              if (conflict) return describeCalendarClash(conflict);
                              if (isSessionPast) return `Past: ${startTime} - ${endTime}`;
                              return `Available: ${startTime} - ${endTime} (${session.remaining} remaining)`;
                            })()}
                            onClick={(e) => canClick && handleSlotClick(session, e.currentTarget as HTMLElement)}
                          >
                            <span className="timeslot-label">
                              {formatTimeRange(session.start_time, session.end_time)}
                            </span>

                            {/* Booking confirmation popover */}
                            <AnimatePresence>
                              {isConfirming && (
                                <motion.div 
                                  ref={popoverRef}
                                  className={`booking-popover ${popoverFlipped ? 'booking-popover-below' : ''}`}
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                  exit={{ opacity: 0 }}
                                  transition={{ duration: 0.15 }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className="booking-popover-header">Confirm Booking</div>
                                  <div className="booking-popover-time">
                                    {(() => {
                                      const startDate = new Date(session.start_time);
                                      const dayName = startDate.toLocaleDateString('en-US', { 
                                        weekday: 'long'
                                      });
                                      return `${dayName}, ${formatTimeRange(session.start_time, session.end_time)}`;
                                    })()}
                                  </div>
                                  <div className="booking-popover-actions">
                                    <motion.button
                                      className="booking-popover-cancel"
                                      whileHover={{ scale: 1.02 }}
                                      whileTap={{ scale: 0.98 }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleCancelBooking();
                                      }}
                                    >
                                      Cancel
                                    </motion.button>
                                    <motion.button
                                      className="booking-popover-confirm"
                                      whileHover={{ scale: 1.02 }}
                                      whileTap={{ scale: 0.98 }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleConfirmBooking(session.id);
                                      }}
                                    >
                                      Confirm
                                    </motion.button>
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>

                            {/* Loading indicator */}
                            {bookingLoading === session.id && (
                              <div 
                                style={{ 
                                  position: 'absolute',
                                  top: '50%',
                                  left: '50%',
                                  transform: 'translate(-50%, -50%)',
                                  zIndex: 10
                                }}
                              >
                                <div className="spinner-border spinner-border-sm" role="status" aria-label="Booking session" aria-busy="true">
                                  <span className="visually-hidden">Booking...</span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/*
        The days the window could not fit.

        Truncating is acceptable; truncating silently is not. Without this a
        participant is shown a calendar that looks complete and has no way of
        knowing that the slot they were sent a link for is one of the days off
        the end of it.
      */}
      {omittedDays.length > 0 && (
        <div className="alert alert-info d-flex align-items-center mt-3" role="status">
          <Info size={16} className="me-2" aria-hidden="true" />
          <span>
            {/*
              Bug #112 (notice copy): this used to read "Showing the first N
              days. M later days are not shown" unconditionally. Once the
              window can be anchored past day zero or paged backward, the
              omitted set includes EARLIER days too, so "first" and "later"
              are both frequently false. The wording below counts what is
              omitted without claiming a position for it, so it stays correct
              on every page rather than only the default one.
            */}
            {`${omittedDays.length} `}
            {omittedDays.length === 1 ? 'day is' : 'days are'}
            {' not shown, '}
            {omittedDaysWithSessions === 0
              ? 'none of which have sessions.'
              : omittedDaysWithSessions === 1
                ? '1 of which has sessions.'
                : `${omittedDaysWithSessions} of which have sessions.`}
            {showWeekNav ? ' Use Previous / Next to see them.' : ''}
          </span>
        </div>
      )}
    </div>
  );
});

CalendarGrid.displayName = 'CalendarGrid';

export default CalendarGrid;
