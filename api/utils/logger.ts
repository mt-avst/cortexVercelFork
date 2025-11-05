/**
 * Simple logger utility for API serverless functions
 * Provides structured logging for Vercel serverless functions
 */
import { LogContext } from '../../shared/types';

class ApiLogger {
  private isDevelopment = process.env.NODE_ENV === 'development';

  private formatLog(level: string, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...context,
    };

    return JSON.stringify(logEntry);
  }

  private log(level: string, message: string, context?: LogContext): void {
    const formattedLog = this.formatLog(level, message, context);
    // In serverless, console.log goes to Vercel logs
    console.log(formattedLog);
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
}

// Create singleton instance
export const logger = new ApiLogger();
export default logger;

