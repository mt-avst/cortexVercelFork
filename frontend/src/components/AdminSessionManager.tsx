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
  onOpportunitySave?: () => Promise<void>; // New prop for saving opportunity
  onBack?: () => void; // Prop for back navigation
}

interface CalendarViewProps {
  events: CalendarEvent[];
  availableSlots: AvailableSlot[];
  selectedSlots: Set<string>;
  confirmedSlots: Set<string>;
  onSlotSelect: (slot: AvailableSlot) => void;
  onSlotDeselect: (slot: AvailableSlot) => void;
  durationMinutes: number;
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
    const slotKey = `${slot.start}|${slot.end}`;
    return confirmedSlots.has(slotKey);
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
      // Find exact matches (existing sessions)
      return (slotStart.getTime() === sessionStart.getTime() && slotEnd.getTime() === sessionEnd.getTime());
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
  

  // Group all slots by date first (UTC)
  const allSlotsByDate = availableSlots.reduce((acc, slot) => {
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

  // Helper function to render day columns
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
        allColumns.push({ date: dateString, slots: slotsByDate[dateString] || [], isEmpty: false });
      } else {
        allColumns.push({ date: '', slots: [], isEmpty: true });
      }
    }

    return (
      <div style={{ 
        display: 'grid',
        gridTemplateColumns: `repeat(${maxColumns}, 1fr)`,
        gap: '16px',
        minHeight: '400px'
      }}>
        {allColumns.map((column, index) => (
          <div key={column.isEmpty ? `empty-${index}` : column.date} className="calendar-day-column">
            {!column.isEmpty ? (
              <>
                {/* Day Header */}
                <div className="text-center mb-3 p-2" style={{ 
                  backgroundColor: '#f8f9fa', 
                  borderRadius: '8px',
                  border: '1px solid #dee2e6'
                }}>
                  <h6 className="mb-1 text-dark fw-bold" style={{ fontSize: '0.9rem' }}>
                    {formatDate(column.date)}
                  </h6>
                  <small className="text-muted">
                    {column.slots.length} slot{column.slots.length !== 1 ? 's' : ''}
                  </small>
                </div>
            
                {/* Vertical Time Slots */}
                <div style={{ 
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  maxHeight: '350px',
                  overflowY: 'auto',
                  paddingRight: '4px',
                  scrollbarWidth: 'thin',
                  scrollbarColor: '#ccc transparent'
                }}>
                  {column.slots.length === 0 ? (
                    <div className="text-center text-muted py-3" style={{ fontSize: '0.8rem' }}>
                      <i className="bi bi-calendar-x me-1"></i>
                      No available slots
                    </div>
                  ) : (
                    column.slots.map((slot, slotIndex) => {
                    const slotKey = `${slot.start}|${slot.end}`;
                    const isSelected = isSlotSelected(slot);
                    const isConfirmed = isSlotConfirmed(slot);
                    const isBusy = isSlotBusy(slot);
                    const isAllocated = isSlotAllocated(slot);
                    const session = getSessionForSlot(slot);
                    
                    // Determine slot styling based on session status
                    let slotClass = '';
                    let slotStyle = {};
                    
                    if (isConfirmed) {
                      // Confirmed state takes priority - show green for created sessions
                      slotClass = 'calendar-slot-available'; // Use the same class as user calendar
                      slotStyle = { 
                        backgroundColor: '#28a745 !important', 
                        color: 'white !important',
                        borderColor: '#28a745 !important'
                      };
                    } else if (isSelected) {
                      // Selected state - show light green for pending creation
                      slotClass = 'text-dark';
                      slotStyle = { backgroundColor: 'rgba(25, 135, 84, 0.3)', borderColor: '#198754' };
                    } else if (session) {
                      // Session exists - show like user calendar
                      if (session.remaining > 0) {
                        slotClass = 'calendar-slot-available'; // Available session - same as user calendar
                      } else {
                        slotClass = 'bg-danger text-white'; // Full session
                      }
                    } else if (isAllocated) {
                      // Allocated slot - show yellow warning
                      slotClass = 'text-dark';
                      slotStyle = { backgroundColor: 'rgba(255, 193, 7, 0.2)', borderColor: '#ffc107' };
                    } else if (isBusy) {
                      slotClass = 'bg-secondary text-white'; // Calendar busy
                    } else {
                      slotClass = 'bg-light border-secondary'; // Free slot
                    }
                    
                    // Debug confirmed slot matching
                    if (isConfirmed || session) {
                      console.log('🎨 SLOT STYLING DEBUG:', {
                        slotKey: `${slot.start}|${slot.end}`,
                        isConfirmed,
                        isSelected,
                        hasSession: !!session,
                        sessionId: session?.id,
                        sessionRemaining: session?.remaining,
                        confirmedSlotsSize: confirmedSlots.size,
                        confirmedSlotsArray: Array.from(confirmedSlots),
                        slotClass,
                        slotStyle,
                        finalClassName: `calendar-slot calendar-slot-btn p-2 border rounded cursor-pointer position-relative ${slotClass}`
                      });
                    }

                    return (
                      <div
                        key={slotIndex}
                        className={`calendar-slot calendar-slot-btn p-2 border rounded cursor-pointer position-relative ${slotClass}`}
                        style={{ 
                          ...slotStyle,
                          cursor: isBusy || (session && session.remaining <= 0) || isAllocated ? 'not-allowed' : 'pointer',
                          opacity: isBusy || (session && session.remaining <= 0) || isAllocated ? 0.8 : 1,
                          transition: 'all 0.2s ease',
                          borderWidth: isSelected ? '2px' : '1px',
                          borderRadius: '6px',
                          fontSize: '0.8rem'
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
                          } else if (isConfirmed) {
                            console.log('Unassigning confirmed slot');
                            // Confirmed slot - allow unassigning by deselecting
                            onSlotDeselect(slot);
                          } else if (session) {
                            console.log('Selecting existing session slot');
                            // Existing session - could add edit/delete functionality here
                            // For now, just allow selection (this might need to be changed based on requirements)
                            onSlotSelect(slot);
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
                          } else if (session) {
                            e.currentTarget.style.backgroundColor = 'rgba(40, 167, 69, 0.1)';
                            e.currentTarget.style.borderColor = 'rgba(40, 167, 69, 0.3)';
                            e.currentTarget.style.transform = 'translateY(-1px)';
                            e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
                          } else {
                            e.currentTarget.style.backgroundColor = 'rgba(76, 175, 80, 0.1)';
                            e.currentTarget.style.borderColor = 'rgba(76, 175, 80, 0.3)';
                            e.currentTarget.style.transform = 'translateY(-1px)';
                            e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
                          }
                        }}
                        onMouseLeave={(e) => {
                          // Reset styles but preserve selected state
                          if (isSelected) {
                            // Restore selected state styling
                            e.currentTarget.style.backgroundColor = 'rgba(25, 135, 84, 0.3)';
                            e.currentTarget.style.borderColor = '#198754';
                          } else if (isConfirmed) {
                            // Restore confirmed state styling
                            e.currentTarget.style.backgroundColor = '';
                            e.currentTarget.style.borderColor = '';
                          } else if (isAllocated) {
                            // Restore allocated state styling (yellow background)
                            e.currentTarget.style.backgroundColor = 'rgba(255, 193, 7, 0.2)';
                            e.currentTarget.style.borderColor = '#ffc107';
                          } else {
                            // Reset to default
                            e.currentTarget.style.backgroundColor = '';
                            e.currentTarget.style.borderColor = '';
                          }
                          e.currentTarget.style.transform = '';
                          e.currentTarget.style.boxShadow = '';
                          e.currentTarget.style.cursor = '';
                        }}
                      >
                        <div className="text-center">
                          <div className="fw-semibold" style={{ fontSize: '0.75rem' }}>
                            {formatTime(slot.start)}
                          </div>
                          <div style={{ fontSize: '0.7rem', opacity: 0.8 }}>
                            {formatTime(slot.end)}
                          </div>
                          {(() => {
                            const session = getSessionForSlot(slot);
                            if (session) {
                              return (
                                <div className="mt-1" style={{ fontSize: '0.65rem' }}>
                                  {session.remaining > 0 ? (
                                    <div className="text-success">
                                      Available
                                    </div>
                                  ) : (
                                    <div className="text-danger">
                                      Booked
                                    </div>
                                  )}
                                </div>
                              );
                            } else if (isBusy) {
                              return (
                                <div className="mt-1" style={{ fontSize: '0.65rem' }}>
                                  <i className="bi bi-x-circle me-1"></i>
                                  Busy
                                </div>
                              );
                            } else if (isSelected) {
                              return (
                                <div className="mt-1" style={{ fontSize: '0.65rem' }}>
                                  Selected
                                </div>
                              );
                            } else if (isAllocated) {
                              return (
                                <div className="mt-1" style={{ fontSize: '0.65rem' }}>
                                  <i className="bi bi-exclamation-triangle me-1"></i>
                                  Overlap
                                </div>
                              );
                            } else {
                              return (
                                <div className="mt-1" style={{ fontSize: '0.65rem' }}>
                                  Available
                                </div>
                              );
                            }
                          })()}
                        </div>
                        {(isBusy || (session && session.remaining <= 0) || isAllocated) && (
                          <div className="position-absolute top-0 end-0 p-1">
                            <i className="bi bi-lock-fill text-white" style={{ fontSize: '0.6rem' }}></i>
                          </div>
                        )}
                      </div>
                    );
                  })
                  )}
                </div>
              </>
            ) : (
              /* Empty column placeholder for alignment */
              <div style={{ minHeight: '400px' }}></div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="calendar-view">
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
          <div className="calendar-timeline">
            
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
  onBack
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
  const [durationMinutes, setDurationMinutes] = useState(defaultDurationMinutes || 30); // Use prop or default to 30 minutes
  const [excludeWeekends, setExcludeWeekends] = useState(true); // Exclude weekends by default
  
  // Pagination controls - now based on days instead of slots
  const [currentPage, setCurrentPage] = useState(0);
  const [daysPerPage, setDaysPerPage] = useState(5); // Show 5 days per page by default

  // Sync confirmed slots with existing sessions
  useEffect(() => {
    const sessionSlots = new Set<string>();
    sessions.forEach(session => {
      const slotKey = `${session.start_time}|${session.end_time}`;
      sessionSlots.add(slotKey);
    });
    
    // Only update if the confirmed slots have actually changed
    const currentConfirmedSlots = Array.from(confirmedSlots).sort();
    const newConfirmedSlots = Array.from(sessionSlots).sort();
    const hasChanged = currentConfirmedSlots.length !== newConfirmedSlots.length || 
                      !currentConfirmedSlots.every((slot, index) => slot === newConfirmedSlots[index]);
    
    if (hasChanged) {
      console.log('🔄 Updating confirmed slots due to session changes:', {
        oldSlots: currentConfirmedSlots,
        newSlots: newConfirmedSlots,
        sessionsCount: sessions.length
      });
      setConfirmedSlots(sessionSlots);
      persistConfirmedSlots(sessionSlots);
    }
    
    // Debug: Log all sessions being processed
    console.log('🔄 Syncing confirmed slots with sessions:', {
      sessionsCount: sessions.length,
      sessions: sessions.map(s => ({
        id: s.id,
        start_time: s.start_time,
        end_time: s.end_time,
        capacity: s.capacity,
        booked_count: s.booked_count,
        slotKey: `${s.start_time}|${s.end_time}`
      })),
      confirmedSlotsCount: sessionSlots.size,
      confirmedSlotsArray: Array.from(sessionSlots)
    });
  }, [sessions, opportunityId]);

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
      const [eventsResult, availabilityResult] = await Promise.all([
        getCalendarEvents(startTime, actualEndTime),
        getAvailability(startTime, actualEndTime, durationMinutes, undefined, excludeWeekends)
      ]);
      
      setCalendarEvents(eventsResult);
      setAvailableSlots(availabilityResult.available_slots);
      
      // Debug: Log available slots and sessions to see if they match (only when sessions change)
      if (sessions.length > 0) {
        console.log('📅 Calendar data loaded:', {
          eventsCount: eventsResult.length,
          availableSlotsCount: availabilityResult.available_slots.length,
          sessionsCount: sessions.length,
          sessions: sessions.map(session => ({
            id: session.id,
            start_time: session.start_time,
            end_time: session.end_time,
            slotKey: `${session.start_time}|${session.end_time}`
          }))
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
      setError(err.response?.data?.error || 'Failed to load calendar data');
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

  const handleSlotDeselect = useCallback((slot: AvailableSlot) => {
    const slotKey = `${slot.start}|${slot.end}`;
    console.log('handleSlotDeselect called:', { 
      slotKey, 
      currentSelectedSlots: Array.from(selectedSlots),
      currentConfirmedSlots: Array.from(confirmedSlots),
      isInSelected: selectedSlots.has(slotKey),
      isInConfirmed: confirmedSlots.has(slotKey)
    });
    
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
  }, [selectedSlots, confirmedSlots, opportunityId]);

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
            await onOpportunitySave();
            console.log('✅ onOpportunitySave completed successfully for temporary opportunity');
          } catch (saveError) {
            console.error('❌ Error saving temporary opportunity:', saveError);
            // Don't fail the entire operation if opportunity save fails
            // Sessions were already created successfully
          }
        } else {
          console.log('⚠️ onOpportunitySave callback not provided for temporary opportunity');
        }
        
        // Refresh calendar to show updated state immediately
        await loadCalendarData();
        return;
      }

      // Check for conflicts before creating (only for saved opportunities)
      const conflictsResult = await checkConflicts(sessionData);
      if (conflictsResult.has_conflicts) {
        setError(`Cannot create sessions: ${conflictsResult.conflicting_slots} slots have conflicts with existing calendar events`);
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
              <div style={{ minWidth: '80px' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: '600', color: '#6c757d', marginBottom: '4px', display: 'block' }}>
                  Timeslot (mins)
                </label>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(parseInt(e.target.value) || 120)}
                  min="15"
                  max="480"
                  disabled={disabled}
                  placeholder="min"
                />
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
                  {availableSlots.length} slots available
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
                  {availableSlots.length === 0 && (
                    <div className="alert alert-warning mb-3">
                      <i className="bi bi-exclamation-triangle me-2"></i>
                      <strong>No available time slots found</strong> for the selected date range and duration.
                      Try adjusting the date range, duration, or including weekends.
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
