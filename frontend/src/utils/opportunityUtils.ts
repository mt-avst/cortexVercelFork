// Utility functions for opportunity-related operations

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
    default:
      return 'badge bg-secondary';
  }
};
