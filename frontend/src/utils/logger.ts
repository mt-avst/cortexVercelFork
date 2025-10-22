// Logging utility for development vs production
class Logger {
  private isDevelopment = process.env.NODE_ENV === 'development';

  log(message: string, ...args: any[]) {
    if (this.isDevelopment) {
      console.log(message, ...args);
    }
  }

  error(message: string, ...args: any[]) {
    if (this.isDevelopment) {
      console.error(message, ...args);
    }
    // In production, you would send this to an error reporting service
    // Example: errorReportingService.captureMessage(message, { extra: args });
  }

  warn(message: string, ...args: any[]) {
    if (this.isDevelopment) {
      console.warn(message, ...args);
    }
  }

  info(message: string, ...args: any[]) {
    if (this.isDevelopment) {
      console.info(message, ...args);
    }
  }
}

export const logger = new Logger();
export default logger;
