import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Session, CreateSessionRequest, CalendarEvent, AvailableSlot } from '../api/types';
import { getCalendarEvents, getAvailability } from '../api/client';
import { createSessions, deleteAllSessions } from '../api/client';
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
  ArrowLeft 
} from 'lucide-react';

interface AdminSessionManagerProps {
  opportunityId: string;
  sessions: Session[];
  onSessionsChange: (sessions: Session[]) => void;
  defaultDurationMinutes: number;
  disabled?: boolean;
  isTemporary?: boolean;
  onOpportunitySave?: () => Promise<string | undefined>; // New prop for saving opportunity, returns opportunity ID
  onBack?: () => void; // Prop for back navigation
  onNavigate?: (path: string) => void; // Prop for navigation (avoids full page reload)
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
}

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
  sessions
}) => {
  const formatTime = (dateString: string) => {
    // Ensure consistent UTC time formatting
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC' // Force UTC to ensure consistency
    });
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  };

  const isSlotSelected = (slot: AvailableSlot) => {
    const slotKey = `${slot.start}|${slot.end}`;
    return selectedSlots.has(slotKey);
  };

  const isSlotConfirmed = (slot: AvailableSlot) => {
    // Slot times are ISO strings per type definition
    // Convert to string safely (handles both string and Date at runtime)
    const slotStart = typeof slot.start === 'string' ? slot.start : (slot.start as any)?.toISOString() || String(slot.start);
    const slotEnd = typeof slot.end === 'string' ? slot.end : (slot.end as any)?.toISOString() || String(slot.end);
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

  // Generate all days in the selected range (UTC)
  const generateDaysInRange = (): Date[] => {
    const days: Date[] = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    
    // Simple approach: just iterate through the date range and filter weekends if needed
    while (current <= end) {
      if (excludeWeekends) {
        const dayOfWeek = current.getUTCDay(); // Use UTC
        // Only include weekdays (Monday = 1, Tuesday = 2, ..., Friday = 5)
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          days.push(new Date(current));
        }
      } else {
        days.push(new Date(current));
      }
      current.setUTCDate(current.getUTCDate() + 1); // Use UTC
    }
    return days;
  };

  const allDays = generateDaysInRange();
  
  // Calculate pagination based on days
  const totalPages = Math.ceil(allDays.length / daysPerPage);
  const startDayIndex = currentPage * daysPerPage;
  const endDayIndex = startDayIndex + daysPerPage;
  const currentDays = allDays.slice(startDayIndex, endDayIndex);
  
  // Determine if we need a multi-row layout (more than 5 days)
  const needsMultiRow = currentDays.length > 5;
  const firstRowDays = needsMultiRow ? currentDays.slice(0, 5) : currentDays;
  const secondRowDays = needsMultiRow ? currentDays.slice(5) : [];
  
  // Use consistent column count for both rows (always 5 columns max for visual consistency)
  const maxColumnsPerRow = 5;
  
  // Helper function to remove overlapping slots - keeps only non-overlapping slots
  // This function aggressively removes any slots that share any time overlap
  const removeOverlappingSlots = (slots: AvailableSlot[]): AvailableSlot[] => {
    if (slots.length === 0) return slots;
    
    // Convert all slots to timestamp format first for accurate comparison
    const slotRanges = slots.map(slot => {
      const start = new Date(slot.start).getTime();
      const end = new Date(slot.end).getTime();
      return {
        slot,
        start,
        end,
        // Create a unique key for exact duplicate detection
        key: `${start}|${end}`
      };
    });
    
    // First, remove exact duplicates by time (not string) - use Map to ensure uniqueness
    const uniqueByTime = new Map<string, typeof slotRanges[0]>();
    slotRanges.forEach(range => {
      if (!uniqueByTime.has(range.key)) {
        uniqueByTime.set(range.key, range);
      }
    });
    const uniqueSlots = Array.from(uniqueByTime.values());
    
    // Sort by start time, then by end time (shorter slots first if same start)
    uniqueSlots.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return a.end - b.end;
    });
    
    const nonOverlapping: AvailableSlot[] = [];
    
    uniqueSlots.forEach(current => {
      // Check if this slot overlaps with any already added slot
      // Two slots overlap if they share ANY time (even a millisecond)
      // Adjacent slots (one ends exactly when another starts) do NOT overlap
      const hasOverlap = nonOverlapping.some(added => {
        const addedStart = new Date(added.start).getTime();
        const addedEnd = new Date(added.end).getTime();
        
        // Overlap occurs when they share time, but NOT when one ends exactly when another starts
        // Use exact millisecond comparison for precision
        const isAdjacent = (current.start === addedEnd) || (current.end === addedStart);
        const hasTimeOverlap = (current.start < addedEnd && current.end > addedStart);
        
        return hasTimeOverlap && !isAdjacent;
      });
      
      // Only add if no overlap found
      if (!hasOverlap) {
        nonOverlapping.push(current.slot);
      }
    });
    
    return nonOverlapping;
  };

  // Filter slots to only include those that match the selected duration (if duration is selected)
  const durationFilteredSlots = durationMinutes 
    ? (availableSlots || []).filter(slot => {
        const slotStart = new Date(slot.start).getTime();
        const slotEnd = new Date(slot.end).getTime();
        const slotDurationMs = slotEnd - slotStart;
        const slotDurationMinutes = slotDurationMs / (1000 * 60);
        
        // Strictly match the duration - allow only very small tolerance for rounding (within 30 seconds)
        const toleranceMinutes = 0.5; // 30 seconds tolerance
        const matchesDuration = Math.abs(slotDurationMinutes - durationMinutes) <= toleranceMinutes;
        
        if (!matchesDuration) {
          console.log(`🔍 Filtered out slot with duration ${slotDurationMinutes.toFixed(2)}min (expected ${durationMinutes}min):`, {
            start: slot.start,
            end: slot.end,
            duration: slotDurationMinutes
          });
        }
        
        return matchesDuration;
      })
    : (availableSlots || []);
  
  // Remove overlapping slots first, before grouping by date
  const cleanedSlots = removeOverlappingSlots(durationFilteredSlots);
  
  // Filtered slots ready (debug logging removed for production)
  
  // Group all slots by date first (UTC)
  const allSlotsByDate = cleanedSlots.reduce((acc, slot) => {
    const date = new Date(slot.start).toDateString(); // slot.start is already UTC from backend
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(slot);
    return acc;
  }, {} as Record<string, AvailableSlot[]>);

  // Helper function to get slots for specific days (UTC)
  const getSlotsForDays = (days: Date[]) => {
    return days.reduce((acc: Record<string, AvailableSlot[]>, day: Date) => {
      const dateString = day.toDateString(); // day is already UTC
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
    return date.getUTCHours() + (date.getUTCMinutes() / 60); // Returns hour as decimal (e.g., 9.5 for 9:30)
  };

  // Helper function to calculate position percentage (7am = 0%, 11pm = 100%)
  const getTimePosition = (hour: number): number => {
    const startHour = 7; // 7 AM
    const endHour = 23; // 11 PM
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
    
    for (let hour = 7; hour <= 23; hour++) {
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
  const renderDayColumns = (slotsByDate: Record<string, AvailableSlot[]>, days: Date[], maxColumns: number = 5) => {
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
        let nonOverlappingSlots = removeOverlappingSlots(rawSlots);
        
        // Final deduplication pass using a Set to ensure absolute uniqueness by time
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
            console.warn(`🔍 DUPLICATE SLOT REMOVED:`, { 
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
          console.warn(`⚠️ Found ${duplicateKeys.size} duplicate slot(s) for ${dateString}:`, Array.from(duplicateKeys));
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
                    <h6 className="calendar-day-title">
                      {formatDate(column.date)}
                    </h6>
                    <small className="calendar-day-sessions">
                      {column.slots.length} slot{column.slots.length !== 1 ? 's' : ''}
                    </small>
                  </div>
            
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
                      (() => {
                        // Final safety check: filter out any remaining duplicates before rendering
                        const renderedKeys = new Set<string>();
                        const slotsToRender = column.slots.filter((slot, idx) => {
                          const slotKey = `${slot.start}|${slot.end}`;
                          if (renderedKeys.has(slotKey)) {
                            console.error(`🚨 CRITICAL: Filtering duplicate slot at render (index ${idx}):`, {
                              slotKey,
                              start: slot.start,
                              end: slot.end,
                              totalSlots: column.slots.length
                            });
                            return false;
                          }
                          renderedKeys.add(slotKey);
                          return true;
                        });
                        
                        return slotsToRender.map((slot, slotIndex) => {
                          // Create a truly unique key based on time (not index) to prevent duplicate rendering
                          // Use the exact same key format as selection tracking
                          const slotKey = `${slot.start}|${slot.end}`;
                          const uniqueKey = slotKey; // Use consistent key format
                          
                          const isSelected = isSlotSelected(slot);
                        const isConfirmed = isSlotConfirmed(slot);
                        const isBusy = isSlotBusy(slot);
                        const isAllocated = isSlotAllocated(slot);
                        const session = getSessionForSlot(slot);
                        
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
                            console.warn('⚠️ Found sessions close to slot but not matched:', {
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
                        
                        // Slot height calculation
                        if (roundedHeight > 5) {
                          console.warn(`⚠️ UNUSUALLY LARGE SLOT HEIGHT: ${roundedHeight}% for slot ${slot.start} to ${slot.end}`, {
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
                        
                        // Determine slot styling based on session status
                        // Use CSS classes for consistent styling with user calendar
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
                        } else {
                          // Available slot - matches user calendar ghost style
                          slotClass += ' calendar-slot-admin-available';
                        }

                        return (
                          <div
                            key={uniqueKey}
                            className={`${slotClass} position-absolute`}
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
                              pointerEvents: 'auto'
                            }}
                        title={(() => {
                          try {
                            const session = getSessionForSlot(slot);
                            const startTime = formatTime(slot.start);
                            const endTime = formatTime(slot.end);
                            const timeSpan = `${startTime} to ${endTime}`;
                            
                            let tooltipText = timeSpan;
                            if (session) {
                              tooltipText += ` - Session: ${session.capacity} capacity, ${session.booked_count} booked, ${session.remaining} remaining`;
                            } else if (isBusy) {
                              tooltipText += ` - This time slot conflicts with existing calendar events`;
                            } else if (isAllocated) {
                              tooltipText += ` - This slot is allocated to another opportunity`;
                            } else if (isSelected) {
                              tooltipText += ` - Selected for session creation`;
                            } else if (isConfirmed) {
                              tooltipText += ` - Session confirmed`;
                            } else {
                              tooltipText += ` - Available time slot`;
                            }
                            return tooltipText;
                          } catch (error) {
                            console.error('Error formatting tooltip:', error, slot);
                            return `${slot.start} to ${slot.end}`;
                          }
                        })()}
                        onClick={() => {
                          console.log('Slot clicked:', {
                            slotKey: `${slot.start}|${slot.end}`,
                            slotIndex,
                            isSelected,
                            isConfirmed,
                            isBusy,
                            isAllocated,
                            hasSession: !!session,
                            sessionId: session?.id
                          });
                          
                          // Allow clicking on free slots, selected slots, confirmed slots, and existing sessions
                          // Prevent clicking on busy slots, full sessions, and allocated slots
                          if (isBusy || (session && session.remaining <= 0) || isAllocated) {
                            console.log('Slot click blocked - busy, full, or allocated');
                            return; // Don't allow clicking on busy, full, or allocated slots
                          }
                          
                          if (isSelected) {
                            console.log('Deselecting slot');
                            onSlotDeselect(slot);
                          } else if (isConfirmed || session) {
                            // Existing session or confirmed slot - deselect immediately in one click
                            console.log(session ? 'Deselecting existing session slot' : 'Unassigning confirmed slot');
                            onSlotDeselect(slot);
                          } else {
                            console.log('Selecting free slot');
                            onSlotSelect(slot);
                          }
                        }}
                        onMouseEnter={(e) => {
                          // Show time label on hover (CSS handles visual hover states)
                          const labelElement = e.currentTarget.querySelector('.timeslot-label') as HTMLElement;
                          if (labelElement) {
                            labelElement.style.opacity = '1';
                          }
                        }}
                        onMouseLeave={(e) => {
                          // Hide time label on mouse leave (unless selected/confirmed/has session)
                          const labelElement = e.currentTarget.querySelector('.timeslot-label') as HTMLElement;
                          if (labelElement && !isSelected && !isConfirmed && !session) {
                            labelElement.style.opacity = '0';
                          }
                        }}
                          >
                            {/* Display time span label on the cell - show on hover or when selected */}
                            {(() => {
                              try {
                                const startTime = formatTime(slot.start);
                                const endTime = formatTime(slot.end);
                                const timeLabel = `${startTime} - ${endTime}`;
                                const shouldShowLabel = isSelected || isConfirmed || !!session;
                                return (
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
                                      lineHeight: '1.2',
                                      opacity: shouldShowLabel ? 1 : 0,
                                      transition: 'opacity 0.2s ease'
                                    }}>
                                    {timeLabel}
                                  </div>
                                );
                              } catch (error) {
                                return null;
                              }
                            })()}
                            {/* Show lock icon for unavailable slots */}
                            {(isBusy || (session && session.remaining <= 0) || isAllocated) && (
                              <div style={{ position: 'absolute', top: '2px', right: '2px' }}>
                                <Lock size={8} />
                              </div>
                            )}
                            {/* Show checkbox icon ONLY when slot is selected (after user clicks) */}
                            {!isBusy && !isAllocated && isSelected && (
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
                      });
                      })()
                    )}
                  </div>
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
    <div className="calendar-view" style={{ overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' }}>
      <div className="row">
        <div className="col-12">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h6 className="mb-0" style={{ color: 'var(--brand-headline)' }}>
              Available Time Slots
              {needsMultiRow && (
                <span className="badge bg-info ms-2" style={{ fontSize: '0.7rem' }}>
                  Multi-Row Layout ({currentDays.length} days)
                </span>
              )}
            </h6>
          </div>

          {/* Multi-Row Day Layout */}
          <div className="calendar-timeline" style={{ overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden', maxHeight: 'calc(100vh - 300px)' }}>
            
            {/* First Row - Up to 5 days */}
            {renderDayColumns(firstRowSlots, firstRowDays, maxColumnsPerRow)}
            
            {/* Second Row - Additional days if more than 5 */}
            {needsMultiRow && secondRowDays.length > 0 && (
              <div className="mt-4">
                <div className="mb-2">
                  <small style={{ color: 'var(--brand-headline)' }}>
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

// List View Component - Just shows the sessions table
const ListView: React.FC<{
  sessions: Session[];
  isTemporary: boolean;
}> = ({ sessions, isTemporary }) => {
  console.log('📋 ListView rendering with sessions:', {
    sessionsCount: sessions.length,
    sessions: sessions.map(s => ({
      id: s.id,
      start_time: s.start_time,
      end_time: s.end_time,
      capacity: s.capacity,
      booked_count: s.booked_count
    }))
  });
  
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
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
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
        <div className="card-header d-flex justify-content-between align-items-center">
          <div>
            <h6 className="mb-0">Existing Sessions</h6>
            {isTemporary && sessions.length > 0 && (
              <small className="text-warning">
                <Clock size={14} className="me-1" />
                Sessions will be saved when opportunity is created
              </small>
            )}
          </div>
          {sessions.length > 0 && (
            <small className="text-muted">
              Total slots: {sessions.reduce((sum, s) => sum + s.capacity, 0)} • 
              Remaining: {sessions.reduce((sum, s) => sum + s.remaining, 0)}
            </small>
          )}
        </div>
        <div className="card-body">
          {sessions.length === 0 ? (
            <div className="text-center text-muted py-3">
              <CalendarX size={32} className="text-muted" />
              <p className="mt-2 mb-0">No sessions created yet</p>
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
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id}>
                      <td>{new Date(session.start_time).toLocaleString()}</td>
                      <td>{new Date(session.end_time).toLocaleString()}</td>
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
                    </tr>
                  ))}
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
  onOpportunitySave,
  onBack,
  onNavigate
}) => {
  const { id: urlId } = useParams<{ id: string }>();
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [availableSlots, setAvailableSlots] = useState<AvailableSlot[]>([]);
  
  // Persist selected slots in sessionStorage to survive navigation
  // Use URL parameter for stable key that doesn't change during component lifecycle
  const getStorageKey = (type: 'selected' | 'confirmed') => {
    // Use URL ID if available (for editing), otherwise use opportunityId or temp
    const key = urlId || opportunityId || 'temp';
    return `${type}Slots_${key}`;
  };

  const getStoredSelectedSlots = (): Set<string> => {
    try {
      const key = getStorageKey('selected');
      const stored = sessionStorage.getItem(key);
      console.log('Loading selected slots from storage:', { key, stored });
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  };

  const getStoredConfirmedSlots = (): Set<string> => {
    try {
      const key = getStorageKey('confirmed');
      const stored = sessionStorage.getItem(key);
      console.log('Loading confirmed slots from storage:', { key, stored });
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  };

  const [selectedSlots, setSelectedSlots] = useState<Set<string>>(getStoredSelectedSlots);
  const [confirmedSlots, setConfirmedSlots] = useState<Set<string>>(getStoredConfirmedSlots);
  
  // Calendar view mode
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);

  // Debug component mount
  useEffect(() => {
    console.log('🟢 AdminSessionManager mounted:', {
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
  }, []);

  // Persist slots to sessionStorage whenever they change
  const persistSelectedSlots = (slots: Set<string>) => {
    try {
      const key = getStorageKey('selected');
      const value = JSON.stringify(Array.from(slots));
      sessionStorage.setItem(key, value);
      console.log('Persisted selected slots:', { key, value });
    } catch (error) {
      console.warn('Failed to persist selected slots:', error);
    }
  };

  const persistConfirmedSlots = (slots: Set<string>) => {
    try {
      const key = getStorageKey('confirmed');
      const value = JSON.stringify(Array.from(slots));
      sessionStorage.setItem(key, value);
      console.log('Persisted confirmed slots:', { key, value });
    } catch (error) {
      console.warn('Failed to persist confirmed slots:', error);
    }
  };
  
  // Calendar view controls - use UTC to match backend
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 1); // Start from tomorrow
    date.setUTCHours(0, 0, 0, 0); // Start at midnight UTC for consistent day boundaries
    console.log('🗓️ Calendar startDate initialized:', date.toISOString());
    return date;
  });
  const [endDate, setEndDate] = useState(() => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 7); // 7 days from today (1 week)
    date.setUTCHours(23, 59, 59, 999); // End at end of day UTC
    console.log('🗓️ Calendar endDate initialized:', date.toISOString());
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
          console.log('🔄 Restoring confirmed slots from storage for temporary opportunity:', {
            storedCount: stored.size,
            stored: Array.from(stored).slice(0, 3)
          });
          setConfirmedSlots(stored);
        } else if (confirmedSlots.size > 0) {
          console.log('🔄 Clearing confirmed slots (no sessions and no stored slots)');
          setConfirmedSlots(new Set());
          persistConfirmedSlots(new Set());
        }
      } else if (confirmedSlots.size > 0) {
        // For saved opportunities with no sessions, clear confirmed slots
        console.log('🔄 Clearing confirmed slots (no sessions in saved opportunity)');
        setConfirmedSlots(new Set());
        persistConfirmedSlots(new Set());
      }
      return;
    }

    const sessionSlots = new Set<string>();
    sessions.forEach(session => {
          // Ensure start_time and end_time are ISO strings
          const startTime = typeof session.start_time === 'string' 
            ? session.start_time 
            : (session.start_time as any)?.toISOString() || String(session.start_time);
          const endTime = typeof session.end_time === 'string'
            ? session.end_time
            : (session.end_time as any)?.toISOString() || String(session.end_time);
      
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
        console.log('🔄 Updating confirmed slots due to session changes:', {
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
    console.log('🔄 Syncing confirmed slots with sessions:', {
      sessionsCount: sessions.length,
            sessions: sessions.map(s => {
              const startTime = typeof s.start_time === 'string' ? s.start_time : (s.start_time as any)?.toISOString() || String(s.start_time);
              const endTime = typeof s.end_time === 'string' ? s.end_time : (s.end_time as any)?.toISOString() || String(s.end_time);
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
      sampleAvailableSlots: availableSlots.slice(0, 5).map(slot => {
        const start = typeof slot.start === 'string' ? slot.start : (slot.start as any)?.toISOString() || String(slot.start);
        const end = typeof slot.end === 'string' ? slot.end : (slot.end as any)?.toISOString() || String(slot.end);
        const slotKey = `${start}|${end}`;
        return {
          start,
          end,
          slotKey,
          matchesConfirmed: sessionSlots.has(slotKey)
        };
      })
    });
  }, [sessions, opportunityId, availableSlots]);

  // Cleanup persisted state when opportunity changes
  useEffect(() => {
    return () => {
      // Clean up persisted state when component unmounts
      try {
        sessionStorage.removeItem(getStorageKey('selected'));
        sessionStorage.removeItem(getStorageKey('confirmed'));
      } catch (error) {
        console.warn('Failed to cleanup persisted slots:', error);
      }
    };
  }, [urlId, opportunityId]);

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
        console.error('Invalid date range: start date is not before end date');
        setError('Invalid date range: start date must be before end date');
        return;
      }
      
      // Load calendar events and availability in parallel
      // Only fetch availability if durationMinutes is selected
      const availabilityPromise = durationMinutes 
        ? getAvailability(startTime, actualEndTime, durationMinutes, undefined, excludeWeekends)
        : Promise.resolve({ available_slots: [], total_slots: 0, duration_minutes: 0, time_range: { start: '', end: '' } });
      
      const [eventsResult, availabilityResult] = await Promise.all([
        getCalendarEvents(startTime, actualEndTime),
        availabilityPromise
      ]);
      
      setCalendarEvents(eventsResult);
      setAvailableSlots(availabilityResult.available_slots);
      
      // Match available slots with sessions
      console.log('📅 Calendar data loaded:', {
        eventsCount: eventsResult.length,
        availableSlotsCount: availabilityResult.available_slots.length,
        sessionsCount: sessions.length,
        sessions: sessions.map(session => ({
          id: session.id,
          start_time: session.start_time,
          end_time: session.end_time,
          opportunity_id: session.opportunity_id,
          slotKey: `${session.start_time}|${session.end_time}`
        })),
        sampleAvailableSlots: availabilityResult.available_slots.slice(0, 3).map(slot => ({
          start: slot.start,
          end: slot.end,
          slotKey: `${slot.start}|${slot.end}`
        }))
      });
      
      // Check if any sessions match available slots
      if (sessions.length > 0 && availabilityResult.available_slots.length > 0) {
        const sessionKeys = new Set(sessions.map(s => `${s.start_time}|${s.end_time}`));
        const slotKeys = new Set(availabilityResult.available_slots.map(s => `${s.start}|${s.end}`));
        const matchedKeys = Array.from(sessionKeys).filter(key => slotKeys.has(key));
        console.log('🔍 Session/Slot matching:', {
          sessionKeysCount: sessionKeys.size,
          slotKeysCount: slotKeys.size,
          matchedCount: matchedKeys.length,
          matchedKeys: matchedKeys.slice(0, 5),
          unmatchedSessions: Array.from(sessionKeys).filter(key => !slotKeys.has(key)).slice(0, 5)
        });
      }
      
      // Reset pagination when new data is loaded
      setCurrentPage(0);
      
      // Auto-adjust daysPerPage to show all days for multi-row layout
      // Calculate the actual number of days that will be displayed (after filtering weekends if needed)
      let totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      
      if (excludeWeekends) {
        // Count only weekdays in the range (UTC)
        let weekdayCount = 0;
        const tempCurrent = new Date(startDate);
        while (tempCurrent <= endDate) {
          const dayOfWeek = tempCurrent.getUTCDay(); // Use UTC to match backend
          if (dayOfWeek >= 1 && dayOfWeek <= 5) { // Monday to Friday
            weekdayCount++;
          }
          tempCurrent.setUTCDate(tempCurrent.getUTCDate() + 1); // Use UTC date operations
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
      
    } catch (err: any) {
      console.error('Error loading calendar data:', err);
      const errorMessage = err.response?.data?.error || 
                          err.response?.statusText || 
                          err.message || 
                          'Failed to load calendar data';
      setError(errorMessage);
    } finally {
      setLoading(false);
      setIsUpdating(false);
    }
  }, [startDate, endDate, durationMinutes, excludeWeekends, disabled]);

  // Direct effect to watch for date changes
  useEffect(() => {
    if (!disabled) {
      loadCalendarData();
    }
  }, [startDate, endDate, durationMinutes, excludeWeekends, disabled]);

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

  const handleSlotSelect = useCallback((slot: AvailableSlot) => {
    const slotKey = `${slot.start}|${slot.end}`;
    console.log('🔵 SLOT SELECTED:', { 
      slotKey, 
      currentSelectedSlots: Array.from(selectedSlots),
      opportunityId,
      urlId,
      isTemporary 
    });
    setSelectedSlots(prev => {
      const newSet = new Set([...prev, slotKey]);
      console.log('🔵 New selected slots:', Array.from(newSet));
      persistSelectedSlots(newSet);
      return newSet;
    });
  }, [selectedSlots, opportunityId, urlId, isTemporary]);

  const handleSlotDeselect = useCallback(async (slot: AvailableSlot) => {
    const slotKey = `${slot.start}|${slot.end}`;
    console.log('handleSlotDeselect called:', { 
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
        console.log('🗑️ Deleting session from database:', session.id);
        const { deleteSession } = await import('../api/client');
        await deleteSession(session.id);
        
        // Remove session from the sessions array
        const updatedSessions = sessions.filter(s => s.id !== session.id);
        onSessionsChange(updatedSessions);
        console.log('✅ Session deleted successfully');
      } catch (error) {
        console.error('❌ Error deleting session:', error);
        setError('Failed to delete session. Please try again.');
      }
    }
    
    // Remove from both selected and confirmed slots
    setSelectedSlots(prev => {
      const newSet = new Set(prev);
      newSet.delete(slotKey);
      console.log('New selected slots after deselect:', Array.from(newSet));
      persistSelectedSlots(newSet);
      return newSet;
    });
    
    setConfirmedSlots(prev => {
      const newSet = new Set(prev);
      newSet.delete(slotKey);
      console.log('New confirmed slots after deselect:', Array.from(newSet));
      persistConfirmedSlots(newSet);
      return newSet;
    });
  }, [selectedSlots, confirmedSlots, opportunityId, sessions, onSessionsChange]);

  const handleCreateSessionsFromSelected = async () => {
    if (selectedSlots.size === 0) {
      setError('Please select at least one time slot');
      return;
    }

    // Validate opportunityId for non-temporary sessions
    if (!isTemporary && (!opportunityId || opportunityId.trim() === '')) {
      setError('Cannot create sessions: Opportunity ID is missing. Please save the opportunity first.');
      return;
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
        
        // If we have an opportunity save callback, save the opportunity
        if (onOpportunitySave) {
          console.log('🚀 Calling onOpportunitySave callback for temporary opportunity');
          // Small delay to ensure state has propagated to parent component
          await new Promise(resolve => setTimeout(resolve, 100));
          try {
            // Get the opportunity ID before saving (it should be set by parent)
            const opportunityIdBeforeSave = opportunityId;
            const savedOpportunityId = await onOpportunitySave();
            console.log('✅ onOpportunitySave completed successfully for temporary opportunity:', {
              returnedOpportunityId: savedOpportunityId,
              previousOpportunityId: opportunityIdBeforeSave
            });
            
            // Use the opportunity ID returned from the callback, or fall back to prop/URL
            const opportunityIdToUse = savedOpportunityId || opportunityId || (urlId && urlId !== 'new' ? urlId : null);
            
            if (opportunityIdToUse && opportunityIdToUse !== opportunityIdBeforeSave) {
              console.log('🔄 Creating sessions for saved opportunity:', {
                oldId: opportunityIdBeforeSave,
                newId: opportunityIdToUse,
                sessionCount: sessionData.length
              });
              
              try {
                const { createSessions } = await import('../api/client');
                const createdSessions = await createSessions(opportunityIdToUse, sessionData);
                console.log('✅ CREATE MODE - Sessions created directly:', {
                  createdCount: createdSessions.length,
                  createdSessions: createdSessions.map(s => ({
                    id: s.id,
                    start_time: s.start_time,
                    end_time: s.end_time,
                    opportunity_id: s.opportunity_id
                  }))
                });
                
                // Update sessions state with real sessions
                onSessionsChange(createdSessions);
                
                // After sessions are created, navigate to admin dashboard
                console.log('✅ All sessions created, navigating to admin dashboard');
                // Use callback navigation to avoid full page reload (which clears session)
                if (onNavigate) {
                  onNavigate('/admin');
                } else {
                  // Fallback to window.location if callback not provided
                  window.location.href = '/admin';
                }
              } catch (sessionError) {
                console.error('❌ Error creating sessions after opportunity save:', sessionError);
                setError('Opportunity saved but failed to create sessions. Please add them manually.');
                // Navigate anyway so user can manually add sessions
                if (onNavigate) {
                  onNavigate('/admin');
                } else {
                  window.location.href = '/admin';
                }
              }
            } else if (!opportunityIdToUse) {
              console.log('⚠️ Cannot create sessions: Opportunity ID not returned from save callback. Navigating to admin.');
              if (onNavigate) {
                onNavigate('/admin');
              } else {
                window.location.href = '/admin';
              }
            } else {
              console.log('⚠️ Opportunity ID unchanged, sessions may have been created by parent component. Navigating to admin.');
              if (onNavigate) {
                onNavigate('/admin');
              } else {
                window.location.href = '/admin';
              }
            }
          } catch (saveError) {
            console.error('❌ Error saving temporary opportunity:', saveError);
            // Navigate to admin even on error
            if (onNavigate) {
              onNavigate('/admin');
            } else {
              window.location.href = '/admin';
            }
          }
        } else {
          console.log('⚠️ onOpportunitySave callback not provided for temporary opportunity');
        }
        
        // Refresh calendar to show updated state immediately (before navigation)
        await loadCalendarData();
        return;
      }

      // Note: We allow sessions from different opportunities to run simultaneously
      // Conflict checking for overlapping sessions within the same opportunity is handled by the backend
      // Different opportunities can have sessions at the same time (different admins, different studies)

      // Create sessions via API
      const createdSessions = await createSessions(opportunityId, sessionData);
      console.log('✅ Sessions created successfully:', {
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
      
      // If we have an opportunity save callback, save the opportunity
      if (onOpportunitySave) {
        console.log('🚀 Calling onOpportunitySave callback');
        try {
          await onOpportunitySave();
          console.log('✅ onOpportunitySave completed successfully');
        } catch (saveError) {
          console.error('❌ Error saving opportunity:', saveError);
          // Don't fail the entire operation if opportunity save fails
          // Sessions were already created successfully
        }
      } else {
        console.log('⚠️ onOpportunitySave callback not provided');
      }
      
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
      
    } catch (err: any) {
      console.error('Error creating sessions:', err);
      setError(err.response?.data?.error || 'Failed to create sessions');
    } finally {
      setLoading(false);
    }
  };

  const handleClearSelected = () => {
    setSelectedSlots(new Set());
    setConfirmedSlots(new Set());
    persistSelectedSlots(new Set());
    persistConfirmedSlots(new Set());
  };

  const handleClearVisualState = () => {
    setSelectedSlots(new Set());
    setConfirmedSlots(new Set());
    persistSelectedSlots(new Set());
    persistConfirmedSlots(new Set());
    // Force refresh calendar to clear any visual state
    loadCalendarData();
  };

  const handleResetAllSessions = () => {
    // Always allow reset if there are any visual states or sessions
    if (sessions.length === 0 && selectedSlots.size === 0 && confirmedSlots.size === 0) {
      // Even if state shows zero, if there are visually assigned slots, allow reset
      console.log('No state found, but allowing reset to clear visual state');
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
        console.log(result.message);
      }
      
      // Update the sessions list to empty
      onSessionsChange([]);
      
      // Clear all slot states
      setSelectedSlots(new Set());
      setConfirmedSlots(new Set());
      persistSelectedSlots(new Set());
      persistConfirmedSlots(new Set());
      
      // Refresh calendar to show updated state
      await loadCalendarData();
      
    } catch (error: any) {
      console.error('Error resetting sessions:', error);
      if (error.response?.data?.error) {
        setError(error.response.data.error);
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
    <div className="admin-session-manager" style={{ border: 'none' }}>
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

      {disabled && !isTemporary && !opportunityId && (
        <div className="alert alert-info" role="alert">
          <Info size={18} className="me-2" />
          Please wait while the opportunity loads, or save the opportunity first before adding sessions.
        </div>
      )}

      {/* Reset Confirmation Modal */}
      {showResetConfirmation && (
        <div className="modal show d-block" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
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
                        {new Date(session.start_time).toLocaleString()} - {new Date(session.end_time).toLocaleString()}
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

          {/* Calendar Controls */}
          <div style={{
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '12px',
            padding: '10px 0',
            marginBottom: '12px',
            width: '100%'
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: '15px',
              flexWrap: 'wrap',
              padding: '0 15px'
            }}>
              <div style={{ minWidth: '130px' }}>
                <label style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '2px', display: 'block' }}>
                  Start Date
                </label>
                <input
                  type="date"
                  className="form-control form-control-sm"
                  value={startDate.toISOString().split('T')[0]}
                  onChange={(e) => {
                    const [year, month, day] = e.target.value.split('-');
                    const newDate = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), 0, 0, 0));
                    
                    // Validate that start date is not after end date
                    if (newDate <= endDate) {
                      setStartDate(newDate);
                    } else {
                      console.warn('Start date cannot be after end date');
                    }
                  }}
                  disabled={disabled}
                />
              </div>
              <div style={{ minWidth: '130px' }}>
                <label style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '2px', display: 'block' }}>
                  End Date
                </label>
                <input
                  type="date"
                  className="form-control form-control-sm"
                  value={endDate.toISOString().split('T')[0]}
                  onChange={(e) => {
                    const [year, month, day] = e.target.value.split('-');
                    const newDate = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day), 23, 59, 59));
                    
                    // Validate that end date is not before start date
                    if (newDate >= startDate) {
                      setEndDate(newDate);
                    } else {
                      console.warn('End date cannot be before start date');
                    }
                  }}
                  disabled={disabled}
                />
              </div>
              <div style={{ minWidth: '110px' }}>
                <label style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '2px', display: 'block' }}>
                  Timeslot (mins)
                </label>
                <select
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
              <div style={{ minWidth: '70px' }}>
                <label style={{ fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '2px', display: 'block' }}>
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
              <div style={{ minWidth: '130px', display: 'flex', alignItems: 'center', paddingTop: '16px' }}>
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="includeWeekends"
                    checked={!excludeWeekends}
                    onChange={(e) => setExcludeWeekends(!e.target.checked)}
                    disabled={disabled}
                  />
                  <label className="form-check-label" style={{ fontSize: '0.75rem', color: 'var(--text-primary)' }} htmlFor="includeWeekends">
                    Include weekends
                  </label>
                </div>
              </div>
              <div style={{ marginLeft: 'auto', paddingTop: '16px' }}>
                <small style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                  {(availableSlots || []).length} slots available
                </small>
              </div>
            </div>
          </div>

          {/* View Switcher */}
          <div className="mb-2" style={{
            backgroundColor: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '10px',
            padding: '6px 12px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {/* Segmented Control for View Mode */}
              <div style={{
                display: 'inline-flex',
                backgroundColor: 'rgba(255, 255, 255, 0.08)',
                borderRadius: '6px',
                padding: '3px'
              }}>
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  disabled={disabled}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '4px 10px',
                    fontSize: '0.75rem',
                    fontWeight: viewMode === 'grid' ? '600' : '500',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease',
                    backgroundColor: viewMode === 'grid' ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
                    color: viewMode === 'grid' ? 'var(--text-primary)' : 'var(--text-muted)',
                    boxShadow: viewMode === 'grid' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none'
                  }}
                >
                  <LayoutGrid size={12} />
                  Calendar
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  disabled={disabled}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '4px 10px',
                    fontSize: '0.75rem',
                    fontWeight: viewMode === 'list' ? '600' : '500',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease',
                    backgroundColor: viewMode === 'list' ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
                    color: viewMode === 'list' ? 'var(--text-primary)' : 'var(--text-muted)',
                    boxShadow: viewMode === 'list' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none'
                  }}
                >
                  <List size={12} />
                  Table
                </button>
              </div>

              {/* Ghost Refresh Button */}
              <button
                type="button"
                onClick={loadCalendarData}
                disabled={disabled || loading}
                title="Refresh calendar to see latest booking status"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '4px 8px',
                  fontSize: '0.7rem',
                  fontWeight: '500',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '4px',
                  cursor: disabled || loading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s ease',
                  backgroundColor: 'transparent',
                  color: 'var(--text-muted)',
                  opacity: disabled || loading ? 0.5 : 1
                }}
                onMouseEnter={(e) => {
                  if (!disabled && !loading) {
                    e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                  e.currentTarget.style.color = 'var(--text-muted)';
                }}
              >
                <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                Refresh
              </button>

              {/* Reset Button - pushed to right */}
              <button
                type="button"
                onClick={() => {
                  console.log('Reset button clicked. Current state:', {
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
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '4px 8px',
                  fontSize: '0.7rem',
                  fontWeight: '500',
                  marginLeft: 'auto',
                  border: '1px solid rgba(156, 163, 175, 0.3)',
                  borderRadius: '4px',
                  cursor: disabled || loading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s ease',
                  backgroundColor: 'transparent',
                  color: '#9CA3AF',
                  opacity: disabled || loading ? 0.5 : 1
                }}
                onMouseEnter={(e) => {
                  if (!disabled && !loading) {
                    e.currentTarget.style.borderColor = '#EF4444';
                    e.currentTarget.style.color = '#EF4444';
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.borderColor = 'rgba(156, 163, 175, 0.3)';
                  e.currentTarget.style.color = '#9CA3AF';
                }}
              >
                <Trash2 size={11} />
                Reset All
              </button>
            </div>
          </div>

          {/* Calendar View */}
          <div className="card mb-3" style={{
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px'
          }}>
            <div className="card-body" style={{ backgroundColor: 'transparent' }}>
              {loading || isUpdating ? (
                <div className="text-center py-4">
                  <div className="spinner-border text-primary" role="status">
                    <span className="visually-hidden">Loading calendar...</span>
                  </div>
                  <div className="mt-2" style={{ color: 'var(--text-muted)' }}>Fetching calendar data...</div>
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
                    availableSlots={availableSlots}
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
                  key={`list-${startDate.toISOString()}-${endDate.toISOString()}-${durationMinutes}-${availableSlots.length}`}
                  sessions={sessions}
                  isTemporary={isTemporary}
                />
              )}
            </div>
          </div>

          {/* Selected Slots Actions */}
          {selectedSlots.size > 0 && (
            <div className="mb-3">
              <div>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1rem',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '1.5rem 0',
                  textAlign: 'center'
                }}>
                  {/* Slots selected indicator */}
                  <div style={{ fontSize: '1rem', color: 'var(--text-primary)' }}>
                    <strong>{selectedSlots.size}</strong> slot{selectedSlots.size !== 1 ? 's' : ''} selected
                  </div>
                  
                  {/* Create Opportunity Button */}
                  <button
                    type="button"
                    className="btn btn-success btn-sm"
                    onClick={handleCreateSessionsFromSelected}
                    disabled={disabled || loading}
                    style={{
                      minWidth: '180px'
                    }}
                  >
                    {loading ? 'Creating...' : 'Create Opportunity'}
                  </button>
                  
                  {/* Clear Selection and Back buttons on same row */}
                  <div style={{
                    display: 'flex',
                    width: '100%',
                    position: 'relative'
                  }}>
                    {/* Back button - left aligned */}
                    {onBack && (
                      <button
                        type="button"
                        className="btn btn-outline-secondary btn-sm"
                        onClick={onBack}
                        disabled={disabled || loading}
                      >
                        <ArrowLeft size={16} className="me-2" />
                        Back
                      </button>
                    )}
                    {/* Clear Selection - centered */}
                    <div style={{
                      flex: '1',
                      display: 'flex',
                      justifyContent: 'center',
                      position: 'absolute',
                      left: '0',
                      right: '0',
                      top: '0',
                      bottom: '0',
                      alignItems: 'center'
                    }}>
                      <button
                        type="button"
                        className="btn btn-outline-secondary btn-sm"
                        onClick={handleClearSelected}
                        disabled={disabled}
                      >
                        Clear Selection
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Back button when no slots selected - left-aligned */}
          {!selectedSlots.size && onBack && (
            <div className="mt-4" style={{ textAlign: 'left' }}>
              <button
                type="button"
                className="btn btn-outline-secondary px-5 py-2 fw-semibold"
                onClick={onBack}
                disabled={disabled || loading}
                style={{ fontSize: '0.95rem' }}
              >
                <ArrowLeft size={16} className="me-2" />
                Back
              </button>
            </div>
          )}
        </div>

    </div>
  );
};

export default AdminSessionManager;
