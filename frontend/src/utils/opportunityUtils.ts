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

/*
 * `formatOpportunityType` was here. It produced the admin taxonomy - APP
 * TESTING, UNMODERATED, QUESTION - which was one of three names each type
 * carried. Cortex now has one name per type and `getParticipantFacingType`
 * below produces it, for admins and participants alike, so this had no callers
 * left. Deleted rather than kept: a second formatter is exactly how three names
 * happened.
 */

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

/**
 * Gets the CSS variable for card hover color based on opportunity type
 * Used for dynamic hover border colors that match the lozenge text color
 * @param type - The opportunity type string (can be undefined/null)
 * @returns CSS variable reference string
 */
export const getCardHoverColor = (type: string | null | undefined): string => {
  if (!type) return 'transparent';
  
  // Extract base type if concatenated with status
  const statusSuffixes = ['published', 'draft', 'closed'];
  let baseType = type;
  
  for (const suffix of statusSuffixes) {
    if (type.toLowerCase().endsWith(suffix)) {
      baseType = type.slice(0, -suffix.length);
      break;
    }
  }
  
  switch (baseType.toLowerCase()) {
    case 'test': return 'var(--lozenge-usertest-text)';
    case 'survey': return 'var(--lozenge-survey-text)';
    case 'poll': return 'var(--lozenge-poll-text)';
    case 'interview': return 'var(--lozenge-interview-text)';
    case 'question': return 'var(--lozenge-question-text)';
    case 'unmoderated': return 'var(--lozenge-unmoderated-text)';
    default: return 'transparent';
  }
};

/**
 * Gets the CSS variable for card hover background color based on opportunity type
 * Used for light mode where we want softer pastel borders
 * @param type - The opportunity type string (can be undefined/null)
 * @returns CSS variable reference string
 */
export const getCardHoverBgColor = (type: string | null | undefined): string => {
  if (!type) return 'transparent';
  
  // Extract base type if concatenated with status
  const statusSuffixes = ['published', 'draft', 'closed'];
  let baseType = type;
  
  for (const suffix of statusSuffixes) {
    if (type.toLowerCase().endsWith(suffix)) {
      baseType = type.slice(0, -suffix.length);
      break;
    }
  }
  
  switch (baseType.toLowerCase()) {
    case 'test': return 'var(--lozenge-usertest-bg)';
    case 'survey': return 'var(--lozenge-survey-bg)';
    case 'poll': return 'var(--lozenge-poll-bg)';
    case 'interview': return 'var(--lozenge-interview-bg)';
    case 'question': return 'var(--lozenge-question-bg)';
    case 'unmoderated': return 'var(--lozenge-unmoderated-bg)';
    default: return 'transparent';
  }
};

/**
 * Strips app-testing and obvious automation/smoke studies from the home listing.
 * Enable with `VITE_PRESENTATION_LISTING=true` in .env (local screenshots / demos).
 */
export function filterOpportunitiesForPresentationListing(
  opportunities: Opportunity[]
): Opportunity[] {
  return opportunities.filter((opp) => !isOpportunityExcludedForPresentation(opp));
}

function isOpportunityExcludedForPresentation(opportunity: Opportunity): boolean {
  const rawType = opportunity.type?.toLowerCase() || '';
  const baseType = rawType.replace(/published|draft|closed$/, '');
  if (baseType === 'test') return true;

  const blob = `${opportunity.title}\n${opportunity.purpose_one_liner ?? ''}`.toLowerCase();
  if (
    /\[e2e\]|\(e2e\)|\be2e\b|smoke test|playwright|m6-poll|superadmin-create|test-draft-warnings/i.test(
      blob
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Strips a status suffix that the API has been seen concatenating onto a type
 * (e.g. `unmoderatedpublished`). Shared by every type-reading helper here so a
 * fix in one place cannot drift from the others.
 */
const baseTypeOf = (type: string | null | undefined): string => {
  if (!type) return '';
  const lowered = type.toLowerCase();
  for (const suffix of ['published', 'draft', 'closed']) {
    if (lowered.endsWith(suffix)) {
      return lowered.slice(0, -suffix.length);
    }
  }
  return lowered;
};

/**
 * What a participant should be told this is.
 *
 * The browse list showed the internal taxonomy - UNMODERATED, APP TESTING,
 * QUESTION - which is the research team's vocabulary, not the vocabulary of the
 * person being asked to give up an hour. "Unmoderated" describes the absence of
 * a researcher, which is a fact about how the study is run rather than anything
 * a participant needs. `formatOpportunityType` stays as it is for admin
 * surfaces, where the real type names are what an admin is working with.
 */
export const getParticipantFacingType = (type: string | null | undefined): string => {
  switch (baseTypeOf(type)) {
    case 'unmoderated': return 'Recorded study';
    case 'test': return 'Usability test';
    case 'interview': return 'Interview';
    case 'poll': return 'Quick poll';
    case 'survey': return 'Survey';
    case 'question': return 'One question';
    // Neutral rather than the raw value: an unrecognised type reaching a
    // participant should read as a study, not as a database enum.
    default: return 'Study';
  }
};

/**
 * What to tell a participant about who can take part - or nothing, which is
 * usually the honest answer.
 *
 * The browse row and the study page each decided this separately and disagreed.
 * The row said nothing for `any`, on the grounds that "Open To All" on nearly
 * every row was noise. The page printed "Any" unconditionally, immediately
 * above a panel telling the reader the study needs a Cortex account and will
 * not work for anyone outside the organisation.
 *
 * "Any" is the untrue one. Every route to taking part requires a signed-in
 * Cortex account, and for a recorded study `external` is refused outright when
 * the opportunity is saved. `internal` is no better: everyone holding an
 * account already is internal, so it narrows nothing either.
 *
 * That leaves the two values that genuinely change whether a given person can
 * take part. Nothing server-side enforces either, so this line is the only
 * warning a participant gets - which is exactly why it must not be spent on
 * values that say nothing.
 */
export const getEligibilityNote = (opportunity: {
  participant_type_required?: 'any' | 'internal' | 'external' | 'specific';
  participant_type_specific_details?: string;
}): string | null => {
  switch (opportunity.participant_type_required) {
    case 'external':
      return 'External participants only';
    case 'specific': {
      // A bare "Specific" warns without informing: it tells someone they may be
      // ineligible and gives them no way to find out. The form requires at
      // least ten characters whenever `specific` is chosen, so an empty value
      // here is a legacy row, and silence beats an unanswerable warning.
      const details = opportunity.participant_type_specific_details?.trim();
      return details ? details : null;
    }
    default:
      return null;
  }
};

/**
 * The verb for what taking part involves.
 *
 * This carries the fork that actually governs the choice: three of the six
 * types need you at a booked time, three you can do whenever. That difference
 * was previously encoded nowhere on the card, so a participant scanning for
 * something they could do in a gap between meetings could not find one.
 */
export const getParticipantActionLabel = (type: string | null | undefined): string => {
  switch (baseTypeOf(type)) {
    case 'test':
    case 'interview':
      return 'Book a time';
    case 'poll': return 'Open poll';
    case 'survey': return 'Open survey';
    case 'question': return 'Answer';
    case 'unmoderated': return 'Start recorded study';
    default: return 'Take part';
  }
};

/**
 * What "an action" actually was, for the analytics card that counts them.
 *
 * The card described every study's actions as "Clicked link / Booked". A
 * recorded study has no link to click and nothing to book - its action is the
 * participant pressing Start - so the one figure telling a researcher how many
 * people began their study described something that cannot happen in it.
 *
 * Past tense, because this labels a count of things that already happened;
 * `getParticipantActionLabel` is the imperative a participant is offered.
 */
export const getActionMeaning = (type: string | null | undefined): string => {
  switch (baseTypeOf(type)) {
    case 'test':
    case 'interview':
      return 'Booked a time';
    case 'poll': return 'Opened the poll';
    case 'survey': return 'Opened the survey';
    case 'question': return 'Answered';
    case 'unmoderated': return 'Started the study';
    default: return 'Took part';
  }
};

/**
 * When this stops being available, or null when nothing says.
 *
 * `end_date` is the recruitment window and is authoritative where it is set.
 * A bookable study often carries no end_date at all, and its real deadline is
 * its last slot, so that is the fallback.
 */
export const getClosingTime = (opportunity: Opportunity): Date | null => {
  if (opportunity.end_date) {
    const endDate = new Date(opportunity.end_date);
    // An unparseable date must read as "unknown", never as epoch zero - which
    // would sort a broken record to the top as the most urgent thing on screen.
    if (!isNaN(endDate.getTime())) return endDate;
  }

  const sessionEnds = (opportunity.sessions ?? [])
    .map((session) => new Date(session.end_time).getTime())
    .filter((time) => !isNaN(time));

  if (sessionEnds.length === 0) return null;

  return new Date(Math.max(...sessionEnds));
};

/**
 * Closing soonest first, unknown deadlines last.
 *
 * The list rendered "4 days left" on a card and then placed that card twelfth,
 * so it displayed urgency and sorted against it. Undated studies go last rather
 * than first: an unknown deadline is not an imminent one, and sorting them to
 * the top would bury everything that genuinely is closing.
 *
 * Returns a new array - the caller's order is often the memoised input to
 * something else.
 */
export const sortByClosingSoonest = <T extends Opportunity>(opportunities: T[]): T[] => {
  const now = Date.now();

  // Three tiers, because a plain ascending sort gives an ENDED study the
  // smallest key of all and puts the longest-expired thing on the page at row
  // one. Nothing closes an opportunity automatically - autoCloseOpportunityIfNeeded
  // is only reachable from the /close-if-past route - so published-and-expired
  // is a state a participant genuinely meets.
  const tierOf = (closesAt: Date | null): number => {
    if (!closesAt) return 1;             // unknown: after the open ones
    return closesAt.getTime() < now ? 2  // ended: last
      : 0;                               // open: first
  };

  // Equal keys keep their given order because Array.prototype.sort has been
  // REQUIRED to be stable since ES2019. An explicit index tie-break was tried
  // here and removed: it is unobservable through this function at any list
  // length - mutating it to `return 1` changed nothing, even across 80 equal
  // elements - so it was code no test could ever hold to account.
  return [...opportunities].sort((a, b) => {
    const aClose = getClosingTime(a);
    const bClose = getClosingTime(b);

    const tierDiff = tierOf(aClose) - tierOf(bClose);
    if (tierDiff !== 0) return tierDiff;
    if (!aClose || !bClose) return 0;

    // Within the open tier, soonest first. Within the ended tier, most recently
    // ended first - a study that closed yesterday is more relevant than one
    // that closed in the spring.
    return tierOf(aClose) === 2
      ? bClose.getTime() - aClose.getTime()
      : aClose.getTime() - bClose.getTime();
  });
};

/**
 * The countdown for a known closing time.
 *
 * Exists so the row can derive its countdown from the SAME value the sort uses.
 * `getTimeRemaining` reads sessions and `getDirectTimeRemaining` reads
 * `end_date`, and a bookable study carrying both would have sorted by one and
 * displayed the other - two different deadlines for one study, which is worse
 * than showing none.
 */
export const getTimeRemainingUntil = (closesAt: Date | null): {
  text: string | null;
  urgency: 'normal' | 'warning' | 'critical' | 'ended';
} => {
  if (!closesAt || isNaN(closesAt.getTime())) {
    return { text: null, urgency: 'normal' };
  }

  const diffMs = closesAt.getTime() - Date.now();
  if (diffMs <= 0) {
    return { text: 'Ended', urgency: 'ended' };
  }

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) {
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    return {
      text: diffMinutes <= 1 ? 'Ending soon' : `${diffMinutes} min left`,
      urgency: 'critical'
    };
  }
  if (diffHours < 24) {
    return {
      text: diffHours === 1 ? '1 hour left' : `${diffHours} hours left`,
      urgency: 'critical'
    };
  }
  if (diffDays === 1) return { text: 'Ends tomorrow', urgency: 'warning' };
  if (diffDays < 3) return { text: `${diffDays} days left`, urgency: 'warning' };
  if (diffDays < 7) return { text: `${diffDays} days left`, urgency: 'normal' };
  if (diffDays < 14) return { text: '1 week left', urgency: 'normal' };
  return { text: `${Math.floor(diffDays / 7)} weeks left`, urgency: 'normal' };
};
