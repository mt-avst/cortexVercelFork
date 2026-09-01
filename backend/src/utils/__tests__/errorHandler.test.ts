import { Request, Response, NextFunction } from 'express';
import {
  errorHandler,
  mapDatabaseError,
  withDatabaseErrorHandling
} from '../../utils/errorHandler';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError
} from '../../../../shared/types';
import { DB_ERROR_CODES } from '../../../../shared/constants';
import {
  createMockRequest,
  createMockResponse,
  createMockNext,
  mockConsole
} from '../../../../shared/test-utils';

// Mock the logger
jest.mock('../../utils/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
  redactSensitiveUrl: (url?: string) => url,
}));

describe('Error Handler', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = createMockRequest();
    mockRes = createMockResponse() as any;
    mockNext = createMockNext();
    jest.clearAllMocks();
  });

  describe('errorHandler middleware', () => {
    it('should handle AppError correctly, carrying its details array (#101)', () => {
      const error = new ValidationError('Test validation error', ['field1', 'field2']);

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      // details is INCLUDED now: the branch used to drop it, so a batch refusal
      // reached the client as a bare message with the specifics thrown away.
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Test validation error',
        code: 'VALIDATION_ERROR',
        details: ['field1', 'field2'],
        timestamp: expect.any(String),
        requestId: undefined,
      });
    });

    it('omits details for an AppError that carries none (#101 control)', () => {
      // The control that proves details is added only when PRESENT, not always:
      // a plain ValidationError with no array must not grow an empty `details`.
      const error = new ValidationError('Just a message');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      const body = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(body).toEqual({
        error: 'Just a message',
        code: 'VALIDATION_ERROR',
        timestamp: expect.any(String),
        requestId: undefined,
      });
      expect('details' in body).toBe(false);
    });

    it('maps a body-parser JSON parse error to a clean 400, not a 500', () => {
      // express.json rejects malformed bodies in its own middleware with a
      // SyntaxError carrying status/type/expose - e.g. a participant abandoning
      // a session mid-POST truncates the body. It must not surface as a 500.
      const error = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
        status: 400,
        statusCode: 400,
        type: 'entity.parse.failed',
        expose: true,
      });

      errorHandler(error as any, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_REQUEST_BODY' })
      );
    });

    it('should handle NotFoundError correctly', () => {
      const error = new NotFoundError('User');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'User not found',
        code: 'NOT_FOUND',
        timestamp: expect.any(String),
        requestId: undefined,
      });
    });

    it('should handle ConflictError correctly', () => {
      const error = new ConflictError('Resource already exists');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(409);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Resource already exists',
        code: 'CONFLICT',
        timestamp: expect.any(String),
        requestId: undefined,
      });
    });

    it('should handle UnauthorizedError correctly', () => {
      const error = new UnauthorizedError('Invalid credentials');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Invalid credentials',
        code: 'UNAUTHORIZED',
        timestamp: expect.any(String),
        requestId: undefined,
      });
    });

    it('should handle ForbiddenError correctly', () => {
      const error = new ForbiddenError('Access denied');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Access denied',
        code: 'FORBIDDEN',
        timestamp: expect.any(String),
        requestId: undefined,
      });
    });

    it('should handle ZodError correctly', () => {
      const zodError = {
        name: 'ZodError',
        errors: [
          { path: ['field1'], message: 'Required' },
          { path: ['field2'], message: 'Invalid format' },
        ],
      };

      errorHandler(zodError as any, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Validation failed',
        details: ['field1: Required', 'field2: Invalid format'],
        code: 'VALIDATION_ERROR',
        timestamp: expect.any(String),
        requestId: undefined,
      });
    });

    it('should handle database errors correctly', () => {
      const dbError = {
        name: 'DatabaseError',
        code: DB_ERROR_CODES.UNIQUE_CONSTRAINT_VIOLATION,
        message: 'duplicate key value violates unique constraint',
      };

      errorHandler(dbError, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(409);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Resource already exists',
        code: 'CONFLICT',
        timestamp: expect.any(String),
        requestId: undefined,
      });
    });

    it('should handle unknown errors correctly', () => {
      const unknownError = new Error('Unknown error');

      errorHandler(unknownError, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Unknown error',
        code: 'INTERNAL_ERROR',
        timestamp: expect.any(String),
        requestId: undefined,
      });
    });

    it('should hide error details in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const unknownError = new Error('Sensitive error details');

      errorHandler(unknownError, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
        timestamp: expect.any(String),
        requestId: undefined,
      });

      process.env.NODE_ENV = originalEnv;
    });

    it('should include request ID when available', () => {
      mockRes.getHeader = jest.fn().mockReturnValue('req-123');
      const error = new AppError('Test error');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Test error',
        code: undefined,
        timestamp: expect.any(String),
        requestId: 'req-123',
      });
    });
  });

  describe('mapDatabaseError', () => {
    it('should map unique constraint violation to ConflictError', () => {
      const error = { code: DB_ERROR_CODES.UNIQUE_CONSTRAINT_VIOLATION };
      const result = mapDatabaseError(error);

      expect(result).toBeInstanceOf(ConflictError);
      expect(result.message).toBe('Resource already exists');
      expect(result.statusCode).toBe(409);
    });

    it('should map foreign key constraint violation to NotFoundError', () => {
      const error = { code: DB_ERROR_CODES.FOREIGN_KEY_CONSTRAINT_VIOLATION };
      const result = mapDatabaseError(error);

      expect(result).toBeInstanceOf(NotFoundError);
      expect(result.message).toBe('Referenced resource not found');
      expect(result.statusCode).toBe(404);
    });

    /**
     * A path segment that is not a uuid reaching a `uuid` column raises 22P02.
     * It used to fall through to the default and answer 500, so every route
     * keyed on an id told the caller the SERVER had broken when the caller had
     * sent nonsense - on GET /:id, /:id/analytics, /:id/session-events and both
     * survey-results routes at once.
     */
    it('should map an unparseable value to ValidationError rather than a 500', () => {
      const error = { code: DB_ERROR_CODES.INVALID_TEXT_REPRESENTATION };
      const result = mapDatabaseError(error);

      expect(result).toBeInstanceOf(ValidationError);
      expect(result.statusCode).toBe(400);
      expect(result.message).toBe('Malformed identifier');
    });

    /**
     * 400 and not 404, deliberately. 22P02 is raised by ANY unparseable
     * literal, including one this codebase passed in itself, and reporting our
     * own bad value as "not found" would hide a real bug behind an ordinary
     * looking response.
     */
    /**
     * The pg code as a LITERAL, not via the constant. Every assertion above
     * reads DB_ERROR_CODES, so they all move with it - repointing the constant
     * at a code Postgres never raises leaves them green while the mapping is
     * dead. This is the one that holds the value itself to account.
     */
    it('maps the code Postgres actually raises, 22P02', () => {
      const result = mapDatabaseError({ code: '22P02' });

      expect(result).toBeInstanceOf(ValidationError);
      expect(result.statusCode).toBe(400);
    });

    /**
     * A cancelled statement is transient, and it is newly reachable.
     *
     * Nothing in this application set `statement_timeout` until the FirstHand
     * runtime pool began issuing one per checkout, so 57014 previously could
     * not happen. It is now reachable from EVERY route rather than only the
     * FirstHand ones: cto/AdaptaLabs#40 put a 120s server-side bound on the
     * shared backend pool too (config/index.ts), which makes this mapping the
     * difference between a retryable 503 and an opaque 500 on the whole surface.
     * Unmapped it fell to the default arm and answered 500
     * "Database operation failed" - which on the participant answer-save path
     * tells somebody mid-survey that the server is broken, with no reason to
     * retry, on the one path where not retrying loses answers they have
     * already given.
     */
    it('maps a cancelled statement to a retryable 503, not a broken server', () => {
      const result = mapDatabaseError({ code: DB_ERROR_CODES.QUERY_CANCELED });

      expect(result.statusCode).toBe(503);
      expect(result.code).toBe('DB_STATEMENT_TIMEOUT');
      expect(result.message).toMatch(/try again/i);
    });

    // The literal, for the same reason 22P02 is pinned above: every assertion
    // that reads the constant moves with it, so repointing DB_ERROR_CODES at a
    // code Postgres never raises would leave the mapping dead and green.
    it('maps the code Postgres actually raises for a timeout, 57014', () => {
      expect(mapDatabaseError({ code: '57014' }).statusCode).toBe(503);
    });

    it('does not report an unparseable value as a missing resource', () => {
      const result = mapDatabaseError({ code: DB_ERROR_CODES.INVALID_TEXT_REPRESENTATION });

      expect(result).not.toBeInstanceOf(NotFoundError);
      expect(result.statusCode).not.toBe(404);
    });

    it('should map check constraint violation to ValidationError', () => {
      const error = { code: DB_ERROR_CODES.CHECK_CONSTRAINT_VIOLATION };
      const result = mapDatabaseError(error);

      expect(result).toBeInstanceOf(ValidationError);
      expect(result.message).toBe('Invalid data provided');
      expect(result.statusCode).toBe(400);
    });

    it('should map not null constraint violation to ValidationError', () => {
      const error = { code: DB_ERROR_CODES.NOT_NULL_CONSTRAINT_VIOLATION };
      const result = mapDatabaseError(error);

      expect(result).toBeInstanceOf(ValidationError);
      expect(result.message).toBe('Required field is missing');
      expect(result.statusCode).toBe(400);
    });

    it('should map undefined table to AppError', () => {
      const error = { code: DB_ERROR_CODES.UNDEFINED_TABLE };
      const result = mapDatabaseError(error);

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toBe('Database table not found');
      expect(result.statusCode).toBe(500);
      expect(result.code).toBe('DB_TABLE_NOT_FOUND');
    });

    it('should map undefined column to AppError', () => {
      const error = { code: DB_ERROR_CODES.UNDEFINED_COLUMN };
      const result = mapDatabaseError(error);

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toBe('Database column not found');
      expect(result.statusCode).toBe(500);
      expect(result.code).toBe('DB_COLUMN_NOT_FOUND');
    });

    it('should map lock not available to ConflictError', () => {
      const error = { code: DB_ERROR_CODES.LOCK_NOT_AVAILABLE };
      const result = mapDatabaseError(error);

      expect(result).toBeInstanceOf(ConflictError);
      expect(result.message).toBe('Resource is currently locked, please try again');
      expect(result.statusCode).toBe(409);
    });

    it('should map connection failure to AppError', () => {
      const error = { code: DB_ERROR_CODES.CONNECTION_FAILURE };
      const result = mapDatabaseError(error);

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toBe('Database connection failed');
      expect(result.statusCode).toBe(503);
      expect(result.code).toBe('DB_CONNECTION_FAILED');
    });

    it('should map unknown database error to generic AppError', () => {
      const error = { code: 'UNKNOWN_ERROR' };
      const result = mapDatabaseError(error);

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toBe('Database operation failed');
      expect(result.statusCode).toBe(500);
      expect(result.code).toBe('DB_ERROR');
    });
  });

  describe('withDatabaseErrorHandling', () => {
    it('should return result when operation succeeds', async () => {
      const mockOperation = jest.fn().mockResolvedValue('success');

      const result = await withDatabaseErrorHandling(mockOperation, 'test context');

      expect(result).toBe('success');
      expect(mockOperation).toHaveBeenCalled();
    });

    it('should map database errors and rethrow', async () => {
      const dbError = { code: DB_ERROR_CODES.UNIQUE_CONSTRAINT_VIOLATION };
      const mockOperation = jest.fn().mockRejectedValue(dbError);

      await expect(withDatabaseErrorHandling(mockOperation, 'test context'))
        .rejects.toThrow(ConflictError);
    });

    it('should wrap unknown errors in AppError', async () => {
      const unknownError = new Error('Unknown error');
      const mockOperation = jest.fn().mockRejectedValue(unknownError);

      await expect(withDatabaseErrorHandling(mockOperation, 'test context'))
        .rejects.toThrow(AppError);
    });
  });
});
