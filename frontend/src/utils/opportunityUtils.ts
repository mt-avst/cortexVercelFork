// Utility functions for opportunity-related operations

/**
 * Formats opportunity type for display
 * Handles cases where type might be concatenated with status (e.g., 'testpublished' -> 'TEST')
 * @param type - The opportunity type string
 * @returns Formatted type string in uppercase
 */
export const formatOpportunityType = (type: string): string => {
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
 * @param type - The opportunity type string
 * @returns CSS class string
 */
export const getTypeBadgeClass = (type: string): string => {
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
      return 'badge bg-primary';
    case 'poll':
      return 'badge bg-info';
    case 'survey':
      return 'badge bg-success';
    case 'question':
      return 'badge bg-warning';
    default:
      return 'badge bg-secondary';
  }
};
