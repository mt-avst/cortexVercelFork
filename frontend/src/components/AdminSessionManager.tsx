import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Session, CreateSessionRequest, CalendarEvent, AvailableSlot } from '../api/types';
import { getMyCalendarEvents, getAvailability, calendarConnectUrl } from '../api/client';
import { createSessions, deleteAllSessions } from '../api/client';
import { logger } from '../utils/logger';

import { formatDateTime, formatClockTime, formatStudyDate } from '../utils/datetime';
/**
 * Safely convert a potentially Date or string value to ISO string
 * This handles runtime type inconsistencies from API responses
 */
const toISOString = (value: string | Date | unknown): string => {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'toISOString' in value && typeof (value as { toISOString: () => string }).toISOString === 'function') {
    return (value as { toISOString: () => string }).toISOString();
  }
  return String(value);
};
import { 
  CalendarX, 
  Lock, 
  CheckSquare, 
  CalendarDays, 
  Clock, 
  AlertTriangle, 
  Info, 
  Trash2, 
  LayoutGrid, 
  List, 
  RefreshCw, 
  ArrowLeft,
  ArrowRight,
  Plus
} from 'lucide-react';

/*
 * `resolveSaveOutcome` and `OpportunitySaveOutcome` were deleted here, not
 * moved. They existed to decide what to do after this component called the
 * parent back to save the opportunity - chiefly to NOT navigate when the save
 * returned no id, because navigating announced a success that had not happened.
 * With the commit point on the Review step there is no save to interpret: a
 * refusal keeps the author on Review, in front of the reason, which is what
 * that function was approximating.
 */

interface AdminSessionManagerProps {
  opportunityId: string;
  sessions: Session[];
  onSessionsChange: (sessions: Session[]) => void;
  defaultDurationMinutes: number;
  disabled?: boolean;
  isTemporary?: boolean;
  onBack?: () => void; // Prop for back navigation
  /**
   * The name of the step `onBack` returns to.
   *
   * This is the sixth backward control in the opportunity form and the only
   * one that is not a `StepActions` row. It said a bare "Back" while the other
   * five named their destination, which left the step that has the top/bottom
   * confusion still live as the one step where it had not been fixed.
   */
  onBackLabel?: string;
  /**
   * Move forward to the next step of the form, and the name of the step it
   * goes to.
   *
   * This step had no forward control at all while it WAS the last step. Review
   * follows it now, so it needs one - and it names its destination for the same
   * reason `onBackLabel` does.
   */
  onContinue?: () => void;
  onContinueLabel?: string;
}

interface CalendarViewProps {
  events: CalendarEvent[];
  availableSlots: AvailableSlot[];
  selectedSlots: Set<string>;
  confirmedSlots: Set<string>;
  onSlotSelect: (slot: AvailableSlot) => void;
  onSlotDeselect: (slot: AvailableSlot) => void;
  durationMinutes: number | undefined;
  currentPage: number;
  onPageChange: (page: number) => void;
  daysPerPage: number;
  startDate: Date;
  endDate: Date;
  excludeWeekends: boolean;
  sessions: Session[];
  /**
   * Slots the researcher explicitly asked for - hand-entered ones, and ones
   * that are already real sessions. Exempt from the duration filter and given
   * priority in the overlap prune (cto/AdaptaLabs#89).
   */
  protectedSlotKeys: ReadonlySet<string>;
}

/**
 * Local YYYY-MM-DD for an <input type="date">.
 *
 * NOT toISOString().split('T')[0]: the calendar's dates are local midnight, and
 * a positive offset pushes the ISO form onto the PREVIOUS day - local midnight
 * on 19 Aug in BST is 18 Aug 23:00Z - so the picker would show the day before
 * the one the calendar is displaying.
 */
const toDateInputValue = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * The hours the calendar timeline actually draws.
 *
 * ONE declaration, because four things depend on agreeing: the slot's vertical
 * position, the hour labels down the side, the "unusually large slot height"
 * threshold, and the manual-entry gate. They were three separate literals, and
 * a slot outside the range was accepted, selected, created and drawn at ZERO
 * HEIGHT - so it could not be clicked to remove it either (cto/AdaptaLabs#89).
 */
const TIMELINE_START_HOUR = 7;
const TIMELINE_END_HOUR = 23;

/**
 * How far into the past a slot's start may lie before the grid treats it as
 * unselectable (cto/AdaptaLabs#101).
 *
 * A LITERAL MIRROR of the server's `NEW_SESSION_PAST_GRACE_MS`
 * (backend/src/validation/schemas.ts): the create routes refuse a start more
 * than one minute in the past (#90), so the grid must not offer such a slot for
 * selection. Written as the same literal and pinned in the component test, so
 * the two can only drift on purpose - the server stays the real gate either way.
 */
export const PAST_SLOT_GRACE_MS = 60_000;

/** A slot whose start is far enough in the past that the server would refuse it. */
export const slotIsPast = (slot: { start: string }): boolean =>
  new Date(slot.start).getTime() < Date.now() - PAST_SLOT_GRACE_MS;

/**
 * Whether the timeline can draw a slot WHERE IT ACTUALLY IS.
 *
 * `getTimePosition` clamps, so a slot outside the drawn hours lands at height
 * ~0% on an edge and cannot be clicked - and the per-slot delete is the only
 * per-session removal on this screen (cto/AdaptaLabs#95). Slots this returns
 * true for are drawn in the gutter row below the grid instead of in it.
 *
 * ONE declaration, because the manual-entry gate and the gutter have to agree:
 * a slot the entry gate would refuse for being undrawable is exactly a slot the
 * gutter has to catch when it reaches the database another way.
 *
 * The end hour is the START hour plus the slot's own span, NOT the end
 * timestamp's local hour: a 23:30-00:30 slot reads as ending at 0.5 that way,
 * which is inside the window by arithmetic and off the grid in fact.
 */
const isOutsideDrawableHours = (start: Date, end: Date): boolean => {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  const startHours = start.getHours() + start.getMinutes() / 60 + start.getSeconds() / 3600;
  const endHours = startHours + (end.getTime() - start.getTime()) / (60 * 60 * 1000);
  return startHours < TIMELINE_START_HOUR || endHours > TIMELINE_END_HOUR;
};

/** The same question asked of a slot rather than a pair of instants. */
const slotIsOutsideDrawableHours = (slot: { start: string; end: string }): boolean =>
  isOutsideDrawableHours(new Date(slot.start), new Date(slot.end));

/**
 * The slot key used everywhere in this file for slot identity.
 *
 * One expression, because selection, confirmation, the manual set and the
 * pruning below all have to agree on what "the same slot" means, and four
 * spellings of it is four chances to disagree.
 */
const slotKeyOf = (slot: { start: string; end: string }): string => `${slot.start}|${slot.end}`;

/**
 * Slots the researcher explicitly asked for, which outrank generated ones.
 *
 * Hand-entered slots and slots that are already real sessions. Both must
 * survive the duration filter and the overlap prune below: a slot the
 * researcher typed in, or one that already exists in the database, being
 * silently dropped from the only view of it is worse than a crowded grid.
 */
type ProtectedKeys = ReadonlySet<string>;

/**
 * Remove overlapping slots, keeping protected ones in preference to generated
 * ones.
 *
 * The prune is greedy over a sorted list, so ORDER decides who survives. That
 * was start time alone, which broke the manual-slot control completely
 * (cto/AdaptaLabs#89): the generated grid is contiguous :00/:30, so a
 * hand-entered 14:15 always sorted after the generated 14:00-14:30 and was
 * discarded before rendering - while still being selected and still being
 * created, producing a session nobody could see. Protected slots now sort
 * first, so the generated neighbours are the ones dropped. The researcher
 * cannot have both, and the one they typed is the one they meant.
 */
const pruneOverlaps = (slots: AvailableSlot[], protectedKeys: ProtectedKeys): AvailableSlot[] => {
  if (slots.length === 0) return slots;

  const slotRanges = slots.map(slot => {
    const start = new Date(slot.start).getTime();
    const end = new Date(slot.end).getTime();
    return {
      slot,
      start,
      end,
      // Exact-duplicate detection by time, not string.
      key: `${start}|${end}`,
      isProtected: protectedKeys.has(slotKeyOf(slot)),
    };
  });

  // Exact duplicates by time collapse to one - preferring a protected copy, so
  // a hand-entered slot that coincides exactly with a generated one keeps its
  // protection rather than losing it to whichever arrived first.
  const uniqueByTime = new Map<string, typeof slotRanges[0]>();
  slotRanges.forEach(range => {
    const existing = uniqueByTime.get(range.key);
    if (!existing || (range.isProtected && !existing.isProtected)) {
      uniqueByTime.set(range.key, range);
    }
  });
  const uniqueSlots = Array.from(uniqueByTime.values());

  uniqueSlots.sort((a, b) => {
    // Protected first: this line is the fix, and the test
    // `draws a hand-entered slot the generated grid cannot express` is what
    // fails when it is removed.
    if (a.isProtected !== b.isProtected) return a.isProtected ? -1 : 1;
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });

  const nonOverlapping: Array<{ slot: AvailableSlot; start: number; end: number }> = [];

  uniqueSlots.forEach(current => {
    // Two slots overlap if they share ANY time. Adjacent slots - one ending
    // exactly as another starts - do NOT overlap.
    const hasOverlap = nonOverlapping.some(added => {
      const isAdjacent = current.start === added.end || current.end === added.start;
      const hasTimeOverlap = current.start < added.end && current.end > added.start;
      return hasTimeOverlap && !isAdjacent;
    });

    if (!hasOverlap) {
      nonOverlapping.push({ slot: current.slot, start: current.start, end: current.end });
    }
  });

  // Back into chronological order: the prune's sort put protected slots first,
  // and the grid positions slots by time but the DOM order should still read
  // down the day.
  return nonOverlapping
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map(entry => entry.slot);
};

/**
 * Keep only slots matching the selected duration - except protected ones.
 *
 * A generated slot of the wrong length is noise. A real session or a
 * hand-entered slot of the wrong length is a fact, and hiding it because the
 * duration dropdown moved is how a 45-minute session becomes undeletable from
 * this screen.
 */
const filterByDuration = (
  slots: AvailableSlot[],
  durationMinutes: number | undefined,
  protectedKeys: ProtectedKeys
): AvailableSlot[] => {
  if (!durationMinutes) return slots;

  return slots.filter(slot => {
    if (protectedKeys.has(slotKeyOf(slot))) return true;
    const slotDurationMinutes =
      (new Date(slot.end).getTime() - new Date(slot.start).getTime()) / (1000 * 60);
    // 30 seconds of tolerance for rounding, and no more.
    return Math.abs(slotDurationMinutes - durationMinutes) <= 0.5;
  });
};

/**
 * Every day between two dates that the grid is willing to draw a column for.
 *
 * At module scope so the parent's slot counter derives its answer from the SAME
 * function the grid does. Reimplementing it beside the counter is how the two
 * drift - which they already had.
 */
const daysInRange = (startDate: Date, endDate: Date, excludeWeekends: boolean): Date[] => {
  const days: Date[] = [];
  const current = new Date(startDate);
  const end = new Date(endDate);

  while (current <= end) {
    if (!excludeWeekends || (current.getDay() >= 1 && current.getDay() <= 5)) {
      days.push(new Date(current));
    }
    current.setDate(current.getDate() + 1);
  }
  return days;
};

/**
 * Most day columns the grid will ever draw at once.
 *
 * NOT `daysPerPage`, which is what the first attempt at this bounded. The grid
 * renders `renderDayColumns(..., maxColumnsPerRow)` exactly TWICE - a first row
 * and an "additional days" row - and that function's loop runs to `maxColumns`.
 * So ten is the hard ceiling however high `daysPerPage` auto-adjusts (it goes to
 * 14, 21 and 30), and a counter bounded by the page still over-reported on any
 * range wider than ten visible days: measured 120 counted against 40 drawn at
 * 30 weekdays.
 *
 * Kept beside the two constants it is derived from so the derivation is visible;
 * `maxColumnsPerRow` is declared inside CalendarView and this must agree with it.
 */
const MAX_COLUMNS_PER_ROW = 5;
const MAX_DRAWN_ROWS = 2;
const MAX_DRAWN_DAYS = MAX_COLUMNS_PER_ROW * MAX_DRAWN_ROWS;

/**
 * The days actually ON SCREEN, which is a PAGE of the range and not the range.
 *
 * `daysPerPage` auto-adjusts to cover the range but CAPS AT 30, so any wider
 * range paginates - and the counter, which bounded only the range, then counted
 * days the grid was not drawing. Measured 40 counted against 20 drawn with the
 * End Date moved out 60 days. That is the same over-report the range bound was
 * added to fix, one control change away.
 */
const visibleDayKeys = (
  startDate: Date,
  endDate: Date,
  excludeWeekends: boolean,
  currentPage: number,
  daysPerPage: number
): Set<string> => {
  const all = daysInRange(startDate, endDate, excludeWeekends);
  const start = currentPage * daysPerPage;
  // Whichever bound bites first. The page can be wider than the grid can draw.
  const drawn = Math.min(daysPerPage, MAX_DRAWN_DAYS);
  return new Set(all.slice(start, start + drawn).map(day => day.toDateString()));
};

/** Every slot the grid will actually draw, given what it was handed. */
const slotsToDraw = (
  slots: AvailableSlot[],
  durationMinutes: number | undefined,
  protectedKeys: ProtectedKeys
): AvailableSlot[] => pruneOverlaps(filterByDuration(slots, durationMinutes, protectedKeys), protectedKeys);

const CalendarView: React.FC<CalendarViewProps> = ({
  events,
  availableSlots,
  selectedSlots,
  confirmedSlots,
  onSlotSelect,
  onSlotDeselect,
  durationMinutes,
  currentPage,
  onPageChange,
  daysPerPage,
  startDate,
  endDate,
  excludeWeekends,
  sessions,
  protectedSlotKeys
}) => {
  /**
   * Slots whose label has already failed to render and been reported.
   *
   * The report below happens during render, and this grid re-renders on every
   * currentTime tick - so without this, one malformed timestamp would emit a
   * console line every tick for the life of the page. Once per slot is enough
   * to diagnose it; a flood is just a different way of losing the signal.
   */
  const reportedLabelFailures = useRef<Set<string>>(new Set());

  // The reader's own zone, like the rest of the app - and the GRID BELOW now
  // agrees with it. This calendar used to position slots by getUTCHours() and
  // bound its day columns with setUTCHours() while labelling them locally,
  // which put every caption an hour out of its own row in BST and four or five
  // in the US. Geometry and labels are both local now; the header states which
  // zone, because a grid of times that does not say whose they are is the
  // defect this whole branch exists to remove.
  const formatTime = (dateString: string) => formatClockTime(dateString) ?? '';

  const formatDate = (dateString: string) => formatStudyDate(dateString) ?? '';


  const isSlotSelected = (slot: AvailableSlot) => {
    const slotKey = `${slot.start}|${slot.end}`;
    return selectedSlots.has(slotKey);
  };

  const isSlotConfirmed = (slot: AvailableSlot) => {
    // Slot times are ISO strings per type definition
    // Use toISOString helper to safely handle runtime type inconsistencies
    const slotStart = toISOString(slot.start);
    const slotEnd = toISOString(slot.end);
    const slotKey = `${slotStart}|${slotEnd}`;
    const isConfirmed = confirmedSlots.has(slotKey);
    
    // Check if slot is confirmed
    // (Debug logging removed for production)
    
    return isConfirmed;
  };

  const isSlotBusy = (slot: AvailableSlot) => {
    const slotStart = new Date(slot.start);
    const slotEnd = new Date(slot.end);
    
    return events.some(event => {
      const eventStart = new Date(event.start);
      const eventEnd = new Date(event.end);
      return (slotStart < eventEnd && slotEnd > eventStart);
    });
  };

  const isSlotAllocated = (slot: AvailableSlot) => {
    const slotStart = new Date(slot.start);
    const slotEnd = new Date(slot.end);
    
    return sessions.some(session => {
      const sessionStart = new Date(session.start_time);
      const sessionEnd = new Date(session.end_time);
      // Check for overlap but exclude exact matches (exact matches are existing sessions, not allocations)
      const hasOverlap = (slotStart < sessionEnd && slotEnd > sessionStart);
      const isExactMatch = (slotStart.getTime() === sessionStart.getTime() && slotEnd.getTime() === sessionEnd.getTime());
      return hasOverlap && !isExactMatch;
    });
  };

  // Get session for a specific time slot - memoized to prevent excessive re-renders
  const getSessionForSlot = useCallback((slot: AvailableSlot) => {
    const slotStart = new Date(slot.start);
    const slotEnd = new Date(slot.end);
    
    const session = sessions.find(session => {
      const sessionStart = new Date(session.start_time);
      const sessionEnd = new Date(session.end_time);
      // Find exact matches (existing sessions) - allow small tolerance for milliseconds
      const startDiff = Math.abs(slotStart.getTime() - sessionStart.getTime());
      const endDiff = Math.abs(slotEnd.getTime() - sessionEnd.getTime());
      // Allow up to 1 second tolerance for timezone/rounding differences
      const tolerance = 1000; // 1 second in milliseconds
      return startDiff <= tolerance && endDiff <= tolerance;
    });
    
    return session;
  }, [sessions]);

  /**
   * Everything about a slot that is the same wherever it is drawn.
   *
   * A slot appears in two places now - positioned on the timeline, or in the
   * gutter row when the timeline cannot draw it (cto/AdaptaLabs#95) - and the
   * gutter exists so the slot can be CLICKED. Two copies of "is this busy, is
   * it mine, may it be clicked" is two chances for the gutter copy to drift
   * into offering a delete the grid refuses, or refusing one the grid offers.
   */
  const describeSlot = (slot: AvailableSlot) => {
    const session = getSessionForSlot(slot);
    const isSelected = isSlotSelected(slot);
    const isConfirmed = isSlotConfirmed(slot);
    const isBusy = isSlotBusy(slot);
    const isAllocated = isSlotAllocated(slot);
    // A start the server would refuse (#101). Only meaningful for a FREE slot
    // the researcher might newly select - an existing past session stays drawn
    // as a session, and blocked slots keep their own reason.
    const isPast = slotIsPast(slot) && !session && !isConfirmed && !isBusy && !isAllocated;
    // Busy, full and allocated slots are not the researcher's to act on.
    const isBlocked = isBusy || (!!session && session.remaining <= 0) || isAllocated;

    let slotClass = 'calendar-slot';
    if (isConfirmed || (session && session.remaining > 0)) {
      slotClass += ' calendar-slot-admin-confirmed';
    } else if (isSelected) {
      slotClass += ' calendar-slot-admin-selected';
    } else if (session && session.remaining <= 0) {
      slotClass += ' calendar-slot-full';
    } else if (isAllocated) {
      slotClass += ' calendar-slot-admin-allocated';
    } else if (isBusy) {
      slotClass += ' calendar-slot-admin-busy';
    } else if (isPast) {
      // Greyed and unselectable; the inline style at the render site carries
      // the appearance so this stays out of the shared stylesheet.
      slotClass += ' calendar-slot-admin-past';
    } else {
      // Available slot - matches user calendar ghost style
      slotClass += ' calendar-slot-admin-available';
    }

    return { session, isSelected, isConfirmed, isBusy, isAllocated, isPast, isBlocked, slotClass };
  };

  type SlotStatus = ReturnType<typeof describeSlot>;

  const slotTooltip = (slot: AvailableSlot, status: SlotStatus): string => {
    try {
      const timeSpan = `${formatTime(slot.start)} to ${formatTime(slot.end)}`;
      const { session, isBusy, isAllocated, isSelected, isConfirmed, isPast } = status;

      if (session) {
        return `${timeSpan} - Session: ${session.capacity} capacity, ${session.booked_count} booked, ${session.remaining} remaining`;
      }
      if (isBusy) return `${timeSpan} - This time slot conflicts with existing calendar events`;
      if (isAllocated) return `${timeSpan} - This slot is allocated to another opportunity`;
      if (isSelected) return `${timeSpan} - Selected for session creation`;
      if (isConfirmed) return `${timeSpan} - Session confirmed`;
      if (isPast) return `${timeSpan} - This time is in the past and cannot be scheduled`;
      return `${timeSpan} - Available time slot`;
    } catch (error) {
      logger.error('Error formatting tooltip', { errorMessage: String(error), slotStart: slot.start });
      return `${slot.start} to ${slot.end}`;
    }
  };

  /**
   * The slot's own times, or null if one of them cannot be read.
   *
   * Returning null keeps one bad timestamp from throwing during render and
   * taking the whole session grid down with it. But an admin cannot tell a
   * label that is hidden from a label that failed, so the cause has to go
   * somewhere - once per slot, for the reason on the ref.
   */
  const slotTimeLabel = (slot: AvailableSlot): string | null => {
    try {
      return `${formatTime(slot.start)} - ${formatTime(slot.end)}`;
    } catch (error) {
      const slotKey = slotKeyOf(slot);
      if (!reportedLabelFailures.current.has(slotKey)) {
        reportedLabelFailures.current.add(slotKey);
        logger.error('Could not render a time-slot label', {
          component: 'AdminSessionManager',
          slotStart: slot.start,
          slotEnd: slot.end,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
  };

  const clickSlot = (slot: AvailableSlot, status: SlotStatus) => {
    const { session, isSelected, isConfirmed, isBusy, isAllocated, isPast, isBlocked } = status;
    logger.debug('Slot clicked:', {
      slotKey: slotKeyOf(slot),
      isSelected,
      isConfirmed,
      isBusy,
      isAllocated,
      isPast,
      hasSession: !!session,
      sessionId: session?.id,
    });

    if (isBlocked) {
      logger.debug('Slot click blocked - busy, full, or allocated');
      return;
    }

    // A past free slot cannot be selected (#101): the server refuses it, so
    // offering the click only produces a whole-batch refusal at Confirm.
    // isPast is already false for an existing session or a confirmed slot, so
    // this never traps a deselect.
    if (isPast) {
      logger.debug('Slot click blocked - start is in the past');
      return;
    }

    if (isSelected) {
      logger.debug('Deselecting slot');
      onSlotDeselect(slot);
    } else if (isConfirmed || session) {
      // Existing session or confirmed slot - deselect immediately in one click
      logger.debug(session ? 'Deselecting existing session slot' : 'Unassigning confirmed slot');
      onSlotDeselect(slot);
    } else {
      logger.debug('Selecting free slot');
      onSlotSelect(slot);
    }
  };

  // Days in the selected range, in the reader's local zone. The derivation is at
  // module scope so the parent's counter uses the same one (cto/AdaptaLabs#89).
  const allDays = daysInRange(startDate, endDate, excludeWeekends);
  
  // Calculate pagination based on days
  const totalPages = Math.ceil(allDays.length / daysPerPage);
  const startDayIndex = currentPage * daysPerPage;
  const endDayIndex = startDayIndex + daysPerPage;
  const currentDays = allDays.slice(startDayIndex, endDayIndex);
  
  // Determine if we need a multi-row layout. Through the shared constant, not
  // literal 5s: the row split and the per-row column cap have to agree, and
  // while they were separate the true ceiling was `5 + MAX_COLUMNS_PER_ROW`
  // rather than `MAX_COLUMNS_PER_ROW * MAX_DRAWN_ROWS` - so raising the constant
  // to 7 made the counter read 280 against 240 drawn.
  const needsMultiRow = currentDays.length > MAX_COLUMNS_PER_ROW;
  const firstRowDays = needsMultiRow ? currentDays.slice(0, MAX_COLUMNS_PER_ROW) : currentDays;
  const secondRowDays = needsMultiRow ? currentDays.slice(MAX_COLUMNS_PER_ROW) : [];
  
  // Use consistent column count for both rows (always 5 columns max for visual consistency)
  const maxColumnsPerRow = MAX_COLUMNS_PER_ROW;
  

  // Duration filter and overlap prune both live at module scope now, so the
  // parent can compute the same drawn set for its counter instead of guessing
  // at it - the counter used to report the PRE-filter, PRE-prune length and
  // read 21 on a grid drawing 20.
  const cleanedSlots = slotsToDraw(availableSlots || [], durationMinutes, protectedSlotKeys);
  
  // Filtered slots ready (debug logging removed for production)
  
  // Group by LOCAL date. toDateString() has always been local, so this half of
  // the calendar was already local while the boundaries and positions were UTC
  // - the two only agree now.
  const allSlotsByDate = cleanedSlots.reduce((acc, slot) => {
    const date = new Date(slot.start).toDateString();
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(slot);
    return acc;
  }, {} as Record<string, AvailableSlot[]>);

  // Helper function to get slots for specific days
  const getSlotsForDays = (days: Date[]) => {
    return days.reduce((acc: Record<string, AvailableSlot[]>, day: Date) => {
      const dateString = day.toDateString();
      if (allSlotsByDate[dateString]) {
        acc[dateString] = allSlotsByDate[dateString];
      } else {
        acc[dateString] = []; // Empty array for days with no slots
      }
      return acc;
    }, {} as Record<string, AvailableSlot[]>);
  };

  // Get slots for first row days
  const firstRowSlots = getSlotsForDays(firstRowDays);
  // Get slots for second row days (if needed)
  const secondRowSlots = getSlotsForDays(secondRowDays);

  // Helper function to get hour from slot time
  const getHourFromSlot = (slotStart: string): number => {
    const date = new Date(slotStart);
    return date.getHours() + (date.getMinutes() / 60); // decimal hour, e.g. 9.5 for 09:30
  };

  // Helper function to calculate position percentage (7am = 0%, 11pm = 100%)
  const getTimePosition = (hour: number): number => {
    const startHour = TIMELINE_START_HOUR;
    const endHour = TIMELINE_END_HOUR;
    const totalHours = endHour - startHour; // 16 hours
    const adjustedHour = hour - startHour;
    return Math.max(0, Math.min(100, (adjustedHour / totalHours) * 100));
  };

  // Generate time markers for left column (7am to 11pm)
  // Returns hour markers and subdivision markers based on durationMinutes
  const generateTimeMarkers = (durationMinutes?: number): Array<{ time: number; isHour: boolean }> => {
    const markers: Array<{ time: number; isHour: boolean }> = [];
    
    // Determine subdivision interval based on duration
    let subdivisionInterval: number = 0.5; // Default to 30 minutes
    if (durationMinutes === 15) {
      subdivisionInterval = 0.25; // 15-minute marks (15, 30, 45)
    } else if (durationMinutes === 30) {
      subdivisionInterval = 0.5; // 30-minute marks
    } else if (durationMinutes === 45) {
      subdivisionInterval = 0.75; // 45-minute marks
    } else if (durationMinutes === 60) {
      subdivisionInterval = 0.5; // Show 30-minute marks for 60-min slots (for reference)
    }
    // If no duration selected, default to 30-minute marks
    
    for (let hour = TIMELINE_START_HOUR; hour <= TIMELINE_END_HOUR; hour++) {
      // Always add hour marker (full hour)
      markers.push({ time: hour, isHour: true });
      
      // Add subdivision markers based on interval
      if (subdivisionInterval === 0.25) {
        // 15-minute slots: show 15, 30, 45 minute marks
        if (hour < 23) {
          markers.push({ time: hour + 0.25, isHour: false }); // 15 min
          markers.push({ time: hour + 0.5, isHour: false });  // 30 min
          markers.push({ time: hour + 0.75, isHour: false }); // 45 min
        }
      } else if (subdivisionInterval === 0.5) {
        // 30-minute slots or 60-minute slots: show 30-minute marks
        if (hour < 23) {
          markers.push({ time: hour + 0.5, isHour: false });
        }
      } else if (subdivisionInterval === 0.75) {
        // 45-minute slots: show 45-minute marks
        if (hour < 23) {
          markers.push({ time: hour + 0.75, isHour: false });
        }
      }
    }
    
    return markers;
  };

  // Format time for display (12-hour format with AM/PM)
  const formatTimeLabel = (time: number): string => {
    const hour = Math.floor(time);
    const decimal = time % 1;
    let minutes = 0;
    if (decimal === 0.25) minutes = 15;
    else if (decimal === 0.5) minutes = 30;
    else if (decimal === 0.75) minutes = 45;
    
    const isPM = hour >= 12;
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const ampm = isPM ? 'PM' : 'AM';
    return `${displayHour}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  };

  // Helper function to render day columns with timeline layout
  const renderDayColumns = (
    slotsByDate: Record<string, AvailableSlot[]>,
    days: Date[],
    maxColumns: number = MAX_COLUMNS_PER_ROW
  ) => {
    // Define the type for column objects
    interface ColumnData {
      date: string;
      slots: AvailableSlot[];
      isEmpty: boolean;
    }
    
    // Create array of all possible columns (including empty ones for alignment)
    const allColumns: ColumnData[] = [];
    for (let i = 0; i < maxColumns; i++) {
      const day = days[i];
      if (day) {
        const dateString = day.toDateString();
        const rawSlots = slotsByDate[dateString] || [];
        
        // Remove overlapping slots and sort by start time
        let nonOverlappingSlots = pruneOverlaps(rawSlots, protectedSlotKeys);
        
        // Final deduplication pass using a Set to ensure absolute uniqueness by
        // time. Both keys, which is what makes the render-time pass that used to
        // sit below the timeline redundant: that one compared `start|end`
        // strings only, so every duplicate it could catch is caught here first.
        // Use the same key format as isSlotSelected for consistency
        const seen = new Set<string>();
        const duplicateKeys = new Set<string>();
        nonOverlappingSlots = nonOverlappingSlots.filter(slot => {
          // Use the same key format as selection tracking for consistency
          const slotKey = `${slot.start}|${slot.end}`;
          
          // Also check by time for extra safety
          const startTime = new Date(slot.start).getTime();
          const endTime = new Date(slot.end).getTime();
          const timeKey = `${startTime}|${endTime}`;
          
          // Check both keys to catch any inconsistencies
          if (seen.has(slotKey) || seen.has(timeKey)) {
            duplicateKeys.add(slotKey);
            logger.warn('Duplicate slot removed', { 
              slotKey, 
              timeKey,
              start: slot.start, 
              end: slot.end,
              startTime,
              endTime
            });
            return false;
          }
          seen.add(slotKey);
          seen.add(timeKey); // Track by both for safety
          return true;
        });
        
        // Log if duplicates were found
        if (duplicateKeys.size > 0) {
          logger.warn(`Found ${duplicateKeys.size} duplicate slot(s) for ${dateString}`, { duplicates: Array.from(duplicateKeys) });
        }
        
        // Sort by start time to ensure chronological order
        nonOverlappingSlots.sort((a, b) => {
          return new Date(a.start).getTime() - new Date(b.start).getTime();
        });
        
        allColumns.push({ date: dateString, slots: nonOverlappingSlots, isEmpty: false });
      } else {
        allColumns.push({ date: '', slots: [], isEmpty: true });
      }
    }

    const timeMarkers = generateTimeMarkers(durationMinutes);
    // Calculate timeline height: 16 hours displayed (7am-11pm)
    // Use fixed height that fits the full day without scrollbars
    // Approximately 50-55px per hour for comfortable spacing = 800-880px for 16 hours
    // Using 900px to ensure all slots fit comfortably with padding/borders
    const minTimelineHeight = 900; // Fixed height for 16 hours - no scrollbars needed
    const timelineHeight = '900px'; // Fixed height ensures consistent display

    return (
      <div className="admin-calendar-view calendar-living-interface" style={{ 
        display: 'flex',
        gap: '24px',
        width: '100%',
        overflowX: 'hidden',
        overflowY: 'hidden'
      }}>
          {/* Time Column (Left) */}
          <div style={{
            minWidth: '90px',
            width: '90px',
            position: 'sticky',
            left: 0,
            zIndex: 10,
            backgroundColor: 'var(--bg-app)' /* Black/near-black background */
          }}>
          {/* Time Header */}
          <div style={{
            height: '60px',
            borderBottom: '2px solid rgba(255, 78, 80, 0.3)', /* Red border with transparency */
            backgroundColor: 'var(--bg-app)' /* Black/near-black background */
          }}></div>
          {/* Time Markers */}
          <div style={{
            position: 'relative',
            height: timelineHeight,
            minHeight: `${minTimelineHeight}px`,
            overflow: 'hidden',
            backgroundColor: 'var(--bg-app)', /* Black/near-black background */
            borderLeft: '2px solid rgba(255, 78, 80, 0.3)', /* Left keyline - starts at 7:00 AM */
            borderRight: '2px solid rgba(255, 78, 80, 0.3)' /* Right keyline - starts at 7:00 AM */
          }}>
            {timeMarkers.map((marker, index) => {
              const isHour = marker.isHour;
              
              // Only render hour markers - skip 30-minute marks (no dotted lines)
              if (!isHour) {
                return null;
              }
              
              // For hour markers, use the exact time position
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
        </div>

        {/* Day Columns Container */}
        <div style={{ 
          position: 'relative',
          flex: 1,
          minWidth: `${maxColumns * 120}px`,
          backgroundColor: 'var(--bg-app)' /* Black/near-black background */
        }}>
          {/* Day Columns Grid */}
          <div style={{ 
            display: 'grid',
            gridTemplateColumns: `repeat(${maxColumns}, 1fr)`,
            gap: '8px',
            position: 'relative',
            zIndex: 3
          }}>
            {allColumns.map((column, index) => (
            <div key={column.isEmpty ? `empty-${index}` : column.date} className="calendar-day-column" style={{ position: 'relative' }}>
              {!column.isEmpty ? (
                <>
                  {/* Day Header */}
                  <div className="calendar-day-header-cell" style={{ 
                    height: '60px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center'
                  }}>
                    <div className="calendar-day-title" style={{ fontSize: 'var(--font-size-small, 0.875rem)', fontWeight: 600 }}>
                      {formatDate(column.date)}
                    </div>
                    <small className="calendar-day-sessions">
                      {column.slots.length} slot{column.slots.length !== 1 ? 's' : ''}
                    </small>
                  </div>
            
                  {(() => {
                    /*
                     * Two placements for one day's slots (cto/AdaptaLabs#95).
                     *
                     * `getTimePosition` clamps, so a slot outside the drawn
                     * hours lands at height ~0% on an edge: present in the DOM,
                     * counted, and impossible to click - which on this screen
                     * means impossible to delete, because the per-slot click IS
                     * the only per-session removal (Table view is read-only and
                     * Reset All refuses outright once anything is booked). Those
                     * slots are drawn in the gutter row below the grid instead,
                     * at their real times, clickable.
                     */
                    const timelineSlots = column.slots.filter(slot => !slotIsOutsideDrawableHours(slot));
                    const gutterSlots = column.slots.filter(slot => slotIsOutsideDrawableHours(slot));

                    return (
                      <>
                  {/* Timeline Container */}
                  <div style={{
                    position: 'relative',
                    height: timelineHeight,
                    border: 'none',
                    backgroundColor: 'var(--bg-app)', /* Black/near-black background */
                    overflow: 'hidden',
                    zIndex: 1
                  }}>
                    {/* Positioned Slots */}
                    {column.slots.length === 0 ? (
                      <div className="text-center" style={{
                        fontSize: '0.8rem',
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        color: 'var(--brand-headline)' /* Electric Coral red text */
                      }}>
                        <CalendarX size={14} className="me-1" />
                        No available slots
                      </div>
                    ) : (
                      timelineSlots.map((slot, slotIndex) => {
                        const status = describeSlot(slot);
                        const { session, isSelected, isConfirmed, isBlocked } = status;

                        // Session matching logic
                        if (sessions.length > 0 && !session && slotIndex === 0) {
                          // Only log for first slot to avoid spam
                          const slotStart = new Date(slot.start);
                          const slotEnd = new Date(slot.end);
                          const closeMatches = sessions.filter(s => {
                            const sStart = new Date(s.start_time);
                            const sEnd = new Date(s.end_time);
                            const startDiff = Math.abs(slotStart.getTime() - sStart.getTime());
                            const endDiff = Math.abs(slotEnd.getTime() - sEnd.getTime());
                            return startDiff < 60000 && endDiff < 60000; // Within 1 minute
                          });
                          if (closeMatches.length > 0) {
                            logger.debug('Found sessions close to slot but not matched', {
                              slot: { start: slot.start, end: slot.end },
                              closeMatches: closeMatches.map(s => ({
                                id: s.id,
                                start_time: s.start_time,
                                end_time: s.end_time,
                                opportunity_id: s.opportunity_id
                              }))
                            });
                          }
                        }

                        // Calculate position based on time with high precision
                        const slotStartHour = getHourFromSlot(slot.start);
                        const slotEndHour = getHourFromSlot(slot.end);

                        // Use precise position calculations
                        const topPosition = Math.max(0, Math.min(100, getTimePosition(slotStartHour)));
                        const bottomPosition = Math.max(0, Math.min(100, getTimePosition(slotEndHour)));

                        // Calculate height as the exact difference - this prevents overlap
                        // Round to 4 decimal places to avoid floating point precision issues
                        const rawHeight = bottomPosition - topPosition;
                        const height = Math.round((Math.max(0.01, rawHeight)) * 10000) / 10000;

                        // Ensure height doesn't exceed container bounds
                        const maxAllowedHeight = 100 - topPosition;
                        const finalHeight = Math.min(height, maxAllowedHeight);

                        // Round position values to avoid sub-pixel rendering issues
                        // CRITICAL: Use exact percentage values to prevent overlap
                        const roundedTop = Math.round(topPosition * 10000) / 10000;
                        const roundedHeight = Math.round(finalHeight * 10000) / 10000;

                        // Slot height calculation.
                        //
                        // Compared against what the slot's OWN duration implies
                        // rather than a flat 5%. Protected slots are exempt from
                        // the duration filter, so a 60-minute session drawn while
                        // the duration control says 30 - the case that exemption
                        // exists to allow - tripped a flat threshold three times
                        // per render. What is worth warning about is a height
                        // that disagrees with the slot's own span, which is a
                        // real geometry fault.
                        const timelineHours = TIMELINE_END_HOUR - TIMELINE_START_HOUR;
                        const expectedHeight =
                          ((new Date(slot.end).getTime() - new Date(slot.start).getTime()) /
                            (timelineHours * 60 * 60 * 1000)) *
                          100;
                        if (roundedHeight > expectedHeight * 1.5 + 1) {
                          logger.warn(`Unusually large slot height: ${roundedHeight}%`, {
                            slotStartHour,
                            slotEndHour,
                            topPosition,
                            bottomPosition,
                            rawHeight,
                            height,
                            finalHeight,
                            roundedHeight
                          });
                        }

                        // Ensure slots don't overlap by using exact percentage positioning
                        // The height should match exactly the time difference, not be fixed

                        const timeLabel = slotTimeLabel(slot);
                        // A real button, not a coloured div (row 6). It is
                        // reachable by keyboard and announced by a screen
                        // reader with its full time span, matching the gutter
                        // slots below - the selected state was colour-only and
                        // the tile carried no role at all.
                        const actionable = !status.isBlocked && !status.isPast;

                        return (
                          <div
                            key={slotKeyOf(slot)}
                            className={`${status.slotClass} position-absolute`}
                            role="button"
                            tabIndex={actionable ? 0 : -1}
                            aria-pressed={status.isSelected || status.isConfirmed}
                            aria-disabled={!actionable || undefined}
                            aria-label={slotTooltip(slot, status)}
                            style={{
                              width: 'calc(100% - 16px)',
                              left: '8px',
                              top: `${roundedTop}%`,
                              height: `${roundedHeight}%`,
                              maxHeight: `${roundedHeight}%`,
                              minHeight: '0',
                              boxSizing: 'border-box',
                              position: 'absolute',
                              transition: 'all 0.2s ease',
                              fontSize: '0.7rem',
                              padding: '2px 4px',
                              overflow: 'hidden',
                              zIndex: isSelected || isConfirmed ? 5 : 1,
                              pointerEvents: 'auto',
                              // Past free slots read as unavailable and take no
                              // click (#101). Inline so the appearance stays out
                              // of the shared stylesheet the admin-UX work owns.
                              ...(status.isPast ? { opacity: 0.4, cursor: 'not-allowed' } : {})
                            }}
                            title={slotTooltip(slot, status)}
                            onClick={() => clickSlot(slot, status)}
                            onKeyDown={(e) => {
                              // Enter/Space act like a click, because this is a
                              // button now. Blocked and past tiles are tabIndex
                              // -1 and take no key, matching clickSlot's refusal.
                              if (actionable && (e.key === 'Enter' || e.key === ' ')) {
                                e.preventDefault();
                                clickSlot(slot, status);
                              }
                            }}
                          >
                            {/* The time span, shown AT REST (row 6). It was
                                opacity:0 until hover, so the grid read as blank
                                tiles - the .timeslot-label CSS already carries a
                                themed, high-contrast colour for every slot
                                state, so nothing here needs to set one. */}
                            {timeLabel !== null && (
                              <div
                                className="timeslot-label"
                                style={{
                                  position: 'absolute',
                                  top: '50%',
                                  left: '0',
                                  right: '0',
                                  transform: 'translateY(-50%)',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  textAlign: 'center',
                                  pointerEvents: 'none',
                                  lineHeight: '1.2'
                                }}>
                                {timeLabel}
                              </div>
                            )}
                            {/* Show lock icon for unavailable slots */}
                            {isBlocked && (
                              <div style={{ position: 'absolute', top: '2px', right: '2px' }}>
                                <Lock size={8} />
                              </div>
                            )}
                            {/* Show checkbox icon ONLY when slot is selected (after user clicks).
                                Keyed on isBlocked, which is one case WIDER than the
                                `!isBusy && !isAllocated` this replaced: a selected slot whose
                                session has since filled up drew the lock and the tick on top of
                                each other, both pinned to the same 2px corner, on a slot the
                                click handler refuses anyway. The lock is the true one. */}
                            {!isBlocked && isSelected && (
                              <div style={{
                                position: 'absolute',
                                top: '2px',
                                right: '2px',
                                color: '#198754',
                                pointerEvents: 'none'
                              }}>
                                <CheckSquare size={12} />
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>

                        {/*
                          * The gutter row: sessions the timeline cannot place.
                          *
                          * Full-height chips rather than positioned slivers,
                          * because the ONLY thing wrong with these sessions is
                          * that nobody can click them. Their real times are
                          * always visible here - a hover-revealed label on a
                          * row that exists to say "these are the odd ones" is
                          * the same disclosure failure one step along.
                          *
                          * BELOW the timeline, not above it, and that is a
                          * constraint rather than a preference: every column's
                          * timeline is the same fixed height, so a gutter above
                          * would push only the columns that have one downwards
                          * and take their hours out of line with the hour axis
                          * on the left. Below, every gutter starts at the same
                          * offset and nothing moves.
                          */}
                        {gutterSlots.length > 0 && (
                          <div
                            className="calendar-gutter-row"
                            title={`These sessions fall outside ${String(TIMELINE_START_HOUR).padStart(2, '0')}:00-${String(TIMELINE_END_HOUR).padStart(2, '0')}:00, the hours the calendar draws`}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '4px',
                              padding: '6px 8px',
                              marginTop: '8px',
                              borderTop: '2px solid rgba(255, 78, 80, 0.3)',
                              backgroundColor: 'var(--bg-app)'
                            }}
                          >
                            <small
                              className="calendar-gutter-caption"
                              style={{ color: 'var(--brand-headline)', fontSize: '0.7rem' }}
                            >
                              <CalendarX size={12} className="me-1" />
                              Outside calendar hours
                            </small>
                            {gutterSlots.map(slot => {
                              const status = describeSlot(slot);
                              const timeLabel = slotTimeLabel(slot);
                              return (
                                <div
                                  key={slotKeyOf(slot)}
                                  className={`${status.slotClass} calendar-gutter-slot`}
                                  role="button"
                                  tabIndex={status.isBlocked || status.isPast ? -1 : 0}
                                  aria-disabled={status.isBlocked || status.isPast || undefined}
                                  title={slotTooltip(slot, status)}
                                  onClick={() => clickSlot(slot, status)}
                                  onKeyDown={(e) => {
                                    // Keyboard reach, because this row exists so
                                    // the slot can be acted on at all.
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      clickSlot(slot, status);
                                    }
                                  }}
                                  style={{
                                    position: 'relative',
                                    minHeight: '28px',
                                    padding: '4px 8px',
                                    fontSize: '0.7rem',
                                    cursor: status.isBlocked || status.isPast ? 'not-allowed' : 'pointer',
                                    // Past slots read as unavailable here too (#101).
                                    ...(status.isPast ? { opacity: 0.4 } : {})
                                  }}
                                >
                                  <span className="timeslot-label" style={{ opacity: 1 }}>
                                    {timeLabel ?? 'Unreadable time'}
                                  </span>
                                  {status.isBlocked && (
                                    <span style={{ position: 'absolute', top: '2px', right: '2px' }}>
                                      <Lock size={8} />
                                    </span>
                                  )}
                                  {!status.isBlocked && status.isSelected && (
                                    <span
                                      style={{
                                        position: 'absolute',
                                        top: '2px',
                                        right: '2px',
                                        color: '#198754',
                                        pointerEvents: 'none'
                                      }}
                                    >
                                      <CheckSquare size={12} />
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
              ) : (
                /* Empty column placeholder */
                <>
                  <div className="text-center p-2" style={{ 
                    backgroundColor: 'var(--bg-app)', /* Black/near-black background */
                    borderRadius: '8px 8px 0 0',
                    border: '1px solid rgba(255, 78, 80, 0.3)', /* Red border with transparency */
                    borderBottom: '2px solid rgba(255, 78, 80, 0.3)', /* Red border with transparency */
                    height: '60px'
                  }}></div>
                  <div style={{ 
                    height: timelineHeight,
                    border: '1px solid rgba(255, 78, 80, 0.3)', /* Red border with transparency */
                    borderTop: 'none',
                    backgroundColor: 'var(--bg-app)' /* Black/near-black background */
                  }}></div>
                </>
              )}
            </div>
          ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="calendar-view calendar-container-clipped">
      <div className="row">
        <div className="col-12">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h6 className="mb-0 text-brand-headline">
              Available Time Slots
              {needsMultiRow && (
                <span className="badge bg-info ms-2 calendar-info-badge">
                  Multi-Row Layout ({currentDays.length} days)
                </span>
              )}
            </h6>
          </div>

          {/* Multi-Row Day Layout */}
          <div className="calendar-timeline calendar-timeline-scroll">
            
            {/* First Row - Up to 5 days */}
            {renderDayColumns(firstRowSlots, firstRowDays, maxColumnsPerRow)}
            
            {/* Second Row - Additional days if more than 5 */}
            {needsMultiRow && secondRowDays.length > 0 && (
              <div className="mt-4">
                <div className="mb-2">
                  <small className="text-brand-headline">
                    <CalendarDays size={14} className="me-1" />
                    Additional Days ({secondRowDays.length} more)
                  </small>
                </div>
                {renderDayColumns(secondRowSlots, secondRowDays, maxColumnsPerRow)}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
};

/**
 * The session list (row 6).
 *
 * The DEFAULT view now, and no longer read-only: editing a study opens here on
 * every session that already exists - in chronological order, including the
 * ones outside the calendar grid's narrow window that it never drew at rest -
 * and each row can be removed. The calendar grid is reached through "Add
 * slots", which makes it the opt-in tool for creating more rather than the
 * gate every author has to pass to see what is already booked.
 */
const ListView: React.FC<{
  sessions: Session[];
  isTemporary: boolean;
  onRemove: (session: Session) => void;
  onAddSlots: () => void;
  disabled: boolean;
  loading: boolean;
}> = ({ sessions, isTemporary, onRemove, onAddSlots, disabled, loading }) => {
  // A NEW array before sorting - the prop is owned by the parent, and sorting
  // it in place would be a mutation of shared state (coding-style).
  const orderedSessions = [...sessions].sort(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );

  return (
    <div className="list-view">
      <style>
        {`
          .momentum-table-container {
            background: transparent;
            border-radius: var(--card-radius);
            overflow: hidden;
          }
          .momentum-table-container table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            background: transparent;
          }
          .momentum-table-container thead {
            background: var(--bg-card);
            backdrop-filter: blur(16px);
          }
          .momentum-table-container thead th {
            background: var(--bg-card);
            color: var(--text-primary);
            border-bottom: 1px solid var(--border-card);
            font-weight: 600;
            padding: 16px 12px;
            font-size: var(--font-size-body);
            vertical-align: middle;
          }
          .momentum-table-container tbody tr {
            background: transparent;
            border-bottom: 1px solid var(--border-card);
            transition: background-color var(--transition-card);
          }
          .momentum-table-container tbody tr:hover {
            background: var(--bg-card);
          }
          .momentum-table-container tbody td {
            color: var(--text-primary);
            padding: 16px 12px;
            vertical-align: middle;
            font-size: var(--font-size-body);
          }
          .momentum-table-container tbody td small {
            color: var(--text-muted);
            font-size: var(--font-size-metadata);
          }
        `}
      </style>
      <div className="card">
        <div className="card-header d-flex justify-content-between align-items-center gap-2 flex-wrap">
          <div>
            <h6 className="mb-0">Existing Sessions</h6>
            {isTemporary && sessions.length > 0 && (
              <small className="text-warning">
                <Clock size={14} className="me-1" />
                Sessions will be saved when opportunity is created
              </small>
            )}
          </div>
          <div className="d-flex align-items-center gap-3">
            {sessions.length > 0 && (
              <small className="text-muted">
                Total slots: {sessions.reduce((sum, s) => sum + s.capacity, 0)} •
                Remaining: {sessions.reduce((sum, s) => sum + s.remaining, 0)}
              </small>
            )}
            {/* The one place the calendar grid is reached from the list. Named
                for what it does, not for the view it opens. */}
            {sessions.length > 0 && (
              <button
                type="button"
                className="btn btn-outline-primary btn-sm"
                onClick={onAddSlots}
                disabled={disabled}
              >
                <Plus size={14} className="me-1" />
                Add slots
              </button>
            )}
          </div>
        </div>
        <div className="card-body">
          {sessions.length === 0 ? (
            <div className="text-center text-muted py-4">
              <CalendarX size={32} className="text-muted" />
              <p className="mt-2 mb-1">No sessions yet</p>
              <p className="mb-3">
                <small>Add time slots for participants to book.</small>
              </p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onAddSlots}
                disabled={disabled}
              >
                <Plus size={14} className="me-1" />
                Add slots
              </button>
            </div>
          ) : (
            <div className="table-responsive momentum-table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Start Time</th>
                    <th>End Time</th>
                    <th>Capacity</th>
                    <th>Booked</th>
                    <th>Remaining</th>
                    <th>Location/Link</th>
                    <th className="text-end">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedSessions.map((session) => {
                    // Booked sessions are not removable here, for the same
                    // reason Reset All refuses them: dropping a booked slot
                    // would strand the participant who booked it.
                    const hasBookings = session.booked_count > 0;
                    const removeTitle = hasBookings
                      ? `Cannot remove: ${session.booked_count} booking${session.booked_count === 1 ? '' : 's'}`
                      : 'Remove this session';
                    return (
                      <tr key={session.id}>
                        <td>{formatDateTime(session.start_time)}</td>
                        <td>{formatDateTime(session.end_time)}</td>
                        <td>{session.capacity}</td>
                        <td>{session.booked_count}</td>
                        <td>
                          <span className={`badge ${session.remaining > 0 ? 'bg-success' : 'bg-danger'}`}>
                            {session.remaining}
                          </span>
                        </td>
                        <td>
                          {session.location_or_meet_link_optional && (
                            <small className="text-muted">
                              {session.location_or_meet_link_optional.length > 30
                                ? `${session.location_or_meet_link_optional.substring(0, 30)}...`
                                : session.location_or_meet_link_optional
                              }
                            </small>
                          )}
                        </td>
                        <td className="text-end">
                          <button
                            type="button"
                            className="btn btn-outline-danger btn-sm"
                            onClick={() => onRemove(session)}
                            disabled={disabled || loading || hasBookings}
                            title={removeTitle}
                            aria-label={`Remove session on ${formatDateTime(session.start_time)}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const AdminSessionManager: React.FC<AdminSessionManagerProps> = ({
  opportunityId,
  sessions,
  onSessionsChange,
  defaultDurationMinutes,
  disabled = false,
  isTemporary = false,
  onBack,
  onBackLabel,
  onContinue,
  onContinueLabel
}) => {
  const { id: urlId } = useParams<{ id: string }>();
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [availableSlots, setAvailableSlots] = useState<AvailableSlot[]>([]);

  /**
   * Whether this researcher's own calendar could be read (cto/AdaptaLabs#89).
   *
   * Separate from `error` on purpose. A calendar that cannot be read is not a
   * failure of this screen - busy events only DIM slots, so authoring carries
   * on without them - but it IS something the researcher has to be told, or
   * they will read an unchecked grid as one checked against their diary.
   */
  const [calendarStatus, setCalendarStatus] = useState<'unknown' | 'connected' | 'not-connected' | 'unavailable'>('unknown');

  /**
   * Whether this deployment can start a calendar OAuth flow at all
   * (cto/AdaptaLabs#89).
   *
   * Read off the my-events 404 body rather than fetched separately, so learning
   * "not connected" and learning "connectable" cost one request between them.
   * Defaults false: offering a Connect control that leads to a 503 is worse
   * than offering none.
   */
  const [calendarConnectAvailable, setCalendarConnectAvailable] = useState(false);
  
  // Persist selected slots in sessionStorage to survive navigation
  // Use URL parameter for stable key that doesn't change during component lifecycle
  // The root of the sessionStorage helpers. Memoised on the two values it
  // reads so that everything built on it below is stable too - four of the
  // effects and callbacks in this file reach it, and without this they could
  // not name their real dependencies without being rebuilt every render.
  const getStorageKey = useCallback((type: 'selected' | 'confirmed' | 'manual') => {
    // Use URL ID if available (for editing), otherwise use opportunityId or temp
    const key = urlId || opportunityId || 'temp';
    return `${type}Slots_${key}`;
  }, [urlId, opportunityId]);

  const getStoredSelectedSlots = useCallback((): Set<string> => {
    try {
      const key = getStorageKey('selected');
      const stored = sessionStorage.getItem(key);
      logger.debug('Loading selected slots from storage:', { key, stored });
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  }, [getStorageKey]);

  const getStoredConfirmedSlots = useCallback((): Set<string> => {
    try {
      const key = getStorageKey('confirmed');
      const stored = sessionStorage.getItem(key);
      logger.debug('Loading confirmed slots from storage:', { key, stored });
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  }, [getStorageKey]);

  /**
   * Slots this researcher typed in by hand (cto/AdaptaLabs#89 item 2).
   *
   * Held as `start|end` keys, the same identity the selected and confirmed sets
   * use, and merged into what the grid draws. The generated availability grid
   * can only express starts that fall on a duration boundary from 07:00 UTC, so
   * a 14:15 interview was not expressible through this screen at all - and the
   * whole grid arrives from an endpoint, which is what this control exists to
   * stop authoring depending on.
   */
  const getStoredManualSlotKeys = useCallback((): Set<string> => {
    try {
      const stored = sessionStorage.getItem(getStorageKey('manual'));
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  }, [getStorageKey]);

  const [selectedSlots, setSelectedSlots] = useState<Set<string>>(getStoredSelectedSlots);
  const [manualSlotKeys, setManualSlotKeys] = useState<Set<string>>(getStoredManualSlotKeys);

  /**
   * The backward control's label, in one place.
   *
   * This component renders that control twice - once in the selection bar and
   * once below it - and the two copies had drifted to saying the same wrong
   * thing in two places. One expression means a test that reaches either copy
   * covers both, and there is no second spelling to forget.
   */
  const backLabel = onBackLabel ? `Previous: ${onBackLabel}` : 'Previous step';
  const continueLabel = onContinueLabel ? `Continue: ${onContinueLabel}` : 'Continue';
  /**
   * The forward control shown WHILE a selection is pending. It names its
   * commit, because it does one - "Continue" alone here is exactly what
   * dropped the selection (row 6). The plain `continueLabel` above stays on
   * the no-selection row, where there is nothing to commit.
   */
  const confirmAndContinueLabel = onContinueLabel
    ? `Confirm & continue: ${onContinueLabel}`
    : 'Confirm & continue';
  const [confirmedSlots, setConfirmedSlots] = useState<Set<string>>(getStoredConfirmedSlots);
  
  // View mode. Defaults to the LIST (row 6), not the calendar grid: editing a
  // study opens on a plain list of the sessions that already exist - including
  // ones outside the grid's tomorrow-to-+7-days window, which the grid never
  // showed at rest - and the calendar is the opt-in tool for adding more. This
  // mirrors the participant Table-default shipped in !365/!366.
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);

  // Debug component mount
  useEffect(() => {
    logger.debug('🟢 AdminSessionManager mounted:', {
      opportunityId,
      urlId,
      isTemporary,
      sessionsCount: sessions.length,
      selectedSlotsCount: selectedSlots.size,
      confirmedSlotsCount: confirmedSlots.size,
      viewMode,
      sessions: sessions.map(s => ({
        id: s.id,
        start_time: s.start_time,
        end_time: s.end_time,
        capacity: s.capacity,
        booked_count: s.booked_count
      }))
    });
    // Mount-only by design: a one-shot diagnostic snapshot of what the
    // component was handed. Listing the seven values it reads would turn it
    // into a log line on every slot click, so the empty array is the intent
    // here rather than an oversight. The directive has to be the line directly
    // above the dependency array for ESLint to attach it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist slots to sessionStorage whenever they change
  const persistSelectedSlots = useCallback((slots: Set<string>) => {
    try {
      const key = getStorageKey('selected');
      const value = JSON.stringify(Array.from(slots));
      sessionStorage.setItem(key, value);
      logger.debug('Persisted selected slots:', { key, value });
    } catch (error) {
      logger.warn('Failed to persist selected slots', { errorMessage: String(error) });
    }
  }, [getStorageKey]);

  const persistConfirmedSlots = useCallback((slots: Set<string>) => {
    try {
      const key = getStorageKey('confirmed');
      const value = JSON.stringify(Array.from(slots));
      sessionStorage.setItem(key, value);
      logger.debug('Persisted confirmed slots:', { key, value });
    } catch (error) {
      logger.warn('Failed to persist confirmed slots', { errorMessage: String(error) });
    }
  }, [getStorageKey]);
  
  const persistManualSlotKeys = useCallback((slots: Set<string>) => {
    try {
      sessionStorage.setItem(getStorageKey('manual'), JSON.stringify(Array.from(slots)));
    } catch (error) {
      logger.warn('Failed to persist manual slots', { errorMessage: String(error) });
    }
  }, [getStorageKey]);

  // Calendar view controls. Local day boundaries: these are absolute instants
  // by the time they reach the API (toISOString below), so "tomorrow through
  // next week" now means the admin's own days rather than UTC's.
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 1); // Start from tomorrow
    date.setHours(0, 0, 0, 0);
    logger.debug('Calendar startDate initialized', { date: date.toISOString() });
    return date;
  });
  const [endDate, setEndDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 7); // 7 days from today (1 week)
    date.setHours(23, 59, 59, 999);
    logger.debug('Calendar endDate initialized', { date: date.toISOString() });
    return date;
  });
  const [durationMinutes, setDurationMinutes] = useState<number | undefined>(
    defaultDurationMinutes && [15, 30, 45, 60].includes(defaultDurationMinutes) 
      ? defaultDurationMinutes 
      : 30 // Default to 30 minutes if no valid defaultDurationMinutes provided
  ); // Only allow 15, 30, 45, or 60 minutes
  const [excludeWeekends, setExcludeWeekends] = useState(true); // Exclude weekends by default
  
  // Pagination controls - now based on days instead of slots
  const [currentPage, setCurrentPage] = useState(0);
  const [daysPerPage, setDaysPerPage] = useState(5); // Show 5 days per page by default

  // Sync confirmed slots with existing sessions
  useEffect(() => {
    if (!sessions || sessions.length === 0) {
      // Only clear confirmed slots if we're in edit mode with a real opportunityId
      // For temporary/new opportunities, keep confirmed slots from sessionStorage
      if (isTemporary || !opportunityId) {
        // For new/temporary opportunities, try to restore from sessionStorage
        const stored = getStoredConfirmedSlots();
        if (stored.size > 0) {
          logger.debug('🔄 Restoring confirmed slots from storage for temporary opportunity:', {
            storedCount: stored.size,
            stored: Array.from(stored).slice(0, 3)
          });
          // Content-compared, so a re-run writing an equal set returns the
          // SAME reference and React bails out. This is the branch that made
          // the dependency array load-bearing: it wrote a brand new Set every
          // run, so it only settled because the dependency below is a
          // primitive. Widening that dependency to the set itself - which is
          // what the hooks rule would prefer and never warn about - used to
          // turn this into an unbounded loop on first paint of the new-study
          // picker. Now it converges regardless of how the array is written.
          setConfirmedSlots(prev =>
            prev.size === stored.size && Array.from(prev).every(slot => stored.has(slot))
              ? prev
              : stored
          );
        } else if (confirmedSlots.size > 0) {
          logger.debug('🔄 Clearing confirmed slots (no sessions and no stored slots)');
          setConfirmedSlots(new Set());
          persistConfirmedSlots(new Set());
        }
      } else if (confirmedSlots.size > 0) {
        // For saved opportunities with no sessions, clear confirmed slots
        logger.debug('🔄 Clearing confirmed slots (no sessions in saved opportunity)');
        setConfirmedSlots(new Set());
        persistConfirmedSlots(new Set());
      }
      return;
    }

    const sessionSlots = new Set<string>();
    sessions.forEach(session => {
      // Ensure start_time and end_time are ISO strings using helper
      const startTime = toISOString(session.start_time);
      const endTime = toISOString(session.end_time);
      
      const slotKey = `${startTime}|${endTime}`;
      sessionSlots.add(slotKey);
    });
    
    // Always update confirmed slots to ensure they're in sync
    // Use functional update to avoid stale state issues
    setConfirmedSlots(prevConfirmedSlots => {
      const currentArray = Array.from(prevConfirmedSlots).sort();
      const newArray = Array.from(sessionSlots).sort();
      const hasChanged = currentArray.length !== newArray.length || 
                        !currentArray.every((slot, index) => slot === newArray[index]);
      
      if (hasChanged) {
        logger.debug('🔄 Updating confirmed slots due to session changes:', {
          oldSlots: currentArray,
          newSlots: newArray,
          oldCount: currentArray.length,
          newCount: newArray.length,
          sessionsCount: sessions.length
        });
        persistConfirmedSlots(sessionSlots);
        return sessionSlots;
      }
      return prevConfirmedSlots;
    });
    
    // Process sessions and available slots
    logger.debug('🔄 Syncing confirmed slots with sessions:', {
      sessionsCount: sessions.length,
            sessions: sessions.map(s => {
              const startTime = toISOString(s.start_time);
              const endTime = toISOString(s.end_time);
        return {
          id: s.id,
          start_time: startTime,
          end_time: endTime,
          capacity: s.capacity,
          booked_count: s.booked_count,
          slotKey: `${startTime}|${endTime}`
        };
      }),
      confirmedSlotsCount: sessionSlots.size,
      confirmedSlotsArray: Array.from(sessionSlots),
      // Deliberately does not sample availableSlots. That was the only thing
      // in this effect that touched the prop, and every getAvailability
      // response is a freshly parsed array - so it changed identity on every
      // calendar load and re-entered this effect for a log line. Exactly the
      // false dependency removed from loadCalendarData.
    });
    // confirmedSlots.SIZE rather than the set. Every branch that writes here
    // now returns the previous reference when the content is unchanged, so
    // convergence does not depend on this choice - the primitive is an
    // optimisation that avoids a redundant pass, not the safety mechanism. An
    // earlier version of this comment claimed every branch was size-guarded;
    // the temporary-restore branch was not, and the guarantee rested entirely
    // on this one word.
  }, [
    sessions,
    opportunityId,
    confirmedSlots.size,
    isTemporary,
    getStoredConfirmedSlots,
    persistConfirmedSlots
  ]);

  // Cleanup persisted state when opportunity changes
  useEffect(() => {
    return () => {
      // Clean up persisted state when component unmounts
      try {
        sessionStorage.removeItem(getStorageKey('selected'));
        sessionStorage.removeItem(getStorageKey('confirmed'));
      } catch (error) {
        logger.warn('Failed to cleanup persisted slots', { errorMessage: String(error) });
      }
    };
    // getStorageKey is memoised on exactly [urlId, opportunityId], so this is
    // the same trigger as before, expressed through the thing actually used.
  }, [getStorageKey]);

  // Load calendar data
  const loadCalendarData = useCallback(async () => {
    if (disabled) return;
    
    try {
      setLoading(true);
      setIsUpdating(true);
      setError('');
      
      const startTime = startDate.toISOString();
      const actualEndTime = endDate.toISOString();
      
      // Validate date range before making API calls
      if (startDate >= endDate) {
        logger.error('Invalid date range: start date is not before end date');
        setError('Invalid date range: start date must be before end date');
        return;
      }
      
      // Load calendar events and availability in parallel
      // Only fetch availability if durationMinutes is selected
      const availabilityPromise = durationMinutes 
        ? getAvailability(startTime, actualEndTime, durationMinutes, undefined, excludeWeekends)
        : Promise.resolve({ available_slots: [], total_slots: 0, duration_minutes: 0, time_range: { start: '', end: '' } });
      
      // allSettled, NOT all (cto/AdaptaLabs#89).
      //
      // `/api/calendar/my-events` answers 404 `Calendar not connected` for
      // every user who has no token row, which in production is everyone: the
      // route that started the OAuth flow was deleted and login is Okta/OIDC.
      // Under Promise.all that 404 rejected the PAIR, so `setAvailableSlots`
      // never ran and the grid rendered "No available slots" on every column -
      // a researcher could not create a bookable slot through the UI at all,
      // while `/api/calendar/availability` (which needs no connected calendar)
      // had returned a full working-hours grid all along.
      //
      // The two are independent. Only the availability call can legitimately
      // empty this grid, so only its failure is an error.
      const [eventsSettled, availabilitySettled] = await Promise.allSettled([
        getMyCalendarEvents(startTime, actualEndTime),
        availabilityPromise
      ]);

      if (eventsSettled.status === 'fulfilled') {
        setCalendarEvents(eventsSettled.value);
        setCalendarStatus('connected');
        setCalendarConnectAvailable(false);
      } else {
        const reason = eventsSettled.reason as
          { response?: { status?: number; data?: { available?: boolean } } } | undefined;
        const status = reason?.response?.status;
        setCalendarConnectAvailable(reason?.response?.data?.available === true);
        // 404 is the backend's own "Calendar not connected"; anything else is a
        // fault. Both mean no conflict overlay, and they are NOT the same thing
        // to anyone diagnosing it - the distinction is kept for that reason and
        // mirrors how CalendarGrid already treats the participant side.
        setCalendarStatus(status === 404 ? 'not-connected' : 'unavailable');
        setCalendarEvents([]);
        logger.warn('Could not read the researcher calendar; continuing without conflict overlay', {
          component: 'AdminSessionManager',
          httpStatus: status,
          errorMessage: eventsSettled.reason instanceof Error
            ? eventsSettled.reason.message
            : String(eventsSettled.reason),
        });
      }

      if (availabilitySettled.status === 'rejected') {
        // Rethrown into this function's own catch so the one place that maps an
        // axios error to display text keeps doing it. Duplicating that mapping
        // here is how the two copies drift.
        throw availabilitySettled.reason;
      }

      const availabilityResult = availabilitySettled.value;
      setAvailableSlots(availabilityResult.available_slots);
      
      // Deliberately does NOT log the sessions prop. Reading it here made
      // `sessions` a dependency of this callback, which would change its
      // identity on every booking update and make the date-change effect below
      // fire a second calendar load each time - real API traffic to produce a
      // debug line. The sessions/slot correlation is logged by the sync effect
      // above, which genuinely depends on sessions.
      logger.debug('📅 Calendar data loaded:', {
        calendarStatus: eventsSettled.status === 'fulfilled' ? 'read' : 'unreadable',
        eventsCount: eventsSettled.status === 'fulfilled' ? eventsSettled.value.length : 0,
        availableSlotsCount: availabilityResult.available_slots.length,
        sampleAvailableSlots: availabilityResult.available_slots.slice(0, 3).map(slot => ({
          start: slot.start,
          end: slot.end,
          slotKey: `${slot.start}|${slot.end}`
        }))
      });
      
      // Reset pagination when new data is loaded
      setCurrentPage(0);
      
      // Auto-adjust daysPerPage to show all days for multi-row layout
      // Calculate the actual number of days that will be displayed (after filtering weekends if needed)
      let totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      
      if (excludeWeekends) {
        // Count only weekdays in the range
        let weekdayCount = 0;
        const tempCurrent = new Date(startDate);
        while (tempCurrent <= endDate) {
          const dayOfWeek = tempCurrent.getDay();
          if (dayOfWeek >= 1 && dayOfWeek <= 5) { // Monday to Friday
            weekdayCount++;
          }
          tempCurrent.setDate(tempCurrent.getDate() + 1);
        }
        totalDays = weekdayCount;
      }
      
      // Set daysPerPage to show all days, but cap at reasonable limits
      if (totalDays <= 5) {
        setDaysPerPage(totalDays);
      } else if (totalDays <= 10) {
        setDaysPerPage(totalDays); // Show all days for multi-row layout
      } else if (totalDays <= 14) {
        setDaysPerPage(14); // Use available dropdown option
      } else if (totalDays <= 21) {
        setDaysPerPage(21); // Use available dropdown option
      } else {
        setDaysPerPage(30); // Cap at maximum dropdown option
      }
      
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string }; statusText?: string }; message?: string };
      logger.error('Error loading calendar data', { 
        error: err instanceof Error ? err : undefined,
        errorMessage: err instanceof Error ? err.message : String(err) 
      });
      const errorMessage = axiosError.response?.data?.error || 
                          axiosError.response?.statusText || 
                          axiosError.message || 
                          'Failed to load calendar data';
      setError(errorMessage);
    } finally {
      setLoading(false);
      setIsUpdating(false);
    }
  }, [startDate, endDate, durationMinutes, excludeWeekends, disabled]);

  // Direct effect to watch for date changes.
  //
  // loadCalendarData is memoised on exactly the values this array used to
  // list, so this is the same set of triggers - but it can no longer drift
  // from them, which is the failure this rule is really guarding against.
  useEffect(() => {
    if (!disabled) {
      loadCalendarData();
    }
    // `disabled` stays listed even though loadCalendarData is memoised on it:
    // this effect's own body reads it, and the rule is right to want it. The
    // review suggested trimming it as redundant - it is not, and removing it
    // reintroduces a violation.
  }, [loadCalendarData, disabled]);

  // Refresh calendar data when sessions change (to reflect booking updates)
  useEffect(() => {
    if (sessions.length > 0 && !disabled) {
      // Small delay to ensure any external updates are processed
      const timeoutId = setTimeout(() => {
        loadCalendarData();
      }, 100);
      
      return () => clearTimeout(timeoutId);
    }
  }, [sessions, loadCalendarData, disabled]);

  // Manual slot entry. Date and time are kept as the raw input strings so an
  // incomplete pair simply disables the button rather than being coerced into
  // some nearby instant.
  const [manualDate, setManualDate] = useState('');
  const [manualTime, setManualTime] = useState('');
  const [manualError, setManualError] = useState('');

  /**
   * Every slot the grid should draw: whatever availability returned, plus the
   * hand-entered ones, deduplicated on slot identity.
   *
   * Manual slots are built at exactly `durationMinutes` long so they survive
   * CalendarView's duration filter. Building them at some other length would
   * put a slot in this array that silently never renders, which is a worse
   * failure than refusing to add it.
   */
  /**
   * Slot keys for every REAL session, whether or not availability generated a
   * slot at that instant.
   *
   * Without these, a session at an off-boundary time - the very thing the
   * manual control exists to create - was drawn only while its key happened to
   * be in this tab's sessionStorage. After a reload, or in another browser, a
   * 14:15 session was absent from the calendar entirely: the grid draws only
   * what is in `availableSlots`, and `getSessionForSlot` decorates a drawn slot
   * rather than creating one. Table view is read-only and the per-slot delete
   * needs a drawn slot, so the only way to remove it was Reset All - which
   * refuses outright once anything is booked.
   */
  const sessionSlotKeys = React.useMemo(() => {
    const keys = new Set<string>();
    sessions.forEach(session => {
      keys.add(`${toISOString(session.start_time)}|${toISOString(session.end_time)}`);
    });
    return keys;
  }, [sessions]);

  /**
   * What the researcher explicitly asked for, as opposed to what availability
   * generated. Survives the duration filter and wins the overlap prune.
   */
  const protectedSlotKeys = React.useMemo<ReadonlySet<string>>(
    () => new Set([...manualSlotKeys, ...sessionSlotKeys]),
    [manualSlotKeys, sessionSlotKeys]
  );

  /**
   * Every slot the grid should be handed: whatever availability returned, plus
   * the protected ones it did not include, deduplicated on slot identity.
   *
   * duration_minutes is derived from the pair rather than read from
   * `durationMinutes`, so a slot keeps the length it was created at even if the
   * researcher then changes the duration control.
   */
  const displaySlots = React.useMemo<AvailableSlot[]>(() => {
    const generated = availableSlots || [];
    const seen = new Set(generated.map(slotKeyOf));
    const extra = Array.from(protectedSlotKeys)
      .filter(key => !seen.has(key))
      .map(key => {
        const [start, end] = key.split('|');
        return {
          start,
          end,
          duration_minutes: Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000),
        };
      });
    return [...generated, ...extra];
  }, [availableSlots, protectedSlotKeys]);

  /**
   * What the grid will ACTUALLY draw, computed with the same functions the grid
   * uses. The counter below reports this rather than `displaySlots.length`,
   * which was pre-filter and pre-prune and read 21 on a grid drawing 20.
   */
  const drawnSlots = React.useMemo(() => {
    const onScreen = visibleDayKeys(startDate, endDate, excludeWeekends, currentPage, daysPerPage);
    return slotsToDraw(displaySlots, durationMinutes, protectedSlotKeys).filter(slot => {
      const when = new Date(slot.start);
      return !Number.isNaN(when.getTime()) && onScreen.has(when.toDateString());
    });
  }, [
    displaySlots,
    durationMinutes,
    protectedSlotKeys,
    startDate,
    endDate,
    excludeWeekends,
    currentPage,
    daysPerPage,
  ]);

  const handleAddManualSlot = useCallback(() => {
    setManualError('');

    if (!durationMinutes) {
      setManualError('Choose a timeslot duration first.');
      return;
    }
    if (!manualDate || !manualTime) {
      setManualError('Enter both a date and a start time.');
      return;
    }

    // Local wall-clock, matching every other time this screen shows. `new
    // Date('2026-08-28T14:00')` is local in every browser this app supports,
    // but the explicit component form cannot be misread as UTC by a reader.
    const [year, month, day] = manualDate.split('-').map(Number);
    const [hour, minute] = manualTime.split(':').map(Number);
    if ([year, month, day, hour, minute].some(part => Number.isNaN(part))) {
      setManualError('Enter both a date and a start time.');
      return;
    }

    const start = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (Number.isNaN(start.getTime())) {
      setManualError('Enter both a date and a start time.');
      return;
    }
    // UX-side arm of a rule the server now enforces: every session CREATE
    // route refuses a past start via `validateNewSessionData`
    // (backend/src/validation/schemas.ts, cto/AdaptaLabs#90). This check
    // stays for the message quality - a refusal the researcher sees before
    // submitting beats a 400 after - and is deliberately STRICTER than the
    // server's one-minute clock-skew grace: authoring a slot for "right now"
    // is never what a researcher means.
    if (start.getTime() <= Date.now()) {
      setManualError('Choose a time in the future.');
      return;
    }

    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    const slotKey = `${start.toISOString()}|${end.toISOString()}`;

    /*
     * Refused on OVERLAP, not merely on an exact duplicate.
     *
     * The overlap prune keeps one slot per span, so a hand-entered slot that
     * overlaps another protected slot - an existing session, or one added a
     * moment ago - loses or wins arbitrarily on start time and the loser is
     * dropped before rendering, while STILL being selected and still sent to
     * `createSessions`. Confirm then fails server-side (`checkSessionOverlaps`
     * throws and rolls back the whole batch) naming a time that appears nowhere
     * on the grid, and every later Confirm fails identically.
     *
     * Refusing here is what makes "added, selected, creatable, never drawn"
     * structurally impossible rather than merely unlikely. Adjacency is NOT
     * overlap: 14:45 may start exactly as 14:15-14:45 ends.
     */
    /*
     * Bounded to the hours the timeline draws, alongside the date window and
     * the weekend filter below - the third and last way a slot could be
     * "added, selected, creatable and never drawn" (cto/AdaptaLabs#89).
     *
     * Outside 07:00-23:00 `getTimePosition` clamps, so the slot renders at
     * height 0% on an edge. A zero-height div cannot be clicked, so the per-slot
     * delete cannot reach it, Table view is read-only, and Reset All refuses
     * once anything is booked - the session becomes unremovable from this
     * screen. 23:00 is the worst of them, because the timeline DRAWS a 23:00
     * label, so the hour reads as in range.
     *
     * The SAME predicate the gutter row classifies by (cto/AdaptaLabs#95), so
     * "what the entry gate refuses" and "what the gutter has to catch" cannot
     * drift apart: a slot refused here is exactly a slot the grid could not
     * have drawn had it arrived by another route.
     */
    const startHours = start.getHours() + start.getMinutes() / 60;
    if (isOutsideDrawableHours(start, end)) {
      // Two different refusals, because one message cannot serve both. At 60
      // minutes, 22:45 overruns the timeline - and telling the researcher to
      // "pick a time between 07:00 and 23:00" when 22:45 IS between them reads
      // as a bug in the form rather than a bound on the slot.
      const latestStartMinutes = TIMELINE_END_HOUR * 60 - durationMinutes;
      const latestStart =
        `${String(Math.floor(latestStartMinutes / 60)).padStart(2, '0')}:` +
        `${String(latestStartMinutes % 60).padStart(2, '0')}`;
      setManualError(
        startHours < TIMELINE_START_HOUR
          ? `The calendar starts at ${String(TIMELINE_START_HOUR).padStart(2, '0')}:00, so it cannot draw a slot before then.`
          : `A ${durationMinutes}-minute slot has to end by ${String(TIMELINE_END_HOUR).padStart(2, '0')}:00, so the latest start is ${latestStart}.`
      );
      return;
    }

    // This bound is enforced on ENTRY only, and deliberately so: it is the
    // message-quality arm, not the containment. A session outside the drawn
    // hours that reached the database another way - the create routes carry no
    // hour rule, and cannot, because the drawable window is the VIEWER's local
    // one - is drawn in the gutter row and can be removed there
    // (cto/AdaptaLabs#95). The sibling future-time note was resolved by
    // cto/AdaptaLabs#90: the server refuses a past start on every create route.

    const startMs = start.getTime();
    const endMs = end.getTime();
    const overlaps = (otherStart: number, otherEnd: number) =>
      otherStart < endMs && otherEnd > startMs;

    const clashingSession = sessions.find(session =>
      overlaps(new Date(session.start_time).getTime(), new Date(session.end_time).getTime())
    );
    if (clashingSession) {
      const identical =
        new Date(clashingSession.start_time).getTime() === startMs &&
        new Date(clashingSession.end_time).getTime() === endMs;
      // The clashing session's time is NAMED. A session outside the visible
      // window still blocks the add, and a refusal about a time visible nowhere
      // is the same complaint that produced the overlap gate in the first place.
      const clashStart = formatClockTime(clashingSession.start_time) ?? '';
      const clashEnd = formatClockTime(clashingSession.end_time) ?? '';
      setManualError(
        identical
          ? 'That slot already exists.'
          : `That overlaps an existing session at ${clashStart} - ${clashEnd}. Pick a time that does not.`
      );
      return;
    }

    const clashingManual = Array.from(manualSlotKeys).find(key => {
      const [otherStart, otherEnd] = key.split('|');
      return overlaps(new Date(otherStart).getTime(), new Date(otherEnd).getTime());
    });
    if (clashingManual) {
      setManualError('That overlaps a slot you already added. Pick a time that does not.');
      return;
    }

    // Always marked protected, even when it coincides exactly with a generated
    // slot. Skipping that was the third shape of the same defect: an unprotected
    // slot at a generated instant was then pruned away by a protected
    // neighbour, and stayed selected.
    setManualSlotKeys(prev => {
      const next = new Set([...prev, slotKey]);
      persistManualSlotKeys(next);
      return next;
    });

    // Added AND selected, so the existing confirm step creates it. Adding
    // without selecting would draw a slot the researcher then has to find and
    // click, which is the sort of half-step that reads as a bug.
    setSelectedSlots(prev => {
      const next = new Set([...prev, slotKey]);
      persistSelectedSlots(next);
      return next;
    });

    // The date is deliberately kept: adding several slots on one day is the
    // common case. The time is cleared because reusing it would create the
    // duplicate refused above.
    setManualTime('');

    // Weekend columns are suppressed by default, so a Saturday slot would be
    // added, selected, creatable - and never drawn. Turning the filter off is
    // the only way to show what the researcher just asked for; leaving it on
    // and silently hiding the slot is the same class of defect as the date
    // window below.
    const dayOfWeek = start.getDay();
    if (excludeWeekends && (dayOfWeek === 0 || dayOfWeek === 6)) {
      setExcludeWeekends(false);
    }

    // The grid draws days from startDate/endDate AND paginates them, so a slot
    // outside that window would be added, selected, creatable - and invisible.
    // Merely widening the range is not enough: a day three weeks out lands on
    // page four and is just as unseen. The window MOVES to a week beginning at
    // that day, which puts it on the first page by construction.
    const dayStart = new Date(start);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(start);
    dayEnd.setHours(23, 59, 59, 999);

    if (dayStart < startDate || dayEnd > endDate) {
      const weekEnd = new Date(dayStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      weekEnd.setHours(23, 59, 59, 999);
      setStartDate(dayStart);
      setEndDate(weekEnd);
      setCurrentPage(0);
    }
  }, [
    durationMinutes,
    manualDate,
    manualTime,
    manualSlotKeys,
    sessions,
    persistManualSlotKeys,
    persistSelectedSlots,
    startDate,
    endDate,
    excludeWeekends,
  ]);

  const handleSlotSelect = useCallback((slot: AvailableSlot) => {
    const slotKey = `${slot.start}|${slot.end}`;
    logger.debug('🔵 SLOT SELECTED:', { 
      slotKey, 
      currentSelectedSlots: Array.from(selectedSlots),
      opportunityId,
      urlId,
      isTemporary 
    });
    setSelectedSlots(prev => {
      const newSet = new Set([...prev, slotKey]);
      logger.debug('New selected slots', { slots: Array.from(newSet) });
      persistSelectedSlots(newSet);
      return newSet;
    });
  }, [selectedSlots, opportunityId, urlId, isTemporary, persistSelectedSlots]);

  const handleSlotDeselect = useCallback(async (slot: AvailableSlot) => {
    const slotKey = `${slot.start}|${slot.end}`;
    logger.debug('handleSlotDeselect called:', { 
      slotKey, 
      currentSelectedSlots: Array.from(selectedSlots),
      currentConfirmedSlots: Array.from(confirmedSlots),
      isInSelected: selectedSlots.has(slotKey),
      isInConfirmed: confirmedSlots.has(slotKey)
    });
    
    // Find the session for this slot (if it exists)
    const slotStart = new Date(slot.start);
    const slotEnd = new Date(slot.end);
    const session = sessions.find(s => {
      const sStart = new Date(s.start_time);
      const sEnd = new Date(s.end_time);
      const startDiff = Math.abs(slotStart.getTime() - sStart.getTime());
      const endDiff = Math.abs(slotEnd.getTime() - sEnd.getTime());
      const tolerance = 1000; // 1 second
      return startDiff <= tolerance && endDiff <= tolerance;
    });
    
    // If slot has an actual session (not a temp one), delete it from database
    if (session && session.id && !session.id.startsWith('temp-session-')) {
      try {
        logger.debug('Deleting session from database', { sessionId: session.id });
        const { deleteSession } = await import('../api/client');
        await deleteSession(session.id);
        
        // Remove session from the sessions array
        const updatedSessions = sessions.filter(s => s.id !== session.id);
        onSessionsChange(updatedSessions);
        logger.debug('Session deleted successfully');
      } catch (error: unknown) {
        const err = error as { response?: { data?: { error?: string }; status?: number } };
        const message = err.response?.data?.error ?? (error instanceof Error ? error.message : 'Failed to delete session. Please try again.');
        logger.error('Error deleting session', { error: err, statusCode: err.response?.status, message });
        setError(message);
      }
    }
    
    // Remove from both selected and confirmed slots
    setSelectedSlots(prev => {
      const newSet = new Set(prev);
      newSet.delete(slotKey);
      logger.debug('New selected slots after deselect', { slots: Array.from(newSet) });
      persistSelectedSlots(newSet);
      return newSet;
    });
    
    setConfirmedSlots(prev => {
      const newSet = new Set(prev);
      newSet.delete(slotKey);
      logger.debug('New confirmed slots after deselect', { slots: Array.from(newSet) });
      persistConfirmedSlots(newSet);
      return newSet;
    });

    // A hand-entered slot leaves the grid when it is deselected. A generated one
    // is redrawn by the next availability load whatever we do here, but a manual
    // one only exists because this component remembers it - so without this a
    // mistyped slot could be deselected and never removed.
    setManualSlotKeys(prev => {
      if (!prev.has(slotKey)) return prev;
      const newSet = new Set(prev);
      newSet.delete(slotKey);
      persistManualSlotKeys(newSet);
      return newSet;
    });
  }, [selectedSlots, confirmedSlots, sessions, onSessionsChange, persistSelectedSlots, persistConfirmedSlots, persistManualSlotKeys]);

  /**
   * Commit the pending selection into real (or temporary) sessions.
   *
   * Returns whether the commit succeeded, so the forward control can decide
   * whether to advance: "Confirm & continue" must NOT leave the step when the
   * commit was refused, or it reproduces the silent drop this replaced - the
   * whole point of row 6 is that a selection can no longer vanish on the way
   * to Review.
   */
  const handleCreateSessionsFromSelected = async (): Promise<boolean> => {
    if (selectedSlots.size === 0) {
      setError('Please select at least one time slot');
      return false;
    }

    // Validate opportunityId for non-temporary sessions
    if (!isTemporary && (!opportunityId || opportunityId.trim() === '')) {
      setError('Cannot create sessions: Opportunity ID is missing. Please save the opportunity first.');
      return false;
    }

    try {
      setLoading(true);
      setError('');

      // Convert selected slots to session data
      const sessionData: CreateSessionRequest[] = Array.from(selectedSlots).map(slotKey => {
        const [start, end] = slotKey.split('|');
        return {
          start_time: start,
          end_time: end,
          capacity: 1, // Default capacity, can be made configurable
          location_or_meet_link_optional: ''
        };
      });

      if (isTemporary) {
        // For temporary opportunities, create local sessions that will be saved later
        const tempSessions: Session[] = sessionData.map((session, index) => ({
          id: `temp-session-${Date.now()}-${index}`,
          opportunity_id: opportunityId || 'temp', // Use 'temp' as fallback
          start_time: session.start_time,
          end_time: session.end_time,
          capacity: session.capacity,
          booked_count: 0,
          location_or_meet_link_optional: session.location_or_meet_link_optional,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          remaining: session.capacity
        }));
        
        onSessionsChange([...sessions, ...tempSessions]);
        
        // Mark selected slots as confirmed
        setConfirmedSlots(prev => {
          const newSet = new Set([...prev, ...selectedSlots]);
          persistConfirmedSlots(newSet);
          return newSet;
        });
        setSelectedSlots(new Set());
        persistSelectedSlots(new Set());
        
        /*
         * The slots are confirmed and that is ALL that happens here.
         *
         * This block used to call the parent back to save the opportunity,
         * create the real sessions against the id that came back, and then
         * navigate to the dashboard - which made confirming a time slot the
         * commit point for a test or an interview, and made those two the only
         * types whose author never saw what they were about to create. C3 moved
         * the commit to the Review step for all five types, so a temporary
         * session stays temporary until the author gets there. The parent holds
         * these in `sessions` and its save writes them.
         */
        
        // Refresh calendar to show updated state immediately (before navigation)
        await loadCalendarData();
        return true;
      }

      // Note: We allow sessions from different opportunities to run simultaneously
      // Conflict checking for overlapping sessions within the same opportunity is handled by the backend
      // Different opportunities can have sessions at the same time (different admins, different studies)

      // Create sessions via API
      const createdSessions = await createSessions(opportunityId, sessionData);
      logger.debug('✅ Sessions created successfully:', {
        createdCount: createdSessions.length,
        createdSessions: createdSessions.map(s => ({
          id: s.id,
          start_time: s.start_time,
          end_time: s.end_time,
          capacity: s.capacity
        })),
        existingSessionsCount: sessions.length
      });
      
      onSessionsChange([...sessions, ...createdSessions]);
      
      /*
       * Nothing is saved here any more. In edit mode these sessions are real
       * the moment they are created, and the OPPORTUNITY is saved from the
       * Review step - so adding a time slot no longer commits an unrelated
       * half-finished edit to the title beside it.
       */
      
      // Mark selected slots as confirmed
      setConfirmedSlots(prev => {
        const newSet = new Set([...prev, ...selectedSlots]);
        persistConfirmedSlots(newSet);
        return newSet;
      });
      setSelectedSlots(new Set());
      persistSelectedSlots(new Set());

      // Refresh calendar to show updated state immediately
      await loadCalendarData();
      return true;

    } catch (err: unknown) {
      const axiosError = err as {
        response?: { data?: { error?: string; details?: string[] } };
        message?: string;
      };
      logger.error('Error creating sessions', {
        error: err instanceof Error ? err : undefined,
        errorMessage: err instanceof Error ? err.message : String(err)
      });
      // Prefer the per-item breakdown when the server sent one (#101): a
      // past-slot batch answers `details: ['Session 1: Start time must not be
      // in the past', ...]`, which names the rule, over the bare
      // `error: 'Validation failed'`.
      const data = axiosError.response?.data;
      const message =
        data?.details && data.details.length > 0
          ? data.details.join(' ')
          : data?.error || 'Failed to create sessions';
      setError(message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  /**
   * The forward control's behaviour when a selection is still pending (row 6).
   *
   * It used to call `onContinue` directly, which advanced to Review while the
   * uncommitted `selectedSlots` were simply discarded - "1 slot selected"
   * became "0 slots" on the next step. Now it commits first and only advances
   * if that succeeded, so the selection is kept rather than dropped. A refused
   * commit (a past slot, an overlap, a server error) keeps the author on this
   * step in front of the reason.
   */
  const handleConfirmAndContinue = async () => {
    if (!onContinue) return;
    if (selectedSlots.size > 0) {
      const committed = await handleCreateSessionsFromSelected();
      if (!committed) return;
    }
    onContinue();
  };

  const handleClearSelected = () => {
    setSelectedSlots(new Set());
    setConfirmedSlots(new Set());
    setManualSlotKeys(new Set());
    persistSelectedSlots(new Set());
    persistConfirmedSlots(new Set());
    persistManualSlotKeys(new Set());
  };

  /**
   * Remove ONE session from the list (row 6).
   *
   * The list is a management surface now, not a read-only table, so it needs a
   * per-row removal - it is also the only removal that reaches a session the
   * grid cannot draw (an off-hours one, cto/AdaptaLabs#95) without hunting for
   * its gutter chip. Refuses a booked session for the same reason Reset All
   * does: deleting it would strand the participant who booked it. A real
   * session is deleted server-side; a temporary one (not yet saved) is just
   * dropped from the array.
   */
  const handleRemoveSession = useCallback(async (session: Session) => {
    setError('');
    if (session.booked_count > 0) {
      setError(
        `That session has ${session.booked_count} booking${session.booked_count === 1 ? '' : 's'} ` +
        `and cannot be removed. Cancel the booking${session.booked_count === 1 ? '' : 's'} first.`
      );
      return;
    }

    const isTemp = session.id.startsWith('temp-session-');
    if (!isTemp) {
      try {
        setLoading(true);
        const { deleteSession } = await import('../api/client');
        await deleteSession(session.id);
      } catch (error: unknown) {
        const err = error as { response?: { data?: { error?: string }; status?: number } };
        const message = err.response?.data?.error
          ?? (error instanceof Error ? error.message : 'Failed to remove the session. Please try again.');
        logger.error('Error removing session', { error: err, statusCode: err.response?.status, message });
        setError(message);
        return;
      } finally {
        setLoading(false);
      }
    }

    onSessionsChange(sessions.filter(s => s.id !== session.id));

    // Drop any lingering selection/confirmation/manual key for this slot, so a
    // removed session cannot linger as a ghost in the grid's confirmed set.
    const slotKey = `${toISOString(session.start_time)}|${toISOString(session.end_time)}`;
    setSelectedSlots(prev => {
      if (!prev.has(slotKey)) return prev;
      const next = new Set(prev); next.delete(slotKey); persistSelectedSlots(next); return next;
    });
    setConfirmedSlots(prev => {
      if (!prev.has(slotKey)) return prev;
      const next = new Set(prev); next.delete(slotKey); persistConfirmedSlots(next); return next;
    });
    setManualSlotKeys(prev => {
      if (!prev.has(slotKey)) return prev;
      const next = new Set(prev); next.delete(slotKey); persistManualSlotKeys(next); return next;
    });
  }, [sessions, onSessionsChange, persistSelectedSlots, persistConfirmedSlots, persistManualSlotKeys]);

  const handleResetAllSessions = () => {
    // Always allow reset if there are any visual states or sessions
    if (sessions.length === 0 && selectedSlots.size === 0 && confirmedSlots.size === 0) {
      // Even if state shows zero, if there are visually assigned slots, allow reset
      logger.debug('No state found, but allowing reset to clear visual state');
    }

    // Check if any sessions have bookings
    const sessionsWithBookings = sessions.filter(session => session.booked_count > 0);
    if (sessionsWithBookings.length > 0) {
      setError(`Cannot reset sessions with existing bookings. ${sessionsWithBookings.length} session(s) have bookings.`);
      return;
    }

    setShowResetConfirmation(true);
  };

  const confirmResetAllSessions = async () => {
    try {
      setLoading(true);
      setError('');

      // If there are actual sessions, delete them from the backend
      if (sessions.length > 0) {
        const result = await deleteAllSessions(opportunityId);
        logger.debug(result.message);
      }
      
      // Update the sessions list to empty
      onSessionsChange([]);
      
      // Clear all slot states
      setSelectedSlots(new Set());
      setConfirmedSlots(new Set());
      setManualSlotKeys(new Set());
      persistSelectedSlots(new Set());
      persistConfirmedSlots(new Set());
      persistManualSlotKeys(new Set());
      
      // Refresh calendar to show updated state
      await loadCalendarData();
      
    } catch (error: unknown) {
      const axiosError = error as { response?: { data?: { error?: string } }; message?: string };
      logger.error('Error resetting sessions', { 
        error: error instanceof Error ? error : undefined,
        errorMessage: error instanceof Error ? error.message : String(error) 
      });
      if (axiosError.response?.data?.error) {
        setError(axiosError.response.data.error);
      } else {
        setError('Failed to reset sessions');
      }
    } finally {
      setLoading(false);
      setShowResetConfirmation(false);
    }
  };

  const cancelResetAllSessions = () => {
    setShowResetConfirmation(false);
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  return (
    <div className="admin-session-manager border-none">
      <style>
        {`
          .admin-session-manager .form-control,
          .admin-session-manager .form-select,
          .admin-session-manager .form-control-sm {
            background-color: rgba(255, 255, 255, 0.05) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            color: #E0E0E0 !important;
          }
          .admin-session-manager .form-control:focus,
          .admin-session-manager .form-select:focus {
            background-color: rgba(255, 255, 255, 0.08) !important;
            border-color: #FF4E50 !important;
            color: #E0E0E0 !important;
            box-shadow: 0 0 0 0.2rem rgba(255, 78, 80, 0.25) !important;
          }
          .admin-session-manager .form-control::placeholder {
            color: rgba(224, 224, 224, 0.5) !important;
          }
          .admin-session-manager .form-select option {
            background-color: #0A091A !important;
            color: #E0E0E0 !important;
          }
          .admin-session-manager .text-muted {
            color: rgba(224, 224, 224, 0.7) !important;
          }
          .admin-session-manager .card {
            background-color: rgba(255, 255, 255, 0.05) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
          }
          .admin-session-manager .card-body {
            background-color: transparent !important;
          }
        `}
      </style>

      {error && (
        <div className="alert alert-danger" role="alert">
          <AlertTriangle size={18} className="me-2" />
          {error}
        </div>
      )}

      {/*
        cto/AdaptaLabs#89. The slots below come from the availability endpoint,
        which knows nothing about this researcher's diary - so when their
        calendar cannot be read, the grid is a list of times that LOOK checked
        and are not. Saying so is the whole point: silence here is how "the
        calendar is connected" gets believed. Not an error - authoring works
        perfectly well without it, which is why this is not the red alert above.
      */}
      {calendarStatus === 'not-connected' && (
        <div className="alert alert-info d-flex align-items-center flex-wrap gap-2" role="alert">
          <span>
            <Info size={18} className="me-2" />
            Your calendar is not connected, so these slots have not been checked against
            your own commitments. You can still create them.
          </span>
          {/*
            Offered ONLY when the deployment can actually start the flow. With no
            Google OAuth client configured, /api/calendar/auth/connect answers
            503 - and the demo-mode consent URL it would otherwise build points
            back at our own callback and mints fabricated tokens, so a button
            that "worked" would leave the researcher trusting invented busy time.
          */}
          {calendarConnectAvailable && (
            <a className="btn btn-sm btn-outline-primary ms-auto" href={calendarConnectUrl()}>
              <CalendarDays size={14} className="me-1" />
              Connect your calendar
            </a>
          )}
        </div>
      )}

      {calendarStatus === 'unavailable' && (
        <div className="alert alert-warning" role="alert">
          <AlertTriangle size={18} className="me-2" />
          Your calendar could not be read, so these slots have not been checked against
          your own commitments. You can still create them.
        </div>
      )}

      {disabled && !isTemporary && !opportunityId && (
        <div className="alert alert-info" role="alert">
          <Info size={18} className="me-2" />
          Please wait while the opportunity loads, or save the opportunity first before adding sessions.
        </div>
      )}

      {/* Reset Confirmation Modal */}
      {showResetConfirmation && (
        <div className="modal show d-block modal-backdrop-overlay">
          <div className="modal-dialog">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">
                  <AlertTriangle size={16} className="text-warning me-2" />
                  Confirm Reset All Sessions
                </h5>
                <button
                  type="button"
                  className="btn-close"
                  onClick={cancelResetAllSessions}
                  disabled={loading}
                ></button>
              </div>
              <div className="modal-body">
                <p>Are you sure you want to delete all {sessions.length} session(s) for this opportunity?</p>
                <div className="alert alert-warning">
                  <Info size={18} className="me-2" />
                  <strong>This action cannot be undone.</strong> All session data will be permanently deleted.
                </div>
                <p className="mb-0">
                  <strong>Sessions to be deleted:</strong>
                </p>
                <ul className="list-unstyled mt-2">
                  {sessions.slice(0, 5).map((session) => (
                    <li key={session.id} className="text-muted">
                      <small>
                        {formatDateTime(session.start_time)} – {formatDateTime(session.end_time)}
                        {' '}({session.capacity} slots)
                      </small>
                    </li>
                  ))}
                  {sessions.length > 5 && (
                    <li className="text-muted">
                      <small>... and {sessions.length - 5} more session(s)</small>
                    </li>
                  )}
                </ul>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={cancelResetAllSessions}
                  disabled={loading}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={confirmResetAllSessions}
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 size={14} className="me-2" />
                      Delete All Sessions
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="calendar-mode">

          {/* The calendar's own controls - date range, duration, manual entry -
              belong to the grid, so they only appear with it (row 6). In the
              list view they were noise stacked above a read-only table; the
              list reaches the grid through its own "Add slots" button instead. */}
          {viewMode === 'grid' && (
            <>
          {/* Calendar Controls */}
          <div className="calendar-control-panel">
            <div className="control-panel-row">
              <div className="form-field-compact">
                <label className="form-label-compact" htmlFor="calendarStartDate">
                  Start Date
                </label>
                <input
                  id="calendarStartDate"
                  type="date"
                  className="form-control form-control-sm"
                  value={toDateInputValue(startDate)}
                  // The server refuses a session that starts in the past (#90),
                  // so the picker must not offer a past day (#101). Intra-day
                  // past times are greyed in the grid below; this bounds the day.
                  min={toDateInputValue(new Date())}
                  onChange={(e) => {
                    const [year, month, day] = e.target.value.split('-');
                    const newDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), 0, 0, 0);

                    // Validate that start date is not after end date
                    if (newDate <= endDate) {
                      setStartDate(newDate);
                    } else {
                      logger.warn('Start date cannot be after end date');
                    }
                  }}
                  disabled={disabled}
                />
              </div>
              <div className="form-field-compact">
                <label className="form-label-compact" htmlFor="calendarEndDate">
                  End Date
                </label>
                <input
                  id="calendarEndDate"
                  type="date"
                  className="form-control form-control-sm"
                  value={toDateInputValue(endDate)}
                  onChange={(e) => {
                    const [year, month, day] = e.target.value.split('-');
                    const newDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), 23, 59, 59);
                    
                    // Validate that end date is not before start date
                    if (newDate >= startDate) {
                      setEndDate(newDate);
                    } else {
                      logger.warn('End date cannot be before start date');
                    }
                  }}
                  disabled={disabled}
                />
              </div>
              <div className="form-field-compact-sm">
                <label className="form-label-compact" htmlFor="timeslotDuration">
                  Timeslot (mins)
                </label>
                <select
                  id="timeslotDuration"
                  className="form-control form-control-sm"
                  value={durationMinutes || ''}
                  onChange={(e) => {
                    const value = e.target.value === '' ? undefined : parseInt(e.target.value);
                    setDurationMinutes(value);
                  }}
                  disabled={disabled}
                >
                  <option value="">Please select</option>
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="45">45 minutes</option>
                  <option value="60">60 minutes</option>
                </select>
              </div>
              <div className="form-field-compact-xs">
                <label className="form-label-compact">
                  Days/Page
                </label>
                <select
                  className="form-control form-control-sm"
                  value={daysPerPage}
                  onChange={(e) => {
                    setDaysPerPage(parseInt(e.target.value));
                    setCurrentPage(0); // Reset to first page
                  }}
                  disabled={disabled}
                >
                  <option value={3}>3</option>
                  <option value={5}>5</option>
                  <option value={7}>7</option>
                  <option value={9}>9</option>
                  <option value={10}>10</option>
                  <option value={14}>14</option>
                  <option value={21}>21</option>
                  <option value={30}>30</option>
                </select>
              </div>
              <div className="form-field-compact d-flex align-items-center pt-4">
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="includeWeekends"
                    checked={!excludeWeekends}
                    onChange={(e) => setExcludeWeekends(!e.target.checked)}
                    disabled={disabled}
                  />
                  <label className="form-check-label form-check-label-compact" htmlFor="includeWeekends">
                    Include weekends
                  </label>
                </div>
              </div>
              <div className="control-panel-end">
                <small className="control-panel-counter">
                  {drawnSlots.length} slots available
                </small>
              </div>
            </div>
          </div>

          {/* Manual slot entry (cto/AdaptaLabs#89 item 2) */}
          <div className="calendar-control-panel mb-2">
            <div className="control-panel-row">
              <div className="form-field-compact">
                <label className="form-label-compact" htmlFor="manualSlotDate">
                  Add a slot: date
                </label>
                <input
                  id="manualSlotDate"
                  type="date"
                  className="form-control form-control-sm"
                  value={manualDate}
                  onChange={(e) => {
                    // Cleared here, not only on the next Add: a refusal that
                    // survives the correction reads as a second refusal.
                    setManualError('');
                    setManualDate(e.target.value);
                  }}
                  disabled={disabled}
                />
              </div>
              <div className="form-field-compact-sm">
                <label className="form-label-compact" htmlFor="manualSlotTime">
                  Start time
                </label>
                <input
                  id="manualSlotTime"
                  type="time"
                  className="form-control form-control-sm"
                  value={manualTime}
                  onChange={(e) => {
                    setManualError('');
                    setManualTime(e.target.value);
                  }}
                  disabled={disabled}
                />
              </div>
              <div className="form-field-compact d-flex align-items-center pt-4">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  onClick={handleAddManualSlot}
                  disabled={disabled || !manualDate || !manualTime || !durationMinutes}
                  title="Add this time as a selected slot, without using the calendar"
                >
                  <Plus size={14} className="me-1" />
                  Add slot
                </button>
              </div>
              <div className="control-panel-end">
                <small className="text-muted">
                  {durationMinutes
                    ? `${durationMinutes} minutes long, in your own timezone`
                    : 'Choose a timeslot duration first'}
                </small>
              </div>
            </div>
            {manualError && (
              <div className="alert alert-warning mt-2 mb-0 py-2" role="alert">
                <AlertTriangle size={14} className="me-2" />
                {manualError}
              </div>
            )}
          </div>
            </>
          )}

          {/* View Switcher */}
          <div className="control-panel-subtle mb-2">
            <div className="d-flex align-items-center gap-3">
              {/* Segmented Control for View Mode */}
              <div className="segmented-control">
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  disabled={disabled}
                  className={`segmented-control-btn ${viewMode === 'grid' ? 'active' : ''}`}
                >
                  <LayoutGrid size={12} />
                  Calendar
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  disabled={disabled}
                  className={`segmented-control-btn ${viewMode === 'list' ? 'active' : ''}`}
                >
                  <List size={12} />
                  Table
                </button>
              </div>

              {/* Ghost Refresh Button - reloads the availability grid, so it
                  only belongs with the grid (row 6). In the list view it
                  reloaded nothing the view showed. */}
              {viewMode === 'grid' && (
                <button
                  type="button"
                  onClick={loadCalendarData}
                  disabled={disabled || loading}
                  title="Refresh calendar to see latest booking status"
                  className="btn-ghost"
                >
                  <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                  Refresh
                </button>
              )}

              {/* Reset Button - pushed to right */}
              <button
                type="button"
                onClick={() => {
                  logger.debug('Reset button clicked. Current state:', {
                    sessionsLength: sessions.length,
                    selectedSlotsSize: selectedSlots.size,
                    confirmedSlotsSize: confirmedSlots.size,
                    disabled: disabled,
                    loading: loading
                  });
                  handleResetAllSessions();
                }}
                disabled={disabled || loading}
                title="Delete all sessions (only if no bookings exist)"
                className="btn-ghost-danger ms-auto"
              >
                <Trash2 size={11} />
                Reset All
              </button>
            </div>
          </div>

          {/* Calendar View */}
          <div className="card card-glass mb-3">
            <div className="card-body">
              {loading || isUpdating ? (
                <div className="text-center py-4">
                  <div className="spinner-border text-primary" role="status">
                    <span className="visually-hidden">Loading calendar...</span>
                  </div>
                  <div className="mt-2 text-muted">Fetching calendar data...</div>
                </div>
              ) : viewMode === 'grid' ? (
                <div>
                  {!durationMinutes && (
                    <div className="alert alert-info mb-3" role="alert">
                      <Info size={18} className="me-2" />
                      Please select a timeslot duration (15, 30, 45, or 60 minutes) to view available slots.
                    </div>
                  )}
                  <CalendarView
                    key={`calendar-${startDate.toISOString()}-${endDate.toISOString()}-${sessions.length}`}
                    events={calendarEvents}
                    availableSlots={displaySlots}
                    protectedSlotKeys={protectedSlotKeys}
                    selectedSlots={selectedSlots}
                    confirmedSlots={confirmedSlots}
                    onSlotSelect={handleSlotSelect}
                    onSlotDeselect={handleSlotDeselect}
                    durationMinutes={durationMinutes}
                    currentPage={currentPage}
                    onPageChange={handlePageChange}
                    daysPerPage={daysPerPage}
                    startDate={startDate}
                    endDate={endDate}
                    excludeWeekends={excludeWeekends}
                    sessions={sessions}
                  />
                </div>
              ) : (
                <ListView
                  key={`list-${sessions.length}`}
                  sessions={sessions}
                  isTemporary={isTemporary}
                  onRemove={handleRemoveSession}
                  onAddSlots={() => setViewMode('grid')}
                  disabled={disabled}
                  loading={loading}
                />
              )}
            </div>
          </div>

          {/*
            Selected-slots action bar (row 6 rework).

            The controls used to sit in a row with "Clear Selection" absolutely
            centred over the top of Back and Continue, so it painted across the
            forward button. This is a single wrapping flex row instead: Back on
            the left, everything else pushed right by a spacer, nothing
            overlapping. And the forward control is "Confirm & continue", which
            commits the pending selection before advancing - the bare "Continue"
            here dropped it silently.
          */}
          {selectedSlots.size > 0 && (
            <div className="mb-3">
              <div className="selection-actions-panel">
                {/* Slots selected indicator */}
                <div className="selection-summary-count">
                  <strong>{selectedSlots.size}</strong> slot{selectedSlots.size !== 1 ? 's' : ''} selected
                </div>

                <div className="selection-actions-row">
                  {/* Back - left aligned */}
                  {onBack && (
                    <button
                      type="button"
                      className="btn btn-outline-secondary btn-sm"
                      onClick={onBack}
                      disabled={disabled || loading}
                    >
                      <ArrowLeft size={16} className="me-2" />
                      {backLabel}
                    </button>
                  )}

                  {/* Spacer: pushes the confirm/continue cluster to the right
                      without absolute positioning, so nothing overlaps. */}
                  <div className="selection-actions-spacer" />

                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    onClick={handleClearSelected}
                    disabled={disabled}
                  >
                    Clear Selection
                  </button>

                  {/*
                    Said "Create Opportunity" while this button WAS the commit
                    point. It no longer creates the opportunity - Review does -
                    so it names what it actually does: on a new opportunity the
                    slots are held until Review saves, on an existing one they
                    are created immediately. It stays on this step so more slots
                    can be added.
                  */}
                  <button
                    type="button"
                    className="btn btn-success btn-sm min-w-180"
                    onClick={handleCreateSessionsFromSelected}
                    disabled={disabled || loading}
                  >
                    {loading ? 'Confirming...' : 'Confirm selected slots'}
                  </button>

                  {onContinue && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={handleConfirmAndContinue}
                      disabled={disabled || loading}
                    >
                      {confirmAndContinueLabel}
                      <ArrowRight size={16} className="ms-2" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/*
            The step's own action row when no slots are selected.
            Both controls, not just Back: an author who booked their slots
            earlier, or who means to come back to them, still has to be able to
            reach Review - and while this step was terminal there was nothing
            here but Back.
          */}
          {!selectedSlots.size && (onBack || onContinue) && (
            <div className="mt-4 d-flex justify-content-between align-items-center gap-2">
              {onBack ? (
                <button
                  type="button"
                  className="btn btn-outline-secondary px-5 py-2 fw-semibold"
                  onClick={onBack}
                  disabled={disabled || loading}
                >
                  <ArrowLeft size={16} className="me-2" />
                  {backLabel}
                </button>
              ) : (
                <div style={{ flex: 1 }}></div>
              )}
              {onContinue && (
                <button
                  type="button"
                  className="btn btn-primary px-5 py-2 fw-semibold"
                  onClick={onContinue}
                  disabled={disabled || loading}
                >
                  {continueLabel}
                  <ArrowRight size={16} className="ms-2" />
                </button>
              )}
            </div>
          )}
        </div>

    </div>
  );
};

export default AdminSessionManager;
