// Utility functions for opportunity-related operations

/**
 * Formats opportunity type for display
 * Handles cases where type might be concatenated with status (e.g., 'testpublished' -> 'TEST')
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
      return baseType.toUpperCase();
    }
  }
  
  // Handle normal type values
  switch (type.toLowerCase()) {
    case 'test':
      return 'TEST';
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
      return 'badge type-test text-white'; // Teal/cyan
    case 'interview':
      return 'badge type-interview text-white'; // Green (unique color)
    case 'poll':
      return 'badge type-poll text-white'; // Pink/magenta
    case 'survey':
      return 'badge type-survey'; // Purple (has white text in CSS)
    case 'question':
      return 'badge type-question'; // Orange (has white text in CSS)
    default:
      return 'badge bg-secondary';
  }
};
