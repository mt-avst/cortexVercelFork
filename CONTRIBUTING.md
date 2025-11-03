# Contributing Guide

This guide provides patterns, conventions, and best practices for contributing to the Adaptalabs codebase.

## Table of Contents

1. [Code Structure](#code-structure)
2. [Type Definitions](#type-definitions)
3. [Validation Patterns](#validation-patterns)
4. [Error Handling](#error-handling)
5. [Authentication & Authorization](#authentication--authorization)
6. [Logging](#logging)
7. [Database Patterns](#database-patterns)

---

## Code Structure

The codebase follows a clear separation of concerns:

```
/
├── backend/          # Express.js backend server
├── frontend/         # React frontend application
├── api/             # Vercel serverless functions
└── shared/           # Shared types, constants, and utilities
```

### Key Principles

- **Shared Code**: Types, constants, and utilities used by multiple layers should be in `shared/`
- **No Duplication**: Never duplicate type definitions. Always import from `shared/types/index.ts`
- **Consistent Imports**: Use consistent import paths based on location:
  - From `frontend/src`: `../../../shared/types`
  - From `backend/src`: `../../../shared/types`
  - From `api/`: `../../shared/types`

---

## Type Definitions

### Single Source of Truth

**All type definitions must be in `shared/types/index.ts`**

❌ **Don't**:
```typescript
// frontend/src/shared/types.ts (DUPLICATE - NEVER DO THIS)
export interface User { ... }
```

✅ **Do**:
```typescript
// shared/types/index.ts (SINGLE SOURCE OF TRUTH)
export interface User { ... }

// frontend/src/api/types.ts
export * from '../../../shared/types';
```

### Importing Types

✅ **Correct import paths**:

```typescript
// From frontend/src/components/...
import { User, Opportunity } from '../../../shared/types';

// From backend/src/routes/...
import { User, Opportunity } from '../../../shared/types';

// From api/utils/...
import { SessionUser } from '../../shared/types';
```

---

## Validation Patterns

We use **multiple validation approaches** depending on the context:

### Pattern 1: Zod Schemas (Preferred)

Use Zod schemas for standard CRUD operations with request body validation.

✅ **When to use**:
- Standard form data validation
- Request body validation in Express routes
- Type-safe validation that can be reused

**Example**:
```typescript
// backend/src/validation/schemas.ts
export const CreateOpportunitySchema = z.object({
  type: OpportunityTypeSchema,
  title: z.string().min(4).max(140),
  purpose_one_liner: z.string().min(10).max(180),
  default_duration_minutes: z.number().int().min(5).max(240).optional(),
  status: z.enum(['draft', 'published']).optional(),
});

// backend/src/routes/opportunities.ts
router.post(
  '/', 
  requireAdmin, 
  validateRequest(CreateOpportunitySchema),  // ✅ Zod validation middleware
  asyncHandler(async (req, res) => {
    // req.body is already validated and typed
    const data = req.body; // Type: CreateOpportunityRequest
    // ...
  })
);
```

### Pattern 2: Manual Validation (For Complex Cases)

Use manual validation functions for complex business logic that Zod doesn't handle well.

✅ **When to use**:
- Array validation with complex rules
- Cross-field validation
- Complex date/time logic
- Business rule validation that's difficult to express in Zod

**Example**:
```typescript
// backend/src/routes/sessions.ts
const validateSessionData = (data: CreateSessionRequest | UpdateSessionRequest): string[] => {
  const errors: string[] = [];
  
  if ('start_time' in data && 'end_time' in data && 
      data.start_time !== undefined && data.end_time !== undefined) {
    const startTime = new Date(data.start_time);
    const endTime = new Date(data.end_time);
    if (startTime >= endTime) {
      errors.push('End time must be after start time');
    }
  }
  
  if ('capacity' in data && data.capacity !== undefined) {
    if (!Number.isInteger(data.capacity) || data.capacity < 1 || data.capacity > 500) {
      errors.push('Capacity must be an integer between 1 and 500');
    }
  }
  
  return errors;
};

router.post(
  '/', 
  requireAdmin,
  asyncHandler(async (req, res) => {
    const validationErrors = validateSessionData(req.body); // ✅ Manual validation
    if (validationErrors.length > 0) {
      throw new ValidationError('Validation failed', validationErrors);
    }
    // ...
  })
);
```

### Pattern 3: Database Constraints (API Routes)

For API serverless functions, we rely more on database constraints and runtime checks.

✅ **When to use**:
- Serverless functions where middleware is less convenient
- When database constraints provide sufficient validation
- For performance-critical endpoints

**Example**:
```typescript
// api/bookings/sessions/[id]/book.ts
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Guardrails with clear error messages
  if (session.opportunity_status !== 'published') {
    return res.status(404).json(createErrorResponse('Session not found or opportunity not published'));
  }

  if (new Date(session.end_time) <= new Date()) {
    return res.status(400).json(createErrorResponse('Cannot book past sessions'));
  }

  // Database constraints handle the rest
  // ...
}
```

### Validation Strategy Decision Tree

```
Is it a standard form/request body?
├─ Yes → Use Zod Schema (Pattern 1)
└─ No → Is it complex business logic?
    ├─ Yes → Use Manual Validation (Pattern 2)
    └─ No → Use Database Constraints + Runtime Checks (Pattern 3)
```

### Best Practices

1. **Use Zod where possible** - It's type-safe and maintainable
2. **Document why manual validation is used** - Add comments explaining why Zod wasn't used
3. **Consistent error messages** - Use consistent error message format across all validation
4. **Return early** - Validate and return errors early in the request handler
5. **Don't duplicate validation** - If Zod middleware validates, don't also validate manually

---

## Error Handling

### Error Response Format

All errors must follow the standard `ErrorResponse` format:

```typescript
interface ErrorResponse {
  error: string;
  details?: string[];  // Always array, never single string
  code?: string;
  timestamp: string;
  requestId?: string;
}
```

### Error Classes

Use the error classes from `shared/types/index.ts`:

```typescript
import { 
  AppError, 
  ValidationError, 
  NotFoundError, 
  ConflictError,
  UnauthorizedError,
  ForbiddenError
} from '../../../shared/types';

// ✅ Correct usage
throw new ValidationError('Validation failed', ['field1 is required']);
throw new NotFoundError('Opportunity');
throw new ConflictError('Session is already booked');
```

### Backend Error Handling

All async route handlers must use `asyncHandler`:

```typescript
import { asyncHandler } from '../utils/errorHandler';

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  // ✅ Correct - errors automatically caught and passed to error middleware
}));
```

### API Route Error Handling

```typescript
import { createErrorResponse, getErrorMessage } from '../utils/errors';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // ...
  } catch (error: unknown) {
    // ✅ Always use createErrorResponse for consistency
    return res.status(500).json(
      createErrorResponse('Failed to process request', getErrorMessage(error))
    );
  }
}
```

---

## Authentication & Authorization

### Backend Express Routes

Use middleware for authentication:

```typescript
import { requireAuth, requireAdmin, optionalAuth } from '../middleware/authenticate';

// ✅ Require authentication
router.get('/my-data', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user!.id; // User is guaranteed to exist
}));

// ✅ Require admin role
router.post('/admin-action', requireAdmin, asyncHandler(async (req, res) => {
  // Only researcher_admin can access
}));

// ✅ Optional authentication (public endpoint, but attach user if logged in)
router.get('/public-data', optionalAuth, asyncHandler(async (req, res) => {
  const userId = req.user?.id; // User might not exist
}));
```

### API Serverless Functions

Use helper functions:

```typescript
import { requireAuth, parseSessionCookie } from '../utils/auth';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ✅ Require authentication
  const user = requireAuth(req); // Throws if not authenticated
  const userId = user.id;

  // ✅ Optional authentication
  const user = parseSessionCookie(req);
  if (user && user.role === 'researcher_admin') {
    // Admin-specific logic
  }
}
```

### SessionUser Type

**Always import from shared types**:

```typescript
// ✅ Correct
import { SessionUser } from '../../shared/types';

// ❌ Don't define your own
interface SessionUser { ... } // WRONG!
```

---

## Logging

### Structured Logging

Use structured logging with context for consistent, searchable logs:

```typescript
import { logger } from '../utils/logger';

// ✅ Backend logging
logger.info('Request processed', {
  requestId: 'req-123',
  userId: user.id,
  method: 'POST',
  url: '/api/opportunities',
});

logger.error('Database error', {
  requestId: 'req-123',
  error: {
    name: error.name,
    message: error.message,
    stack: error.stack,
  },
  userId: user.id,
});

logger.dbOperation('SELECT', 'opportunities', {
  requestId: 'req-123',
  userId: user.id,
});

logger.businessEvent('opportunity_created', {
  requestId: 'req-123',
  opportunityId: opportunity.id,
  userId: user.id,
});

// ✅ Frontend logging
logger.info('User action', {
  requestId: logger.getRequestId(),  // Automatically set from API responses
  action: 'book_session',
  sessionId: 'session-123',
});

logger.apiRequest('GET', '/api/opportunities', {
  requestId: logger.getRequestId(),
});

logger.apiResponse('GET', '/api/opportunities', 200, 150, {
  requestId: logger.getRequestId(),
});

logger.apiError('GET', '/api/sessions/123', 404, error, {
  requestId: logger.getRequestId(),
});

logger.userEvent('session_booked', {
  requestId: logger.getRequestId(),
  sessionId: 'session-123',
});

logger.componentEvent('OpportunityDetail', 'mounted', {
  requestId: logger.getRequestId(),
  opportunityId: opportunity.id,
});
```

### Request ID Propagation

Request IDs enable correlating logs across frontend and backend for the same request:

**Backend Flow:**
1. Request middleware generates or extracts `X-Request-ID` header
2. Request ID is added to response headers (`X-Request-ID`)
3. All backend logs include the request ID in context

**Frontend Flow:**
1. API client (`ApiClient` or legacy `api` instance) generates request ID if not present
2. Request ID is sent in `X-Request-ID` header with each request
3. Response interceptor extracts `x-request-id` from response headers
4. Request ID is stored in logger via `logger.setRequestId()`
5. All subsequent frontend logs automatically include the request ID via `logger.getRequestId()`

**Implementation:**

```typescript
// Backend: middleware/requestLogger.ts
const requestId = req.headers['x-request-id'] || `req-${Date.now()}-${Math.random()...}`;
res.setHeader('X-Request-ID', requestId);

// Frontend: api/client.ts or utils/errorHandler.ts
api.interceptors.response.use((response) => {
  const requestId = response.headers['x-request-id'];
  if (requestId) {
    logger.setRequestId(requestId);  // Store for all subsequent logs
  }
  return response;
});
```

**Best Practices:**
- Always include `requestId` in log context when available
- Use `logger.getRequestId()` in frontend to get the current request ID
- Request IDs are automatically generated if not provided
- Both `apiClient` and legacy `api` instance handle request ID extraction

---

## Database Patterns

### Backend (Express)

Use connection pooling:

```typescript
import { pool } from '../config';

const result = await pool.query('SELECT * FROM opportunities WHERE id = $1', [id]);
```

### API (Serverless)

Use the `query` helper for connection management:

```typescript
import { query } from '../db';

const result = await query('SELECT * FROM opportunities WHERE id = $1', [id]);
```

### Best Practices

1. **Always use parameterized queries** - Never concatenate user input into SQL
2. **Use transactions** - For operations that must be atomic
3. **Handle errors** - Map database errors to application errors
4. **Connection management** - Let the helper handle connections in serverless

---

## TypeScript Best Practices

### Strict Typing

1. **Use proper types** - Don't use `any` unless absolutely necessary
2. **Type guards** - Use type guards for runtime type checking
3. **Shared types** - Always use types from `shared/types/index.ts`

### Import Organization

```typescript
// 1. External dependencies
import { Router, Request, Response } from 'express';
import { z } from 'zod';

// 2. Internal utilities
import { logger } from '../utils/logger';
import { asyncHandler } from '../utils/errorHandler';

// 3. Shared types and constants
import { Opportunity, CreateOpportunityRequest } from '../../../shared/types';
import { DB_ERROR_CODES } from '../../../shared/constants';

// 4. Middleware
import { requireAdmin } from '../middleware/authenticate';
```

---

## Testing

### Writing Tests

1. **Unit tests** - Test individual functions in isolation
2. **Integration tests** - Test routes and API endpoints
3. **Type tests** - Use TypeScript's type system to catch errors

### Test File Location

- Unit tests: `__tests__/` folder next to the file
- Integration tests: `__tests__/` folder in routes directory

---

## Code Review Checklist

Before submitting code, ensure:

- [ ] All types imported from `shared/types/index.ts` (no duplicates)
- [ ] All async routes use `asyncHandler` wrapper
- [ ] Error responses follow `ErrorResponse` format
- [ ] Validation uses appropriate pattern (Zod preferred)
- [ ] Logging uses structured format with context
- [ ] Authentication/authorization checks in place
- [ ] Database queries use parameterized queries
- [ ] TypeScript compiles without errors
- [ ] No linter errors

---

## Questions?

If you're unsure about which pattern to use, ask in code review or check existing code for similar patterns. Consistency is more important than perfection!

---

*Last updated: 2025-01-27 - Enhanced with complete logging patterns and request ID propagation details*

