import { Request, Response, NextFunction } from 'express';
import { logger, redactSensitiveUrl } from './logger';
import { 
  AppError, 
  ValidationError, 
  NotFoundError, 
  ConflictError, 
  UnauthorizedError, 
  ForbiddenError,
  ErrorResponse 
} from '../../../shared/types';
import { DB_ERROR_CODES } from '../../../shared/constants';

// Re-export error classes for local use
export { 
  AppError, 
  ValidationError, 
  NotFoundError, 
  ConflictError, 
  UnauthorizedError, 
  ForbiddenError 
};

// Database error mapping
export const mapDatabaseError = (error: any): AppError => {
  const code = error.code;
  const message = error.message;

  switch (code) {
    case DB_ERROR_CODES.UNIQUE_CONSTRAINT_VIOLATION:
      return new ConflictError('Resource already exists');
    
    case DB_ERROR_CODES.FOREIGN_KEY_CONSTRAINT_VIOLATION:
      return new NotFoundError('Referenced resource');
    
    case DB_ERROR_CODES.CHECK_CONSTRAINT_VIOLATION:
      return new ValidationError('Invalid data provided');
    
    case DB_ERROR_CODES.NOT_NULL_CONSTRAINT_VIOLATION:
      return new ValidationError('Required field is missing');
    
    case DB_ERROR_CODES.UNDEFINED_TABLE:
      return new AppError('Database table not found', 500, 'DB_TABLE_NOT_FOUND');
    
    case DB_ERROR_CODES.UNDEFINED_COLUMN:
      return new AppError('Database column not found', 500, 'DB_COLUMN_NOT_FOUND');
    
    case DB_ERROR_CODES.LOCK_NOT_AVAILABLE:
      return new ConflictError('Resource is currently locked, please try again');
    
    case DB_ERROR_CODES.CONNECTION_FAILURE:
      return new AppError('Database connection failed', 503, 'DB_CONNECTION_FAILED');
    
    default:
      return new AppError('Database operation failed', 500, 'DB_ERROR');
  }
};

// Error handler middleware
export const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const requestId = res.getHeader('X-Request-ID') as string;

  // Handle body-parser errors (malformed JSON, oversized/aborted bodies) FIRST.
  // express.json rejects these in its own middleware, before any route runs, so
  // a route-level try/catch can never see them. Without this they fall through
  // to the 500 branch — turning a participant abandoning a session mid-POST
  // (a truncated body) into a 500 with a stack trace. These are expected client
  // input, so they log at warn, not error. body-parser marks them with a
  // numeric `status`/`statusCode`, a `type` slug and `expose: true`.
  const bodyParserError = error as Error & {
    status?: number;
    statusCode?: number;
    type?: string;
    expose?: boolean;
  };
  const bodyParserStatus = bodyParserError.status ?? bodyParserError.statusCode;
  if (
    typeof bodyParserStatus === 'number' &&
    bodyParserStatus >= 400 &&
    bodyParserStatus < 500 &&
    typeof bodyParserError.type === 'string' &&
    bodyParserError.expose === true
  ) {
    logger.warn('Malformed request body rejected', {
      requestId,
      method: req.method,
      url: redactSensitiveUrl(req.url),
      errorMessage: error.message,
      userId: (req as any).user?.id,
    });

    const response: ErrorResponse = {
      error:
        bodyParserError.type === 'entity.parse.failed'
          ? 'Invalid JSON in request body'
          : 'Malformed request body',
      code: 'INVALID_REQUEST_BODY',
      timestamp: new Date().toISOString(),
      requestId,
    };

    return res.status(bodyParserStatus).json(response);
  }

  // Log the error
  logger.error('Request error', {
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

  // Handle known error types
  if (error instanceof AppError) {
    const response: ErrorResponse = {
      error: error.message,
      code: error.code,
      timestamp: new Date().toISOString(),
      requestId,
    };

    return res.status(error.statusCode).json(response);
  }

  // Handle database errors
  const dbError = error as any;
  if (dbError.code && typeof dbError.code === 'string' && dbError.code.match(/^[0-9A-Z]{5}$/)) {
    // Log the original database error for debugging
    logger.error('Database error details:', {
      requestId,
      method: req.method,
      // Redacted like every other log site in this file. Participant routes
      // are mounted at /api/firsthand/session/<token>/..., so the raw URL put
      // a live capability token in the log on any database error.
      url: redactSensitiveUrl(req.url),
      error: {
        code: dbError.code,
        message: dbError.message,
        detail: dbError.detail,
        constraint: dbError.constraint,
        table: dbError.table,
        column: dbError.column,
        stack: dbError.stack,
      } as any,
      userId: (req as any).user?.id,
    });
    
    const appError = mapDatabaseError(error);
    const response: ErrorResponse = {
      error: appError.message,
      code: appError.code,
      timestamp: new Date().toISOString(),
      requestId,
    };

    return res.status(appError.statusCode).json(response);
  }

  // Handle validation errors (Zod)
  if (error.name === 'ZodError') {
    const zodError = error as any;
    const response: ErrorResponse = {
      error: 'Validation failed',
      details: zodError.errors?.map((err: any) => `${err.path.join('.')}: ${err.message}`) || [],
      code: 'VALIDATION_ERROR',
      timestamp: new Date().toISOString(),
      requestId,
    };

    return res.status(400).json(response);
  }

  // Handle unknown errors
  const response: ErrorResponse = {
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : error.message,
    code: 'INTERNAL_ERROR',
    timestamp: new Date().toISOString(),
    requestId,
  };

  res.status(500).json(response);
};

// Async error wrapper
export const asyncHandler = <T = any>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T> | T
): ((req: Request, res: Response, next: NextFunction) => void) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Database operation wrapper with error handling
export const withDatabaseErrorHandling = async <T>(
  operation: () => Promise<T>,
  context: string
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    logger.error(`Database operation failed: ${context}`, {
      error: {
        name: (error as any).name,
        message: (error as any).message,
        stack: (error as any).stack,
        ...((error as any).code && { code: (error as any).code }),
      },
    });

    if ((error as any).code && typeof (error as any).code === 'string' && (error as any).code.match(/^[0-9A-Z]{5}$/)) {
      throw mapDatabaseError(error);
    }

    throw new AppError(`Database operation failed: ${context}`, 500, 'DB_OPERATION_FAILED');
  }
};

// Validation helper
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
