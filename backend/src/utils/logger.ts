import { Request, Response } from 'express';
import { LogContext } from '../../../shared/types';

/**
 * Logger class for structured logging with different levels and contexts
 * 
 * Provides consistent logging across the application with support for:
 * - Different log levels (info, warn, error, debug)
 * - Structured JSON output in production
 * - Pretty-printed output in development
 * - Request/response logging middleware
 * - Contextual information (user ID, request ID, etc.)
 */
export class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development';
  private isProduction = process.env.NODE_ENV === 'production';

  private formatLog(level: string, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...context,
    };

    if (this.isDevelopment) {
      return JSON.stringify(logEntry, null, 2);
    }

    return JSON.stringify(logEntry);
  }

  private log(level: string, message: string, context?: LogContext): void {
    const formattedLog = this.formatLog(level, message, context);
    
    if (this.isDevelopment) {
      console.log(formattedLog);
    } else if (this.isProduction) {
      // In production, you would send logs to a service like:
      // - Winston with file/console transports
      // - Logstash
      // - CloudWatch
      // - Datadog
      // - New Relic
      console.log(formattedLog);
    }
  }

  info(message: string, context?: LogContext): void {
    this.log('INFO', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('WARN', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('ERROR', message, context);
  }

  debug(message: string, context?: LogContext): void {
    if (this.isDevelopment) {
      this.log('DEBUG', message, context);
    }
  }

  // Request logging middleware
  requestLogger() {
    return (req: Request, res: Response, next: Function) => {
      const startTime = Date.now();
      const requestId = req.headers['x-request-id'] as string || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // Add request ID to response headers
      res.setHeader('X-Request-ID', requestId);

      // Log request start
      this.info('Request started', {
        requestId,
        method: req.method,
        url: req.url,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        userId: (req as any).user?.id,
      });

      // Override res.end to log response
      const originalEnd = res.end;
      res.end = function(chunk?: any, encoding?: any): Response {
        const responseTime = Date.now() - startTime;
        
        logger.info('Request completed', {
          requestId,
          method: req.method,
          url: req.url,
          statusCode: res.statusCode,
          responseTime,
          userId: (req as any).user?.id,
        });

        return originalEnd.call(this, chunk, encoding);
      };

      next();
    };
  }

  // Error logging middleware
  errorLogger() {
    return (error: Error, req: Request, res: Response, next: Function) => {
      const requestId = res.getHeader('X-Request-ID') as string;
      
      this.error('Request error', {
        requestId,
        method: req.method,
        url: req.url,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        userId: (req as any).user?.id,
      });

      next(error);
    };
  }

  // Database operation logging
  dbOperation(operation: string, table: string, context?: LogContext): void {
    this.debug(`Database ${operation} on ${table}`, context);
  }

  // Authentication logging
  authEvent(event: string, context?: LogContext): void {
    this.info(`Auth event: ${event}`, context);
  }

  // Business logic logging
  businessEvent(event: string, context?: LogContext): void {
    this.info(`Business event: ${event}`, context);
  }
}

// Create singleton instance
export const logger = new Logger();
export default logger;
