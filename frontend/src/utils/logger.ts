import { LogContext } from '../../../shared/types';

/**
 * Logger class for structured logging with different levels and contexts
 * 
 * Provides consistent logging across the frontend application with support for:
 * - Different log levels (info, warn, error, debug)
 * - Structured JSON output in production
 * - Pretty-printed output in development
 * - Contextual information (user ID, request ID, etc.)
 * - Request ID propagation from backend responses
 */
class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development';
  private isProduction = process.env.NODE_ENV === 'production';
  private currentRequestId: string | null = null;

  /**
   * Set the current request ID from API responses
   * This allows correlating frontend logs with backend logs
   */
  setRequestId(requestId: string | null): void {
    this.currentRequestId = requestId;
  }

  /**
   * Get the current request ID
   */
  getRequestId(): string | null {
    return this.currentRequestId;
  }

  /**
   * Generate a unique request ID if one doesn't exist
   */
  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Format log entry as structured JSON
   */
  private formatLog(level: string, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const logEntry: LogContext = {
      timestamp,
      level,
      message,
      requestId: context?.requestId || this.currentRequestId || this.generateRequestId(),
      ...context,
    };

    if (this.isDevelopment) {
      return JSON.stringify(logEntry, null, 2);
    }

    return JSON.stringify(logEntry);
  }

  /**
   * Internal log method that handles formatting and output
   */
  private internalLog(level: string, message: string, context?: LogContext): void {
    const formattedLog = this.formatLog(level, message, context);
    
    if (this.isDevelopment) {
      // Pretty print in development
      console.log(formattedLog);
    } else if (this.isProduction) {
      // Structured JSON in production
      // In production, you would send logs to a service like:
      // - Winston with file/console transports
      // - Logstash
      // - CloudWatch
      // - Datadog
      // - New Relic
      console.log(formattedLog);
    }
  }

  /**
   * Log an info message
   */
  info(message: string, context?: LogContext): void {
    this.internalLog('INFO', message, context);
  }

  /**
   * Log a warning message
   */
  warn(message: string, context?: LogContext): void {
    this.internalLog('WARN', message, context);
  }

  /**
   * Log an error message
   */
  error(message: string, context?: LogContext): void {
    this.internalLog('ERROR', message, context);
  }

  /**
   * Log a debug message (only in development)
   */
  debug(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      this.internalLog('DEBUG', message, context);
    }
  }

  /**
   * Log a simple message (backward compatibility)
   * @deprecated Use info() with context for better structured logging
   */
  log(message: string, ...args: any[]): void {
    if (this.isDevelopment) {
      // For backward compatibility, support old logging style
      const context: LogContext = {
        requestId: this.currentRequestId || this.generateRequestId(),
        ...(args.length > 0 && { extra: args }),
      };
      this.info(message, context);
    }
  }

  /**
   * Log API request
   */
  apiRequest(method: string, url: string, context?: LogContext): void {
    this.debug('API Request', {
      method: method.toUpperCase(),
      url,
      requestId: context?.requestId || this.currentRequestId || undefined,
      ...context,
    });
  }

  /**
   * Log API response
   */
  apiResponse(method: string, url: string, statusCode: number, responseTime?: number, context?: LogContext): void {
    this.debug('API Response', {
      method: method.toUpperCase(),
      url,
      statusCode,
      responseTime,
      requestId: context?.requestId || this.currentRequestId || undefined,
      ...context,
    });
  }

  /**
   * Log API error
   */
  apiError(method: string, url: string, statusCode: number, error: Error | string, context?: LogContext): void {
    this.error('API Error', {
      method: method.toUpperCase(),
      url,
      statusCode,
      error: error instanceof Error ? error : undefined,
      errorDetails: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      } : { message: String(error) },
      requestId: context?.requestId || this.currentRequestId || undefined,
      ...context,
    });
  }

  /**
   * Log user action/event
   */
  userEvent(event: string, context?: LogContext): void {
    this.info(`User event: ${event}`, {
      requestId: context?.requestId || this.currentRequestId || undefined,
      ...context,
    });
  }

  /**
   * Log component lifecycle event
   */
  componentEvent(component: string, event: string, context?: LogContext): void {
    if (this.isDevelopment) {
      this.debug(`Component event: ${component}.${event}`, {
        component,
        event,
        requestId: context?.requestId || this.currentRequestId || undefined,
        ...context,
      });
    }
  }
}

export const logger = new Logger();
export default logger;
