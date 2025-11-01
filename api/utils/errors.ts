/**
 * Standard error response format
 */
export interface ErrorResponse {
  error: string;
  details?: string;
}

/**
 * Create a standardized error response
 */
export function createErrorResponse(error: string, details?: string): ErrorResponse {
  const response: ErrorResponse = { error };
  if (details) {
    response.details = details;
  }
  return response;
}

/**
 * Get error message from various error types
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'An unknown error occurred';
}





