import { LogContext } from '@shared/types';

/**
 * WHAT AN AXIOS ERROR LOOKS LIKE ONCE JSON.stringify HAS TOUCHED IT.
 *
 * `JSON.stringify` calls a value's `toJSON()` BEFORE any replacer sees it,
 * and `AxiosError.toJSON()` returns a plain object whose `config` carries
 * `data` - the whole request body. For most routes that is harmless; for
 * `PUT /api/bookings/:id/notes` and the approve/reject pair it is a
 * researcher's free-text judgement about a named colleague, printed to the
 * console on every failed save (cto/AdaptaLabs#88). Nothing ships console
 * output today, which is exactly why this is fixed centrally now: the first
 * error-reporting integration would have shipped the leak with it, and
 * nobody adding one would think to look here.
 */
type SerialisedAxiosShape = {
  config?: { method?: unknown; url?: unknown; data?: unknown } | null;
  [key: string]: unknown;
};

const carriesRequestBody = (value: unknown): value is SerialisedAxiosShape => {
  if (value === null || typeof value !== 'object') return false;
  const config = (value as SerialisedAxiosShape).config;
  if (config === null || typeof config !== 'object') return false;
  // `data` OR `headers`, not `data` alone: axios's toJSONObject DROPS
  // undefined values, so a bodiless request (every DELETE, the cancel POST)
  // has no `data` key at all - and a data-only predicate passed the whole
  // config through, live X-CSRF-Token header included. Both review gates
  // reproduced that independently through the real client interceptor.
  return 'data' in config || 'headers' in config;
};

/**
 * The replacer applied to EVERY log line this logger emits. Central rather
 * than per call site, because a per-call-site fix is the shape that goes
 * stale the next time somebody adds a route. What it matches is the
 * serialised-axios-config SHAPE - an object whose `config` carries `data` or
 * `headers` - and for a match it keeps method and URL, drops the body, and
 * drops the headers (they carry the live CSRF token on every mutating call,
 * and Authorization material generally). It does NOT cover content logged
 * under other shapes, and it cannot reach an error-reporting SDK that
 * captures unhandled rejections with its own serialiser - that integration
 * needs its own beforeSend scrubber (cto/AdaptaLabs#102).
 */
export const redactRequestBodies = (_key: string, value: unknown): unknown => {
  if (!carriesRequestBody(value)) return value;
  const { config, ...rest } = value;
  return {
    ...rest,
    config: {
      method: config?.method,
      url: config?.url,
      // The marker only where a body existed - a bodiless call must not be
      // labelled as though something was hidden from the reader.
      ...(config && 'data' in config ? { data: '[REDACTED: request body]' } : {}),
    },
  };
};

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

    // The replacer runs on BOTH branches: a leak that only exists in
    // production logging is the kind nobody sees until it ships. And the one
    // function every log call funnels through must not itself throw out of a
    // catch block - a circular context (unreachable from a real AxiosError,
    // whose toJSON omits request and response, but reachable from a hand-built
    // context) gets a minimal line instead of taking the error path with it.
    try {
      if (this.isDevelopment) {
        return JSON.stringify(logEntry, redactRequestBodies, 2);
      }

      return JSON.stringify(logEntry, redactRequestBodies);
    } catch {
      return JSON.stringify({
        timestamp,
        level,
        message,
        logging_error: 'context was not serialisable and was dropped',
      });
    }
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
  log(message: string, ...args: unknown[]): void {
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
