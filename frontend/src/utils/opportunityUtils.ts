// Utility functions for opportunity-related operations

import { Session, Opportunity } from '../api/types';

/**
 * Gets the study date range from sessions
 * @param sessions - Array of session objects
 * @returns Object with formatted date range string, or null if no valid sessions
 */
export const getStudyDateRange = (sessions: Session[] | undefined): { 
  startDate: Date | null; 
  endDate: Date | null; 
  formatted: string | null;
} => {
  if (!sessions || sessions.length === 0) {
    return { startDate: null, endDate: null, formatted: null };
  }

  // Filter to future sessions only and get valid dates
  const now = new Date();
  const validSessions = sessions.filter(s => {
    const endTime = new Date(s.end_time);
    return !isNaN(endTime.getTime());
  });

  if (validSessions.length === 0) {
    return { startDate: null, endDate: null, formatted: null };
  }

  // Find earliest start and latest end
  const startDates = validSessions.map(s => new Date(s.start_time));
  const endDates = validSessions.map(s => new Date(s.end_time));
  
  const startDate = new Date(Math.min(...startDates.map(d => d.getTime())));
  const endDate = new Date(Math.max(...endDates.map(d => d.getTime())));

  // Format the date range
  const formatDate = (date: Date): string => {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const startFormatted = formatDate(startDate);
  const endFormatted = formatDate(endDate);

  // If same day, just show one date
  if (startDate.toDateString() === endDate.toDateString()) {
    return { startDate, endDate, formatted: startFormatted };
  }

  return { 
    startDate, 
    endDate, 
    formatted: `${startFormatted} - ${endFormatted}` 
  };
};

/**
 * Gets the time remaining until the last session ends
 * @param sessions - Array of session objects
 * @returns Object with countdown string and urgency level
 */
export const getTimeRemaining = (sessions: Session[] | undefined): {
  text: string | null;
  urgency: 'normal' | 'warning' | 'critical' | 'ended';
} => {
  if (!sessions || sessions.length === 0) {
    return { text: null, urgency: 'normal' };
  }

  // Find the latest session end time
  const now = new Date();
  const futureSessions = sessions.filter(s => {
    const endTime = new Date(s.end_time);
    return !isNaN(endTime.getTime()) && endTime > now;
  });

  if (futureSessions.length === 0) {
    // Check if all sessions have passed
    const allSessions = sessions.filter(s => !isNaN(new Date(s.end_time).getTime()));
    if (allSessions.length > 0) {
      return { text: 'Ended', urgency: 'ended' };
    }
    return { text: null, urgency: 'normal' };
  }

  // Get the latest end time from future sessions
  const latestEnd = new Date(Math.max(...futureSessions.map(s => new Date(s.end_time).getTime())));
  
  const diffMs = latestEnd.getTime() - now.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Determine urgency level
  let urgency: 'normal' | 'warning' | 'critical' | 'ended' = 'normal';
  if (diffDays < 1) {
    urgency = 'critical';
  } else if (diffDays < 3) {
    urgency = 'warning';
  }

  // Format the countdown text
  let text: string;
  if (diffHours < 1) {
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    text = diffMinutes <= 1 ? 'Ending soon' : `${diffMinutes} min left`;
    urgency = 'critical';
  } else if (diffHours < 24) {
    text = diffHours === 1 ? '1 hour left' : `${diffHours} hours left`;
  } else if (diffDays === 1) {
    text = 'Ends tomorrow';
  } else if (diffDays < 7) {
    text = `${diffDays} days left`;
  } else if (diffDays < 14) {
    text = '1 week left';
  } else {
    const weeks = Math.floor(diffDays / 7);
    text = `${weeks} weeks left`;
  }

  return { text, urgency };
};

/**
 * Checks if an opportunity type uses external links (no sessions)
 * @param type - The opportunity type
 * @returns true if the type uses external links
 */
export const isExternalLinkType = (type: string | null | undefined): boolean => {
  if (!type) return false;
  return ['poll', 'survey', 'question', 'unmoderated'].includes(type.toLowerCase());
};

/**
 * Formats opportunity type for display
 * Handles cases where type might be concatenated with status (e.g., 'testpublished' -> 'APP TESTING')
 * @param type - The opportunity type string (can be undefined/null)
 * @returns Formatted type string in uppercase
 */
export const formatOpportunityType = (type: string | null | undefined): string => {
  if (!type) {
    return 'UNKNOWN';
  }
  
  // Handle concatenated type+status values by removing common status suffixes
  const statusSuffixes = ['published', 'draft', 'closed'];
  
  for (const suffix of statusSuffixes) {
    if (type.toLowerCase().endsWith(suffix)) {
      const baseType = type.slice(0, -suffix.length);
      // Check if base type is 'test' and return 'APP TESTING'
      if (baseType.toLowerCase() === 'test') {
        return 'APP TESTING';
      }
      return baseType.toUpperCase();
    }
  }
  
  // Handle normal type values
  switch (type.toLowerCase()) {
    case 'test':
      return 'APP TESTING';
    case 'interview':
      return 'INTERVIEW';
    case 'poll':
      return 'POLL';
    case 'survey':
      return 'SURVEY';
    case 'question':
      return 'QUESTION';
    case 'unmoderated':
      return 'UNMODERATED';
    default:
      return type.toUpperCase();
  }
};

/**
 * Gets the appropriate CSS class for opportunity type badges
 * @param type - The opportunity type string (can be undefined/null)
 * @returns CSS class string
 */
export const getTypeBadgeClass = (type: string | null | undefined): string => {
  if (!type) {
    return 'badge bg-secondary';
  }
  
  // Extract base type if it's concatenated with status
  const statusSuffixes = ['published', 'draft', 'closed'];
  let baseType = type;
  
  for (const suffix of statusSuffixes) {
    if (type.toLowerCase().endsWith(suffix)) {
      baseType = type.slice(0, -suffix.length);
      break;
    }
  }
  
  switch (baseType.toLowerCase()) {
    case 'test':
      return 'lozenge lozenge-usertest';
    case 'interview':
      return 'lozenge lozenge-interview';
    case 'poll':
      return 'lozenge lozenge-poll';
    case 'survey':
      return 'lozenge lozenge-survey';
    case 'question':
      return 'lozenge lozenge-question';
    case 'unmoderated':
      return 'lozenge lozenge-unmoderated';
    default:
      return 'badge bg-secondary';
  }
};

/**
 * Gets the study date range from direct start_date and end_date fields
 * @param opportunity - Opportunity object with optional start_date and end_date
 * @returns Object with formatted date range string, or null if no valid dates
 */
export const getDirectDateRange = (opportunity: Opportunity): { 
  startDate: Date | null; 
  endDate: Date | null; 
  formatted: string | null;
} => {
  const startDateStr = opportunity.start_date;
  const endDateStr = opportunity.end_date;
  
  // If neither date is set, return null
  if (!startDateStr && !endDateStr) {
    return { startDate: null, endDate: null, formatted: null };
  }

  const formatDate = (date: Date): string => {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  let startDate: Date | null = null;
  let endDate: Date | null = null;

  if (startDateStr) {
    startDate = new Date(startDateStr);
    if (isNaN(startDate.getTime())) startDate = null;
  }

  if (endDateStr) {
    endDate = new Date(endDateStr);
    if (isNaN(endDate.getTime())) endDate = null;
  }

  // If both dates invalid, return null
  if (!startDate && !endDate) {
    return { startDate: null, endDate: null, formatted: null };
  }

  // Format the date range
  if (startDate && endDate) {
    const startFormatted = formatDate(startDate);
    const endFormatted = formatDate(endDate);
    
    // If same day, just show one date
    if (startDate.toDateString() === endDate.toDateString()) {
      return { startDate, endDate, formatted: startFormatted };
    }
    
    return { 
      startDate, 
      endDate, 
      formatted: `${startFormatted} - ${endFormatted}` 
    };
  }

  // Only start date
  if (startDate) {
    return { startDate, endDate: null, formatted: `Starts ${formatDate(startDate)}` };
  }

  // Only end date
  if (endDate) {
    return { startDate: null, endDate, formatted: `Ends ${formatDate(endDate)}` };
  }

  return { startDate: null, endDate: null, formatted: null };
};

/**
 * Gets the time remaining until the opportunity end_date
 * @param opportunity - Opportunity object with optional end_date
 * @returns Object with countdown string and urgency level
 */
export const getDirectTimeRemaining = (opportunity: Opportunity): {
  text: string | null;
  urgency: 'normal' | 'warning' | 'critical' | 'ended';
} => {
  const endDateStr = opportunity.end_date;
  
  if (!endDateStr) {
    return { text: null, urgency: 'normal' };
  }

  const endDate = new Date(endDateStr);
  if (isNaN(endDate.getTime())) {
    return { text: null, urgency: 'normal' };
  }

  const now = new Date();
  
  // Check if the end date has passed
  if (endDate <= now) {
    return { text: 'Ended', urgency: 'ended' };
  }

  const diffMs = endDate.getTime() - now.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Determine urgency level
  let urgency: 'normal' | 'warning' | 'critical' | 'ended' = 'normal';
  if (diffDays < 1) {
    urgency = 'critical';
  } else if (diffDays < 3) {
    urgency = 'warning';
  }

  // Format the countdown text
  let text: string;
  if (diffHours < 1) {
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    text = diffMinutes <= 1 ? 'Ending soon' : `${diffMinutes} min left`;
    urgency = 'critical';
  } else if (diffHours < 24) {
    text = diffHours === 1 ? '1 hour left' : `${diffHours} hours left`;
  } else if (diffDays === 1) {
    text = 'Ends tomorrow';
  } else if (diffDays < 7) {
    text = `${diffDays} days left`;
  } else if (diffDays < 14) {
    text = '1 week left';
  } else {
    const weeks = Math.floor(diffDays / 7);
    text = `${weeks} weeks left`;
  }

  return { text, urgency };
};
