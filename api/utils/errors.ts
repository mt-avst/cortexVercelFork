/**
 * Standard error response format
 * Imports from shared/types to ensure consistency
 */
import { ErrorResponse } from '../../shared/types';
export { ErrorResponse };

/**
 * Create a standardized error response
 * Accepts details as string or string[] for convenience, but always returns string[]
 */
export function createErrorResponse(
  error: string, 
  details?: string | string[],
  code?: string,
  requestId?: string
): ErrorResponse {
  const response: ErrorResponse = { 
    error,
    timestamp: new Date().toISOString()
  };
  
  if (details) {
    // Normalize details to string[]
    response.details = Array.isArray(details) ? details : [details];
  }
  
  if (code) {
    response.code = code;
  }
  
  if (requestId) {
    response.requestId = requestId;
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

/**
 * Create a 500 error response that does not leak internal details in production.
 * Callers should log the real error (e.g. logger.error) before returning this.
 * In production, the response body uses userMessage or a generic message only.
 */
export function createSafeErrorResponse(
  error: unknown,
  options?: { userMessage?: string; code?: string; requestId?: string }
): ErrorResponse {
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  const userMessage =
    options?.userMessage ??
    (isProduction ? 'Something went wrong' : getErrorMessage(error));
  return createErrorResponse(userMessage, undefined, options?.code, options?.requestId);
}





