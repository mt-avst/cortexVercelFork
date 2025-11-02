import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Session, CreateSessionRequest, CalendarEvent, AvailableSlot } from '../api/types';
import { getCalendarEvents, getAvailability, checkConflicts } from '../api/client';
import { createSessions, deleteAllSessions } from '../api/client';

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
    
    // Debug logging for first few checks to identify matching issues
    if (confirmedSlots.size > 0 && !isConfirmed) {
      // Only log occasionally to avoid spam
      const shouldLog = Math.random() < 0.01; // Log 1% of the time
      if (shouldLog) {
        console.log('🔍 Slot confirmation check:', {
          slotKey,
          slotStart,
          slotEnd,
          confirmedSlotsCount: confirmedSlots.size,
          sampleConfirmedSlot: Array.from(confirmedSlots)[0],
          matches: Array.from(confirmedSlots).some(ck => ck === slotKey)
        });
      }
    }
    
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
  
  // Log filtered results for debugging
  if (durationMinutes && cleanedSlots.length !== durationFilteredSlots.length) {
    console.log(`🔍 Overlap removal: ${durationFilteredSlots.length} slots → ${cleanedSlots.length} slots (removed ${durationFilteredSlots.length - cleanedSlots.length} overlapping)`);
  }
  
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
      <div style={{ 
        display: 'flex',
        gap: '8px',
        width: '100%',
        overflowX: 'auto'
      }}>
          {/* Time Column (Left) */}
          <div style={{
            minWidth: '90px',
            width: '90px',
            position: 'sticky',
            left: 0,
            zIndex: 10,
            backgroundColor: '#f8f9fa'
          }}>
          {/* Time Header */}
          <div style={{
            height: '60px',
            borderBottom: '2px solid #dee2e6',
            backgroundColor: '#f8f9fa'
          }}></div>
          {/* Time Markers */}
          <div style={{
            position: 'relative',
            height: timelineHeight,
            minHeight: `${minTimelineHeight}px`,
            overflow: 'hidden',
            backgroundColor: '#f8f9fa',
            borderRight: '2px solid #dee2e6'
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
                  style={{
                    position: 'absolute',
                    top: `${position}%`,
                    left: 0,
                    right: 0,
                    borderTop: '1.5px solid #495057',  // Thicker, darker line for hours - border at exact time position
                    paddingLeft: '8px',
                    paddingTop: '2px', // Small padding to push text below border line
                    fontSize: '0.9rem',
                    fontWeight: '700',
                    color: '#000000',
                    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                    // Remove translateY(-50%) so border line aligns exactly with time position
                    pointerEvents: 'none',
                    lineHeight: '1.3',
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
          minWidth: `${maxColumns * 120}px`
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
                  <div className="text-center p-2" style={{ 
                    backgroundColor: '#f8f9fa', 
                    borderRadius: '8px 8px 0 0',
                    border: 'none',
                    borderBottom: '1px solid #dee2e6',
                    height: '60px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center'
                  }}>
                    <h6 className="mb-1 text-dark fw-bold" style={{ fontSize: '0.9rem', margin: 0 }}>
                      {formatDate(column.date)}
                    </h6>
                    <small className="text-muted" style={{ fontSize: '0.7rem' }}>
                      {column.slots.length} slot{column.slots.length !== 1 ? 's' : ''}
                    </small>
                  </div>
            
                  {/* Timeline Container */}
                  <div style={{ 
                    position: 'relative',
                    height: timelineHeight,
                    border: 'none',
                    backgroundColor: '#ffffff',
                    overflow: 'hidden',
                    zIndex: 1
                  }}>
                    {/* Positioned Slots */}
                    {column.slots.length === 0 ? (
                      <div className="text-center text-muted" style={{ 
                        fontSize: '0.8rem',
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)'
                      }}>
                        <i className="bi bi-calendar-x me-1"></i>
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
                        
                        // Debug: Log when sessions exist but aren't matched
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
                        
                        // DEBUG: Log if height seems incorrect (should be ~3.125% for 30-min slots)
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
                        let slotClass = '';
                        let slotStyle: React.CSSProperties = {};
                        
                        if (isConfirmed) {
                          slotClass = 'calendar-slot-available';
                          slotStyle = { 
                            backgroundColor: '#28a745',
                            color: 'white',
                            borderColor: '#28a745'
                          };
                        } else if (isSelected) {
                          slotClass = 'text-dark';
                          slotStyle = { backgroundColor: 'rgba(25, 135, 84, 0.3)', borderColor: '#198754' };
                        } else if (session) {
                          if (session.remaining > 0) {
                            slotClass = 'calendar-slot-available';
                            slotStyle = { backgroundColor: '#28a745', color: 'white', borderColor: '#28a745' };
                          } else {
                            slotClass = 'bg-danger text-white';
                            slotStyle = { backgroundColor: '#dc3545', color: 'white', borderColor: '#dc3545' };
                          }
                        } else if (isAllocated) {
                          slotClass = 'text-dark';
                          slotStyle = { backgroundColor: 'rgba(255, 193, 7, 0.2)', borderColor: '#ffc107' };
                        } else if (isBusy) {
                          slotClass = 'bg-secondary text-white';
                          slotStyle = { backgroundColor: '#6c757d', color: 'white', borderColor: '#6c757d' };
                        } else {
                          // Available slot - make it clearly visible with solid border
                          slotClass = 'border-success';
                          slotStyle = { 
                            backgroundColor: 'rgba(40, 167, 69, 0.15)', // Light green background
                            borderColor: '#28a745', // Green border
                            borderStyle: 'solid', // Solid border for distinct cells
                            borderWidth: '2px'
                          };
                        }

                        return (
                          <div
                            key={uniqueKey}
                            className={`calendar-slot calendar-slot-btn border cursor-pointer position-absolute ${slotClass}`}
                            style={{ 
                              ...slotStyle,
                              left: '2px',
                              right: '2px',
                              top: `${roundedTop}%`,
                              height: `${roundedHeight}%`,
                              maxHeight: `${roundedHeight}%`, // Strict max height - no overflow
                              minHeight: '0', // No minimum to prevent forced overlap
                              boxSizing: 'border-box', // Include border in height calculation
                              position: 'absolute', // Ensure absolute positioning
                              cursor: isBusy || (session && session.remaining <= 0) || isAllocated ? 'not-allowed' : 'pointer',
                              opacity: isBusy || (session && session.remaining <= 0) || isAllocated ? 0.8 : 1,
                              transition: 'all 0.2s ease',
                              borderWidth: isSelected ? '2px' : '1px',
                              borderRadius: '0',
                              fontSize: '0.7rem',
                              padding: '2px 4px',
                              overflow: 'hidden',
                              zIndex: isSelected || isConfirmed ? 5 : 1,
                              marginTop: '0px',
                              marginBottom: '0px'
                            }}
                        title={(() => {
                          const session = getSessionForSlot(slot);
                          if (session) {
                            return `Session: ${session.capacity} capacity, ${session.booked_count} booked, ${session.remaining} remaining`;
                          } else if (isBusy) {
                            return 'This time slot conflicts with existing calendar events';
                          } else if (isAllocated) {
                            return 'This slot is allocated to another opportunity';
                          } else if (isSelected) {
                            return 'Selected for session creation';
                          } else if (isConfirmed) {
                            return 'Session confirmed';
                          } else {
                            return 'Available time slot';
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
                          if (isBusy) {
                            e.currentTarget.style.backgroundColor = 'rgba(108, 117, 125, 0.1)';
                            e.currentTarget.style.borderColor = 'rgba(108, 117, 125, 0.3)';
                            e.currentTarget.style.cursor = 'not-allowed';
                          } else if (session && session.remaining <= 0) {
                            e.currentTarget.style.backgroundColor = 'rgba(220, 53, 69, 0.1)';
                            e.currentTarget.style.borderColor = 'rgba(220, 53, 69, 0.3)';
                            e.currentTarget.style.cursor = 'not-allowed';
                          } else if (isAllocated) {
                            e.currentTarget.style.backgroundColor = 'rgba(255, 193, 7, 0.1)';
                            e.currentTarget.style.borderColor = 'rgba(255, 193, 7, 0.3)';
                            e.currentTarget.style.cursor = 'not-allowed';
                          } else if (isSelected) {
                            // Selected state hover effect - darker green
                            e.currentTarget.style.backgroundColor = 'rgba(25, 135, 84, 0.5)';
                            e.currentTarget.style.borderColor = '#198754';
                            e.currentTarget.style.transform = 'scale(1.02)';
                            e.currentTarget.style.boxShadow = '0 4px 8px rgba(25, 135, 84, 0.3)';
                          } else if (isConfirmed || session) {
                            // Existing session or confirmed slot hover - make it look toggleable like selected slots
                            e.currentTarget.style.backgroundColor = 'rgba(25, 135, 84, 0.4)';
                            e.currentTarget.style.borderColor = '#198754';
                            e.currentTarget.style.transform = 'scale(1.02)';
                            e.currentTarget.style.boxShadow = '0 4px 8px rgba(25, 135, 84, 0.3)';
                            e.currentTarget.style.cursor = 'pointer';
                          } else {
                            // Available slot hover - brighten it
                            e.currentTarget.style.backgroundColor = 'rgba(40, 167, 69, 0.3)';
                            e.currentTarget.style.borderColor = '#28a745';
                            e.currentTarget.style.borderStyle = 'solid'; // Keep solid border
                            e.currentTarget.style.transform = 'translateY(-1px)';
                            e.currentTarget.style.boxShadow = '0 2px 4px rgba(40, 167, 69, 0.3)';
                          }
                        }}
                        onMouseLeave={(e) => {
                          // Reset styles but preserve selected state
                          if (isSelected) {
                            // Restore selected state styling
                            e.currentTarget.style.backgroundColor = 'rgba(25, 135, 84, 0.3)';
                            e.currentTarget.style.borderColor = '#198754';
                          } else if (isConfirmed || session) {
                            // Restore existing session/confirmed state styling (green background)
                            e.currentTarget.style.backgroundColor = '#28a745';
                            e.currentTarget.style.borderColor = '#28a745';
                            e.currentTarget.style.color = 'white';
                          } else if (isAllocated) {
                            // Restore allocated state styling (yellow background)
                            e.currentTarget.style.backgroundColor = 'rgba(255, 193, 7, 0.2)';
                            e.currentTarget.style.borderColor = '#ffc107';
                          } else {
                            // Reset available slot to default
                            e.currentTarget.style.backgroundColor = 'rgba(40, 167, 69, 0.15)';
                            e.currentTarget.style.borderColor = '#28a745';
                            e.currentTarget.style.borderStyle = 'solid'; // Keep solid border
                          }
                          e.currentTarget.style.transform = '';
                          e.currentTarget.style.boxShadow = '';
                          e.currentTarget.style.cursor = '';
                        }}
                          >
                            {/* Show lock icon for unavailable slots */}
                            {(isBusy || (session && session.remaining <= 0) || isAllocated) && (
                              <div style={{ position: 'absolute', top: '2px', right: '2px' }}>
                                <i className="bi bi-lock-fill" style={{ fontSize: '0.5rem' }}></i>
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
                                <i className="bi bi-check-square-fill" style={{ fontSize: '0.75rem' }}></i>
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
                    backgroundColor: '#f8f9fa', 
                    borderRadius: '8px 8px 0 0',
                    border: '1px solid #dee2e6',
                    borderBottom: '2px solid #dee2e6',
                    height: '60px'
                  }}></div>
                  <div style={{ 
                    height: timelineHeight,
                    border: '1px solid #dee2e6',
                    borderTop: 'none',
                    backgroundColor: '#ffffff'
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
    <div className="calendar-view" style={{ overflow: 'hidden' }}>
      <div className="row">
        <div className="col-12">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h6 className="mb-0">
              Available Time Slots
              {needsMultiRow && (
                <span className="badge bg-info ms-2" style={{ fontSize: '0.7rem' }}>
                  Multi-Row Layout ({currentDays.length} days)
                </span>
              )}
            </h6>
          </div>

          {/* Multi-Row Day Layout */}
          <div className="calendar-timeline" style={{ overflow: 'hidden', maxHeight: 'calc(100vh - 300px)' }}>
            
            {/* First Row - Up to 5 days */}
            {renderDayColumns(firstRowSlots, firstRowDays, maxColumnsPerRow)}
            
            {/* Second Row - Additional days if more than 5 */}
            {needsMultiRow && secondRowDays.length > 0 && (
              <div className="mt-4">
                <div className="mb-2">
                  <small className="text-muted">
                    <i className="bi bi-calendar-week me-1"></i>
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
      <div className="card">
        <div className="card-header d-flex justify-content-between align-items-center">
          <div>
            <h6 className="mb-0">Existing Sessions</h6>
            {isTemporary && sessions.length > 0 && (
              <small className="text-warning">
                <i className="bi bi-clock me-1"></i>
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
              <i className="bi bi-calendar-x text-muted" style={{ fontSize: '2rem' }}></i>
              <p className="mt-2 mb-0">No sessions created yet</p>
            </div>
          ) : (
            <div className="table-responsive">
              <table className="table table-sm">
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
    
    // Debug: Log all sessions being processed and sample available slots for comparison
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
      
      // Debug: Log available slots and sessions to see if they match
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

      // Check for conflicts before creating (only for saved opportunities)
      // Exclude conflicts with sessions from the current opportunity
      const conflictsResult = await checkConflicts(sessionData, undefined, opportunityId);
      if (conflictsResult.has_conflicts) {
        setError(`Cannot create sessions: ${conflictsResult.conflicting_slots} slots have conflicts with existing sessions from other opportunities`);
        return;
      }

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

      {error && (
        <div className="alert alert-danger" role="alert">
          <i className="bi bi-exclamation-triangle me-2"></i>
          {error}
        </div>
      )}

      {disabled && !isTemporary && !opportunityId && (
        <div className="alert alert-info" role="alert">
          <i className="bi bi-info-circle me-2"></i>
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
                  <i className="bi bi-exclamation-triangle text-warning me-2"></i>
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
                  <i className="bi bi-info-circle me-2"></i>
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
                      <i className="bi bi-trash me-2"></i>
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
            backgroundColor: '#f8f9fa',
            borderTop: '1px solid #dee2e6',
            borderBottom: '1px solid #dee2e6',
            padding: '15px 0',
            marginBottom: '20px',
            width: '100%'
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: '15px',
              flexWrap: 'wrap',
              padding: '0 15px'
            }}>
              <div style={{ minWidth: '140px' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: '600', color: '#6c757d', marginBottom: '4px', display: 'block' }}>
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
              <div style={{ minWidth: '140px' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: '600', color: '#6c757d', marginBottom: '4px', display: 'block' }}>
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
              <div style={{ minWidth: '120px' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: '600', color: '#6c757d', marginBottom: '4px', display: 'block' }}>
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
              <div style={{ minWidth: '80px' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: '600', color: '#6c757d', marginBottom: '4px', display: 'block' }}>
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
              <div style={{ minWidth: '140px', display: 'flex', alignItems: 'center', paddingTop: '20px' }}>
                <div className="form-check">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id="includeWeekends"
                    checked={!excludeWeekends}
                    onChange={(e) => setExcludeWeekends(!e.target.checked)}
                    disabled={disabled}
                  />
                  <label className="form-check-label" style={{ fontSize: '0.875rem' }} htmlFor="includeWeekends">
                    Include weekends
                  </label>
                </div>
              </div>
              <div style={{ marginLeft: 'auto', paddingTop: '20px' }}>
                <small className="text-muted">
                  {(availableSlots || []).length} slots available
                </small>
              </div>
            </div>
          </div>

          {/* View Switcher */}
          <div className="card mb-3">
            <div className="card-body py-2">
              <div className="row align-items-center">
                <div className="col-auto">
                  <small className="text-muted me-3">View:</small>
                </div>
                <div className="col-auto">
                  <div className="btn-group" role="group">
                    <button
                      type="button"
                      className={`btn btn-sm ${viewMode === 'grid' ? 'btn-primary' : 'btn-outline-primary'}`}
                      onClick={() => setViewMode('grid')}
                      disabled={disabled}
                    >
                      <i className="bi bi-grid-3x3-gap me-1"></i>
                      Grid
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${viewMode === 'list' ? 'btn-primary' : 'btn-outline-primary'}`}
                      onClick={() => setViewMode('list')}
                      disabled={disabled}
                    >
                      <i className="bi bi-list-ul me-1"></i>
                      List
                    </button>
                  </div>
                </div>
                <div className="col-auto">
                  <button
                    type="button"
                    className="btn btn-outline-secondary btn-sm"
                    onClick={loadCalendarData}
                    disabled={disabled || loading}
                    title="Refresh calendar to see latest booking status"
                  >
                    <i className={`bi bi-arrow-clockwise ${loading ? 'spinner-border spinner-border-sm' : ''}`}></i>
                    Refresh
                  </button>
                </div>
                <div className="col-auto ms-auto">
                  <button
                    type="button"
                    className="btn btn-outline-danger btn-sm"
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
                  >
                    <i className="bi bi-trash me-1"></i>
                    Reset All Sessions
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Calendar View */}
          <div className="card mb-3">
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
                      <i className="bi bi-info-circle me-2"></i>
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
                  <div style={{ fontSize: '1rem', color: '#495057' }}>
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
                        <i className="bi bi-arrow-left me-2"></i>
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
                <i className="bi bi-arrow-left me-2"></i>
                Back
              </button>
            </div>
          )}
        </div>

    </div>
  );
};

export default AdminSessionManager;
