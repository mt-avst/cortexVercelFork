import axios, { AxiosError, AxiosResponse } from 'axios';
import { logger } from './logger';
import { authNavigation } from './navigation';
import { 
  AppError, 
  ValidationError, 
  NotFoundError, 
  ConflictError, 
  UnauthorizedError, 
  ForbiddenError,
  TimeoutError,
  NetworkError,
  ErrorResponse 
} from '../api/types';
import { API_CONFIG } from '@shared/constants';

// Re-export error types for convenience
export { 
  AppError, 
  ValidationError, 
  NotFoundError, 
  ConflictError, 
  UnauthorizedError, 
  ForbiddenError,
  TimeoutError,
  NetworkError
};

// Error mapping from Axios errors
export const mapAxiosError = (error: AxiosError): AppError => {
  const response = error.response;
  const requestId = response?.headers['x-request-id'] as string;

  if (response) {
    const errorData = response.data as ErrorResponse;
    
    return new AppError(
      errorData.error || error.message,
      response.status,
      errorData.code,
      errorData.details,
      requestId
    );
  }

  // Network or timeout errors
  if (error.code === 'ECONNABORTED') {
    return new TimeoutError('Request timeout');
  }

  if (error.code === 'NETWORK_ERROR' || !error.response) {
    return new NetworkError('Network error');
  }

  return new AppError('Unknown error occurred', 500, 'UNKNOWN_ERROR');
};

// Enhanced API client with error handling
export class ApiClient {
  private axiosInstance = axios.create({
    timeout: API_CONFIG.TIMEOUT_MS,
    withCredentials: true,
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    }
  });

  constructor(baseURL: string) {
    this.axiosInstance.defaults.baseURL = baseURL;
    this.setupInterceptors();
  }

  private setupInterceptors() {
    // Request interceptor
    this.axiosInstance.interceptors.request.use(
      (config) => {
        // Generate request ID if not present
        const requestId = config.headers['X-Request-ID'] as string || 
                         `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        config.headers['X-Request-ID'] = requestId;
        
        const startTime = Date.now();
        (config as any).__startTime = startTime;
        
        logger.apiRequest(config.method || 'GET', config.url || '', {
          requestId,
          baseURL: config.baseURL,
        });
        
        return config;
      },
      (error) => {
        logger.apiError('REQUEST', error.config?.url || '', 0, error, {
          requestId: error.config?.headers?.['X-Request-ID'] as string,
        });
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.axiosInstance.interceptors.response.use(
      (response: AxiosResponse) => {
        // Extract request ID from response headers
        const requestId = response.headers['x-request-id'] as string || 
                         response.config.headers?.['X-Request-ID'] as string;
        if (requestId) {
          logger.setRequestId(requestId);
        }
        
        const startTime = (response.config as any).__startTime;
        const responseTime = startTime ? Date.now() - startTime : undefined;
        
        logger.apiResponse(
          response.config.method || 'GET',
          response.config.url || '',
          response.status,
          responseTime,
          { requestId }
        );
        
        return response;
      },
      (error: AxiosError) => {
        const apiError = mapAxiosError(error);
        const requestId = error.response?.headers?.['x-request-id'] as string ||
                         error.config?.headers?.['X-Request-ID'] as string ||
                         apiError.requestId;
        
        if (requestId) {
          logger.setRequestId(requestId);
        }
        
        const startTime = (error.config as any)?.__startTime;
        const responseTime = startTime ? Date.now() - startTime : undefined;
        
        logger.apiError(
          error.config?.method?.toUpperCase() || 'UNKNOWN',
          error.config?.url || '',
          apiError.statusCode,
          apiError,
          {
            requestId,
            responseTime,
            code: apiError.code,
          }
        );

        // Handle authentication errors
        if (apiError.statusCode === 401) {
          this.handleUnauthorized();
        }

        return Promise.reject(apiError);
      }
    );
  }

  private handleUnauthorized() {
    // Only redirect if not already on login page
    if (window.location.pathname !== '/' && 
        !window.location.pathname.includes('/auth/')) {
      logger.info('Redirecting to login due to 401 error', {
        requestId: logger.getRequestId() || undefined,
        url: window.location.pathname,
      });
      authNavigation.toGenericLogin();
    }
  }

  async get<T>(url: string, config?: any): Promise<T> {
    try {
      const response = await this.axiosInstance.get<T>(url, config);
      return response.data;
    } catch (error) {
      throw mapAxiosError(error as AxiosError);
    }
  }

  async post<T>(url: string, data?: any, config?: any): Promise<T> {
    try {
      const response = await this.axiosInstance.post<T>(url, data, config);
      return response.data;
    } catch (error) {
      throw mapAxiosError(error as AxiosError);
    }
  }

  async patch<T>(url: string, data?: any, config?: any): Promise<T> {
    try {
      const response = await this.axiosInstance.patch<T>(url, data, config);
      return response.data;
    } catch (error) {
      throw mapAxiosError(error as AxiosError);
    }
  }

  async delete<T>(url: string, config?: any): Promise<T> {
    try {
      const response = await this.axiosInstance.delete<T>(url, config);
      return response.data;
    } catch (error) {
      throw mapAxiosError(error as AxiosError);
    }
  }
}

// Error boundary hook for functional components
export const useErrorHandler = () => {
  const handleError = (error: Error, context?: string) => {
    logger.error(`Error in ${context || 'component'}`, {
      name: error.name,
      message: error.message,
      stack: error.stack,
      requestId: logger.getRequestId() || undefined,
      component: context,
    });

    // In production, you would send this to an error reporting service
    if (process.env.NODE_ENV === 'production') {
      // Example: errorReportingService.captureException(error, { context });
    }
  };

  const handleApiError = (error: AppError, context?: string) => {
    logger.error(`API Error in ${context || 'component'}`, {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      requestId: error.requestId || logger.getRequestId() || undefined,
      component: context,
    });

    // Handle specific error types
    switch (error.code) {
      case 'VALIDATION_ERROR':
        // Show validation errors to user
        break;
      case 'CONFLICT':
        // Handle conflict errors (e.g., already booked)
        break;
      case 'NOT_FOUND':
        // Handle not found errors
        break;
      default:
        // Handle generic errors
        break;
    }
  };

  return { handleError, handleApiError };
};

// Validation helpers
export const validateRequired = (value: any, fieldName: string): void => {
  if (value === undefined || value === null || value === '') {
    throw new ValidationError(`${fieldName} is required`);
  }
};

export const validateEmail = (email: string): void => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new ValidationError('Invalid email format');
  }
};

export const validateUrl = (url: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('Invalid URL format');
  }
  // User-provided links are rendered as hrefs - only web URLs are acceptable
  // (rejects javascript:, data:, ftp: and other schemes)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Invalid URL format');
  }
};

// Error message formatter for UI
export const formatErrorMessage = (error: AppError): string => {
  if (error.details && error.details.length > 0) {
    return `${error.message}: ${error.details.join(', ')}`;
  }
  return error.message;
};

// Retry mechanism for failed requests
export const withRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = API_CONFIG.MAX_RETRIES,
  delay: number = API_CONFIG.RETRY_DELAY_MS
): Promise<T> => {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === maxRetries) {
        break;
      }

      // Don't retry on certain error types
      if (error instanceof AppError) {
        if ([400, 401, 403, 404].includes(error.statusCode)) {
          break;
        }
      }

      logger.warn(`Retry attempt ${attempt}/${maxRetries}`, {
        error: error instanceof Error ? error : undefined,
        errorDetails: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : { message: error instanceof Error ? error.message : 'Unknown error' },
        requestId: logger.getRequestId() || undefined,
      });

      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    }
  }

  throw lastError!;
};
