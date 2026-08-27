import { Request, Response } from 'express';
import { LogContext } from '../../../shared/types';

/** Query parameters that carry a live credential and must never be logged. */
const SENSITIVE_QUERY_PARAMS = [
  'code',
  'state',
  'id_token',
  'access_token',
  'refresh_token',
  'token',
] as const;

/**
 * Redacts live credentials from a URL before it is logged, preserving
 * everything else for debugging.
 *
 * Two kinds:
 * - Participant session bearer tokens carried as a path segment
 *   (/api/firsthand/session/<token>/...) - an opaque capability.
 * - OAuth parameters in the query string. The Okta callback lands at
 *   /auth/callback?code=...&state=..., so without this the full authorization
 *   code was written to logs on every login, twice (request started and
 *   completed). Single-use and short-lived, but a live credential in a log
 *   aggregator all the same.
 */
export function redactSensitiveUrl(url: string | undefined): string | undefined {
  if (!url) return url;

  const pathRedacted = url.replace(/(\/session\/)[^/?#]+/g, '$1[REDACTED]');

  // Redact the query by PARSING it, not by matching the raw string (#84). A raw
  // regex over `?code=...` misses what the route's own parser (qs) still reads
  // as `code`: a percent-encoded name (`?%63ode=SECRET`) and bracket notation
  // (`?code[0]=SECRET`) both decode/normalise to `code` for the handler but
  // slip past a literal `code=` match, leaking the value to the log. Matching
  // the decoded base name closes both.
  const queryStart = pathRedacted.indexOf('?');
  if (queryStart === -1) return pathRedacted;

  const fragmentStart = pathRedacted.indexOf('#', queryStart);
  const queryString =
    fragmentStart === -1
      ? pathRedacted.slice(queryStart + 1)
      : pathRedacted.slice(queryStart + 1, fragmentStart);
  const fragment = fragmentStart === -1 ? '' : pathRedacted.slice(fragmentStart);

  const sensitive = SENSITIVE_QUERY_PARAMS as readonly string[];
  let changed = false;

  // Per-segment, so every non-sensitive parameter is preserved byte-for-byte
  // (no re-encoding of values like `redirect=/admin`); only a sensitive value is
  // rewritten, and its raw name is kept.
  const redactedQuery = queryString
    .split('&')
    .map((segment) => {
      if (segment === '') return segment;
      const eq = segment.indexOf('=');
      const rawName = eq === -1 ? segment : segment.slice(0, eq);

      // Match on the DECODED base name: `qs` reads `code[0]`/`code[foo]` as
      // `code`, and percent-decodes `%63ode` to `code`, so both must compare
      // equal to `code` here even though the raw string does not.
      let decodedName: string;
      try {
        decodedName = decodeURIComponent(rawName.replace(/\+/g, ' '));
      } catch {
        decodedName = rawName;
      }
      const baseName = decodedName.split('[')[0].toLowerCase();

      if (sensitive.includes(baseName)) {
        changed = true;
        return `${rawName}=[REDACTED]`;
      }
      return segment;
    })
    .join('&');

  // Only rewrite when something was actually redacted, so a URL carrying no
  // credential is logged exactly as received.
  if (!changed) return pathRedacted;

  return `${pathRedacted.slice(0, queryStart + 1)}${redactedQuery}${fragment}`;
}

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
  private isTest = process.env.NODE_ENV === 'test';

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

    if (this.isDevelopment || this.isProduction) {
      // In production, you would send logs to a service like:
      // - Winston with file/console transports
      // - Logstash
      // - CloudWatch
      // - Datadog
      // - New Relic
      console.log(formattedLog);
      return;
    }

    // Tests are deliberately quiet.
    if (this.isTest) {
      return;
    }

    // Anything else - an unset, misspelled or new NODE_ENV - degrades to
    // NOISY, never silent. This branch previously fell through and wrote
    // nothing, which meant every error log in the app vanished on an
    // unrecognised value. That is worse than the failure it hides: the pool
    // error guard added in !86 is a log line and nothing else, so a silent
    // logger converts a crash into total silence. Issue #3.
    console.error(formattedLog);
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
      // The inbound x-request-id is REFLECTED into a response header, so it is
      // held to a shape before it is trusted (#43): a bare string of 1-128
      // characters from the charset below. Node's HTTP parser joins a repeated
      // header into ONE comma-separated string (measured, not assumed - the
      // array branch below is defence in depth for a hand-built req, not a
      // shape the wire produces), a CR or LF in the value makes `setHeader`
      // throw a 500 out of the logging middleware, and the length was
      // unbounded. Anything off-shape gets a generated id rather than a
      // refusal - a junk correlation id is not a reason to fail the request
      // it was meant to correlate.
      const rawRequestId = req.headers['x-request-id'];
      const requestId =
        typeof rawRequestId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(rawRequestId)
          ? rawRequestId
          : `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Add request ID to response headers
      res.setHeader('X-Request-ID', requestId);

      // Log request start
      this.info('Request started', {
        requestId,
        method: req.method,
        url: redactSensitiveUrl(req.url),
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
          url: redactSensitiveUrl(req.url),
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
        url: redactSensitiveUrl(req.url),
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
