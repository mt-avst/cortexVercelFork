import axios, { AxiosError, AxiosResponse } from 'axios';
import { logger } from './logger';
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
} from '../shared/types';
import { API_CONFIG } from '../shared/constants';

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
        logger.log('API Request', {
          method: config.method?.toUpperCase(),
          url: config.url,
          baseURL: config.baseURL
        });
        return config;
      },
      (error) => {
        logger.error('API Request Error', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.axiosInstance.interceptors.response.use(
      (response: AxiosResponse) => {
        logger.log('API Response', {
          status: response.status,
          url: response.config.url,
          method: response.config.method?.toUpperCase()
        });
        return response;
      },
      (error: AxiosError) => {
        const apiError = mapAxiosError(error);
        
        logger.error('API Error', {
          status: apiError.statusCode,
          code: apiError.code,
          message: apiError.message,
          url: error.config?.url,
          method: error.config?.method?.toUpperCase(),
          requestId: apiError.requestId
        });

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
      logger.log('Redirecting to login due to 401 error');
      window.location.href = '/auth/login';
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
      stack: error.stack
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
      requestId: error.requestId
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

// Async error wrapper for React components
export const withErrorHandling = <T extends any[]>(
  fn: (...args: T) => Promise<any>,
  context?: string
) => {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (error) {
      logger.error(`Error in ${context || 'async operation'}`, error);
      throw error;
    }
  };
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
  try {
    new URL(url);
  } catch {
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

      logger.log(`Retry attempt ${attempt}/${maxRetries}`, {
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    }
  }

  throw lastError!;
};
