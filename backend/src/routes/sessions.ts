import { Router, Request, Response } from 'express';
import { pool } from '../config';
import { requireAdmin, requireSuperadmin, optionalAuth } from '../middleware/authenticate';
import { asyncHandler, ValidationError, NotFoundError, ForbiddenError, ConflictError } from '../utils/errorHandler';
import { logger } from '../utils/logger';
import { isDatabaseAvailable } from '../utils/database';
import { autoCloseOpportunityIfNeeded } from '../utils/opportunityLifecycle';
import { MAX_TIME_SLOTS_PER_REQUEST, NEW_SESSION_PAST_GRACE_MS, validateNewSessionData, validateSessionData } from '../validation/schemas';
import { Session, CreateSessionRequest, UpdateSessionRequest } from '../types';
import { getMockOpportunity, addMockSessions, getMockSessions, getAllMockSessions, updateMockSession, deleteMockSession } from '../../../demo/mock-data';
import { isOpportunityOwner } from '../utils/opportunityOwnership';
import { findPublishProblem } from '../../../shared/firsthand/publish-readiness';
import { MODERATED_CONSENT_TYPES } from '../../../shared/firsthand/consent-templates';

const router: Router = Router();

/**
 * The only columns PATCH /api/sessions/:id may write.
 *
 * These are exactly the four fields of `UpdateSessionRequest` in
 * shared/types. Kept as a runtime Set rather than derived from the type,
 * because the type is what erased and let the injection through in the first
 * place - a compile-time contract cannot refuse a request.
 *
 * Adding a column here widens what a request body can reach into the SET
 * clause. Do not add one without checking it is safe for an admin to set
 * directly: `booked_count` and `opportunity_id` are both columns on this table
 * and neither belongs to a caller.
 */
const UPDATABLE_SESSION_COLUMNS: ReadonlySet<string> = new Set([
  'start_time',
  'end_time',
  'capacity',
  'location_or_meet_link_optional',
]);

// Helper function to check session ownership (superadmin can access any)
// Three-way rather than one boolean so the two callers can follow !215's
// disposition (abea2c6): a superadmin is entitled to the truth and can
// enumerate every session anyway, so 'missing' becomes an honest 404 for them,
// while a researcher_admin gets 403 for both 'missing' and 'forbidden' and
// cannot use the status as an existence oracle. See enforceSessionOwnership.
type SessionOwnership = 'ok' | 'forbidden' | 'missing';

const checkSessionOwnership = async (sessionId: string, userId: string, userRole: string): Promise<SessionOwnership> => {
  // Superadmins can access any session that exists.
  if (userRole === 'superadmin') {
    const result = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
    return result.rows.length > 0 ? 'ok' : 'missing';
  }

  const result = await pool.query(`
    SELECT o.owner_user_id
    FROM sessions s
    JOIN opportunities o ON s.opportunity_id = o.id
    WHERE s.id = $1
  `, [sessionId]);

  if (result.rows.length === 0) return 'missing';
  return isOpportunityOwner(result.rows[0], { id: userId }) ? 'ok' : 'forbidden';
};

// The single policy point for the 404/403 split. Only a superadmin learns that a
// session genuinely does not exist; everyone else gets 403 for both "not yours"
// and "no such session", so the status leaks nothing about which ids exist.
const enforceSessionOwnership = (access: SessionOwnership, userRole: string, refusal: string): void => {
  if (access === 'ok') return;
  if (access === 'missing' && userRole === 'superadmin') {
    throw new NotFoundError('Session');
  }
  throw new ForbiddenError(refusal);
};

// Helper function to check for overlapping sessions
const checkSessionOverlaps = async (
  opportunityId: string, 
  startTime: Date, 
  endTime: Date, 
  excludeSessionId?: string,
  client?: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }
): Promise<boolean> => {
  let query = `
    SELECT COUNT(*) as overlap_count
    FROM sessions 
    WHERE opportunity_id = $1 
    AND (
      (start_time < $3 AND end_time > $2)
    )
  `;
  const params: (string | Date)[] = [opportunityId, startTime, endTime];
  
  if (excludeSessionId) {
    query += ` AND id != $4`;
    params.push(excludeSessionId);
  }
  
  const result = client ? await client.query(query, params) : await pool.query(query, params);
  return parseInt(result.rows[0].overlap_count) > 0;
};


/**
 * PATCH-only: a session may KEEP a past start it already has - editing the
 * capacity or meeting link of a session that has started is legitimate, and a
 * client that echoes unchanged fields must not be refused for it - but it may
 * not be MOVED into the past. Without this, the create-only rule (#90) was
 * one request from undone: POST a future session, PATCH its start to 1999,
 * and because the booking route's temporal guard reads END time, the result
 * was bookable. Found by the security gate on the #90 diff.
 *
 * Same grace as the create rule, same reason: a retime to "now" arriving
 * seconds late is not an attack. An unparseable requested start is left for
 * validateSessionData's own arm (NaN comparisons are all false here).
 */
const pastRetimingError = (
  requestedStart: string | undefined,
  currentStart: string | Date
): string | null => {
  if (requestedStart === undefined) return null;
  // Typed here for the same reason validateNewSessionData types the create
  // path: new Date(null) is the epoch, so without this a null start earned
  // the retiming sentence instead of a type error.
  if (typeof requestedStart !== 'string') {
    return 'Start time must be a valid ISO date string';
  }
  const requested = new Date(requestedStart).getTime();
  if (requested === new Date(currentStart).getTime()) return null;
  if (requested < Date.now() - NEW_SESSION_PAST_GRACE_MS) {
    return 'Start time must not be moved into the past';
  }
  return null;
};

// Helper function to format time for error messages
const formatTime = (dateString: string): string => {
  return new Date(dateString).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
};

// POST /api/sessions - Create sessions for an opportunity
router.post('/', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { opportunity_id, sessions } = req.body;
  
  if (!opportunity_id) {
    throw new ValidationError('opportunity_id is required');
  }
  
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new ValidationError('sessions array is required and must not be empty');
  }

  // #22. Beside the emptiness check rather than further down, because every
  // path below this - mock and database alike - is per-element work, and the
  // database one is a query AND an INSERT each, sequentially, outside a
  // transaction. See MAX_TIME_SLOTS_PER_REQUEST for the number and the refusal.
  if (sessions.length > MAX_TIME_SLOTS_PER_REQUEST) {
    throw new ValidationError(
      `sessions array must not exceed ${MAX_TIME_SLOTS_PER_REQUEST} entries`
    );
  }

  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const opportunity = getMockOpportunity(opportunity_id);
    if (!opportunity) {
      throw new NotFoundError('Study');
    }
    
    // Check ownership (superadmins can add sessions to any)
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!isSuperadmin && !isOpportunityOwner(opportunity, req.user)) {
      throw new ForbiddenError('Only the owner can add sessions to this study');
    }
    
    // Validate all sessions
    const validationErrors: string[] = [];
    sessions.forEach((session: CreateSessionRequest, index: number) => {
      const errors = validateNewSessionData(session);
      errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
    });
    
    if (validationErrors.length > 0) {
      throw new ValidationError('Validation failed', validationErrors);
    }
    
    // Create mock sessions
    const createdSessions = addMockSessions(opportunity_id, sessions);
    
    return res.status(201).json(createdSessions);
  }
  
  // Check opportunity ownership
  const opportunityCheck = await pool.query(
    'SELECT owner_user_id FROM opportunities WHERE id = $1',
    [opportunity_id]
  );
  
  if (opportunityCheck.rows.length === 0) {
    throw new NotFoundError('Study');
  }
  
  // Check ownership (superadmins can add sessions to any)
  const isOwner = isOpportunityOwner(opportunityCheck.rows[0], req.user);
  const isSuperadmin = req.user!.role === 'superadmin';
  if (!isSuperadmin && !isOwner) {
    throw new ForbiddenError('Only the owner can add sessions to this study');
  }
  
  // Validate all sessions
  const validationErrors: string[] = [];
  sessions.forEach((session: CreateSessionRequest, index: number) => {
    const errors = validateNewSessionData(session);
    errors.forEach(error => validationErrors.push(`Session ${index + 1}: ${error}`));
  });
  
  if (validationErrors.length > 0) {
    throw new ValidationError('Validation failed', validationErrors);
  }
  
  // ONE TRANSACTION FOR THE WHOLE BATCH (cto/AdaptaLabs#42).
  //
  // #22 capped this array at MAX_TIME_SLOTS_PER_REQUEST, which BOUNDS the work.
  // It does not make it ATOMIC, and those are different properties. Before this,
  // the checks and the inserts each ran on their own pooled connection with no
  // BEGIN, so a failure at element k - a constraint violation, a statement
  // timeout, a dropped connection, an aborted request - left elements 0..k-1
  // committed and the caller holding an error that names none of them. A retry
  // of the same payload then overlaps the rows the failed attempt just created
  // and fails looking like the caller's fault.
  //
  // That is the shape #22's own reasoning refused elsewhere in the same MR: the
  // cap was chosen as one constant refusing the WHOLE batch precisely because
  // "partial creation leaves a half-populated calendar with nothing saying which
  // half". The refusal path honoured that; the success path did not.
  //
  // THE CHECK AND THE INSERT ARE INTERLEAVED ON ONE CLIENT, deliberately. Run as
  // two phases - every check, then every insert - the checks cannot see rows the
  // batch itself is about to add, so a request whose OWN slots overlap each other
  // was accepted and committed. Interleaved, element k's check sees elements
  // 0..k-1 inside the transaction and refuses with the same 409 as any other
  // overlap. This is a deliberate narrowing and it converges on the sibling
  // route: POST /api/opportunities/:id/sessions already refuses an intra-batch
  // overlap (with its own O(N^2) in-memory scan).
  //
  // "CONVERGES" IS PARTIAL, precisely. The sibling checks the batch against
  // ITSELF only, in memory, and never against rows already in the table; this
  // one checks against both, because the query it runs sees committed rows and
  // the transaction's own. So the two now agree on intra-batch overlap and
  // still differ on pre-existing overlap. Do not read the sentence above as
  // "the two routes behave the same".
  //
  // AND THE MOCK BRANCH ABOVE HAS NO OVERLAP CHECK AT ALL. With no database,
  // `addMockSessions` takes whatever it is given, so an overlapping batch is
  // still a 201 there. Pre-existing and dev-only - `isDatabaseAvailable()` is
  // false only when there is no database - but this change widens the gap
  // between the two branches rather than narrowing it, so it is written down
  // here rather than left for someone to rediscover from a demo.
  const client = await pool.connect();
  const createdSessions = [];
  try {
    await client.query('BEGIN');

    for (const session of sessions) {
      const startTime = new Date(session.start_time);
      const endTime = new Date(session.end_time);
      // Same client as the inserts, so it reads the transaction's own rows.
      const hasOverlap = await checkSessionOverlaps(opportunity_id, startTime, endTime, undefined, client);
      if (hasOverlap) {
        throw new ConflictError(`Session overlaps with existing sessions: ${formatTime(session.start_time)} - ${formatTime(session.end_time)}`);
      }

      const result = await client.query(
        `INSERT INTO sessions (
          opportunity_id,
          start_time,
          end_time,
          capacity,
          booked_count,
          location_or_meet_link_optional
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *, (capacity - booked_count) as remaining`,
        [
          opportunity_id,
          // The instant that was VALIDATED is the instant that is stored:
          // V8 and Postgres disagree on offset-less strings (measured: an
          // hour apart on this machine), so the raw input could store an
          // instant the past-start rule never saw. Normalising to ISO UTC
          // makes the two parsers read the same value.
          new Date(session.start_time).toISOString(),
          new Date(session.end_time).toISOString(),
          session.capacity || 1,
          0, // booked_count starts at 0
          session.location_or_meet_link_optional || null,
        ]
      );

      const created = result.rows[0];
      createdSessions.push({
        ...created,
        start_time: created.start_time.toISOString(),
        end_time: created.end_time.toISOString(),
        created_at: created.created_at.toISOString(),
        updated_at: created.updated_at.toISOString(),
      });
    }

    await client.query('COMMIT');
  } catch (error) {
    // Never let a failing ROLLBACK mask the error that caused it. A dropped
    // connection is one of the failures this transaction exists to survive, and
    // it makes the ROLLBACK throw as well - which would replace a 409 or a
    // constraint error with a connection error and lose the real cause.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // Outside the transaction on purpose: it is a separate, idempotent write on
  // the opportunity, and holding the batch's transaction open across it would
  // widen the window this fix exists to close.
  await autoCloseOpportunityIfNeeded(opportunity_id);

  res.status(201).json(createdSessions);
}));

// PATCH /api/sessions/:id - Update a session
router.patch('/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id: sessionId } = req.params;
  const data: UpdateSessionRequest = req.body;

  // THE ALLOW-LIST IS THE INJECTION FIX. Read this before touching the update
  // builder below.
  //
  // That builder interpolates the request body's KEYS into the SET clause -
  // `updateFields.push(`${key} = $${paramCount}`)` - and parameterises only the
  // values. So a key was SQL, and nothing upstream stopped it being anything:
  //
  //   `const data: UpdateSessionRequest = req.body`
  //
  // is a TYPE ANNOTATION. It erases at runtime and strips nothing, which is
  // precisely why this was invisible - the line reads exactly like validation.
  // `validateSessionData` did not close it either: it is POSITIVE-ONLY, checking
  // the three fields it knows about and never rejecting a fourth.
  //
  // A body key of
  //
  //   "location_or_meet_link_optional = (SELECT email FROM users LIMIT 1), capacity"
  //
  // produced valid Postgres with the parameter numbering intact, and
  // `RETURNING *` handed the result back in the response. Any researcher_admin
  // with one session they owned could read `users` and `bookings` - the
  // participant data the trust model in routes/firsthand.ts says never leaves
  // the researcher who recruited them. The same hole allowed mass assignment:
  // `{"opportunity_id": "..."}` moved a session and its bookings under an
  // opportunity the caller did not own, walking around the ownership gate at
  // :124 rather than defeating it.
  //
  // WHY AN ALLOW-LIST RATHER THAN ESCAPING THE KEY. There is no legitimate case
  // for a caller-chosen column name here. The set is the four fields of
  // `UpdateSessionRequest`, and anything else is a bug or an attack.
  //
  // WHY IT REFUSES RATHER THAN DROPS. Silently ignoring an unknown field tells
  // the caller their update succeeded when part of it did not happen.
  //
  // The message names the PERMITTED fields and never echoes what was sent: the
  // offending key is attacker-chosen text, and reflecting it into a response
  // body puts it one careless render away from being a second vulnerability.
  //
  // ONLY THE FIRST ARGUMENT REACHES THE CALLER. errorHandler serialises an
  // AppError as `{ error: error.message, code, timestamp, requestId }` and
  // drops the details array entirely. So the second argument below reaches
  // NEITHER the wire NOR the log - errorHandler logs only name, message and
  // stack. It is inert, and an earlier draft of this comment claimed it was
  // "for the log", which was wrong.
  //
  // That is why the offending keys go in the `logger.warn` explicitly. An
  // operator watching an injection attempt needs to see what was attempted,
  // and the log is safe to put them in precisely because it is not the
  // response. Bounded, because the body can carry thousands of keys.
  //
  // It also changes what a mutation means here: putting the key in the
  // DETAILS survives the regression test and is genuinely not a leak, while
  // putting it in the MESSAGE fails that test by name. Both measured.
  const unknownFields = Object.keys(data ?? {}).filter(
    (key) => !UPDATABLE_SESSION_COLUMNS.has(key)
  );
  if (unknownFields.length > 0) {
    logger.warn('Refused a session update naming a column outside the allow-list', {
      sessionId,
      userId: req.user?.id,
      count: unknownFields.length,
      // Bounded on BOTH axes. The count cap was here from the start; the
      // length cap was not, and `express.json()` is mounted with no `limit`,
      // so one key can be 100kb of attacker-chosen text. A log line is the
      // right place for these - it is not the response - but not at any size.
      fields: unknownFields.slice(0, 10).map((field) => field.slice(0, 64))
    });
    throw new ValidationError('Validation failed', [
      `Only ${[...UPDATABLE_SESSION_COLUMNS].join(', ')} may be updated`
    ]);
  }

  // Validate data
  const errors = validateSessionData(data);
  if (errors.length > 0) {
    throw new ValidationError('Validation failed', errors);
  }
  
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const sessions = getAllMockSessions(); // Get all sessions
    const session = sessions.find(s => s.id === sessionId);

    // Only a superadmin learns a session genuinely does not exist; everyone
    // else gets 403 for both "no such session" and "not yours", matching the
    // database path so this dev-only path is not an existence oracle either
    // (cto/AdaptaLabs#33 / !215).
    if (!session) {
      if (req.user!.role === 'superadmin') {
        throw new NotFoundError('Session');
      }
      throw new ForbiddenError('Only the owner can edit this session');
    }

    // Check ownership through opportunity (superadmins can edit any)
    const opportunity = getMockOpportunity(session.opportunity_id);
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!opportunity || (!isSuperadmin && !isOpportunityOwner(opportunity, req.user))) {
      throw new ForbiddenError('Only the owner can edit this session');
    }
    
    const mockRetiming = pastRetimingError(data.start_time, session.start_time);
    if (mockRetiming) {
      throw new ValidationError('Validation failed', [mockRetiming]);
    }

    // Update mock session
    const updatedSession = updateMockSession(sessionId, data);
    if (!updatedSession) {
      throw new NotFoundError('Session');
    }
    
    return res.json(updatedSession);
  }
  
  // Check session ownership (superadmins can edit any; a superadmin gets an
  // honest 404 for a session that does not exist - see enforceSessionOwnership)
  const access = await checkSessionOwnership(sessionId, req.user!.id, req.user!.role);
  enforceSessionOwnership(access, req.user!.role, 'Only the owner can edit this session');
  
  // Get current session data
  const currentSession = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  if (currentSession.rows.length === 0) {
    throw new NotFoundError('Session');
  }
  
  const currentSessionData = currentSession.rows[0];
  
  // Check capacity constraint
  if (data.capacity !== undefined && data.capacity < currentSessionData.booked_count) {
    throw new ValidationError(`Cannot reduce capacity below current bookings (${currentSessionData.booked_count})`);
  }

  const retiming = pastRetimingError(data.start_time, currentSessionData.start_time);
  if (retiming) {
    throw new ValidationError('Validation failed', [retiming]);
  }
  
  // Use transaction to prevent race conditions during overlap check and update
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check for overlaps if time is being changed (inside transaction)
    if (data.start_time || data.end_time) {
      const startTime = data.start_time ? new Date(data.start_time) : new Date(currentSessionData.start_time);
      const endTime = data.end_time ? new Date(data.end_time) : new Date(currentSessionData.end_time);
      
      const hasOverlap = await checkSessionOverlaps(currentSessionData.opportunity_id, startTime, endTime, sessionId, client);
      if (hasOverlap) {
        await client.query('ROLLBACK');
        throw new ConflictError('Updated session time overlaps with existing sessions');
      }
    }
      
      // Build dynamic update query
    const updateFields: string[] = [];
    const values: (string | number | Date | null)[] = [];
    let paramCount = 0;
    
    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        // THE SECOND HALF OF THE ALLOW-LIST. The check at :243 vets the request
        // BODY; this one vets what reaches the SET clause. Two gates on the
        // sibling fix in routes/opportunities.ts proved a boundary-only
        // allow-list is not enough: narrowing it to fire only when EVERY key is
        // unknown survived all 987 tests and let a mixed body through, and a
        // single line writing an injected key into `data` between the check and
        // this loop rebuilt the whole original vulnerability past a green suite.
        // The same two mutations survived here. A guard at the boundary cannot
        // protect a statement built further in.
        if (!UPDATABLE_SESSION_COLUMNS.has(key)) {
          logger.error('Refused a column outside the allow-list at the update builder', {
            sessionId,
            userId: req.user?.id,
            field: key.slice(0, 64)
          });
          throw new ValidationError('Validation failed', [
            `Only ${[...UPDATABLE_SESSION_COLUMNS].join(', ')} may be updated`
          ]);
        }
        paramCount++;
        updateFields.push(`${key} = $${paramCount}`);
        // Times are stored as the instant that was VALIDATED, matching the
        // create INSERTs: V8 and Postgres disagree on offset-less strings, so
        // pushing the raw value could store an instant pastRetimingError
        // never judged - reconstituting on UPDATE the exact state the create
        // rule closed.
        values.push(
          (key === 'start_time' || key === 'end_time') && typeof value === 'string'
            ? new Date(value).toISOString()
            : value
        );
      }
    });
    
      if (updateFields.length === 0) {
        await client.query('ROLLBACK');
        throw new ValidationError('No fields to update');
      }
      
      paramCount++;
      values.push(sessionId);
      
      const query = `
        UPDATE sessions 
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *, (capacity - booked_count) as remaining
      `;
      
      const result = await client.query(query, values);
      
      await client.query('COMMIT');
      
      const updatedSession = {
        ...result.rows[0],
        start_time: result.rows[0].start_time.toISOString(),
        end_time: result.rows[0].end_time.toISOString(),
        created_at: result.rows[0].created_at.toISOString(),
        updated_at: result.rows[0].updated_at.toISOString(),
      };
      
      res.json(updatedSession);
    } catch (error) {
      // Guarded for the reason spelled out at :278: a ROLLBACK that throws on
      // a dead connection would replace the error that caused it.
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
}));

// The delete waits for a racing booking to commit (plain FOR UPDATE, see below),
// but a bounded wait: without a lock_timeout the wait is unbounded, so a lock held
// by a stuck transaction would hang the delete until the pool statement_timeout
// (~15s) cancelled it as an opaque 503. This bounds it well under that so
// contention fails fast and distinctly as a retryable 409. cto/AdaptaLabs#116.
const SESSION_DELETE_LOCK_TIMEOUT_MS = 3000;

// DELETE /api/sessions/:id - Delete a session
router.delete('/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { id: sessionId } = req.params;
  
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    // Use mock data for development
    const sessions = getAllMockSessions(); // Get all sessions
    const session = sessions.find(s => s.id === sessionId);

    // Only a superadmin learns a session genuinely does not exist; everyone
    // else gets 403 for both "no such session" and "not yours", matching the
    // database path so this dev-only path is not an existence oracle either
    // (cto/AdaptaLabs#33 / !215).
    if (!session) {
      if (req.user!.role === 'superadmin') {
        throw new NotFoundError('Session');
      }
      throw new ForbiddenError('Only the owner can delete this session');
    }

    // Check ownership through opportunity (superadmins can delete any)
    const opportunity = getMockOpportunity(session.opportunity_id);
    const isSuperadmin = req.user!.role === 'superadmin';
    if (!opportunity || (!isSuperadmin && !isOpportunityOwner(opportunity, req.user))) {
      throw new ForbiddenError('Only the owner can delete this session');
    }
    
    // Delete mock session
    const deleted = deleteMockSession(sessionId);
    if (!deleted) {
      throw new NotFoundError('Session');
    }
    
    return res.status(204).send();
  }
  
  // Check session ownership (superadmins can delete any; a superadmin gets an
  // honest 404 for a session that does not exist - see enforceSessionOwnership)
  const access = await checkSessionOwnership(sessionId, req.user!.id, req.user!.role);
  enforceSessionOwnership(access, req.user!.role, 'Only the owner can delete this session');
  
  // Re-read the booking count and delete in ONE transaction holding FOR UPDATE
  // on the session row (cto/AdaptaLabs#34 family). This was a SELECT booked_count
  // and a DELETE on two separate pooled connections with no lock: a booking that
  // committed between them was deleted anyway - the exact harm the count check
  // exists to prevent, and one the new list Remove button makes a routine action.
  //
  // Every writer of booked_count takes the session row lock first, so once we
  // hold it the count is the committed truth: book and reschedule take
  // FOR UPDATE NOWAIT and fail fast against a row we are deleting, and cancel's
  // UPDATE blocks until we commit. A plain FOR UPDATE (not NOWAIT) is right here
  // - a delete racing a booking should WAIT for it to commit, then read the
  // non-zero count and refuse, rather than erroring.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Bound the FOR UPDATE wait below. SET LOCAL scopes it to this transaction,
    // so it cannot leak to the next checkout of this pooled connection. A wait
    // past this raises SQLSTATE 55P03 (lock_not_available), the same code the
    // NOWAIT booking paths raise, which the error middleware maps to a 409.
    await client.query(`SET LOCAL lock_timeout = ${SESSION_DELETE_LOCK_TIMEOUT_MS}`);

    const sessionCheck = await client.query(
      'SELECT booked_count FROM sessions WHERE id = $1 FOR UPDATE',
      [sessionId]
    );
    if (sessionCheck.rows.length === 0) {
      throw new NotFoundError('Session');
    }
    if (sessionCheck.rows[0].booked_count > 0) {
      throw new ValidationError('Cannot delete session with existing bookings');
    }

    // Last-bookable-slot guard (row 14). A published test/interview is BOOKED,
    // not handed off: strip its last upcoming slot and it advertises "Book a
    // time" over nothing anyone can book - the a21 defect. Re-ask the publish
    // predicate for the state this delete would LEAVE, counting the remaining
    // `end_time > NOW()` slots (the same bookable set the publish gate counts),
    // and refuse rather than silently unpublishing. Non-moderated types and
    // drafts pass `findPublishProblem` untouched, so only a published
    // test/interview losing its last future slot is refused.
    const oppInfo = await client.query(
      `SELECT o.id AS opportunity_id, o.status, o.type
         FROM sessions s JOIN opportunities o ON o.id = s.opportunity_id
        WHERE s.id = $1`,
      [sessionId]
    );
    const opp = oppInfo.rows[0];
    if (opp && opp.status === 'published' && MODERATED_CONSENT_TYPES.has(opp.type)) {
      const remainingBookable = await client.query(
        'SELECT 1 FROM sessions WHERE opportunity_id = $1 AND end_time > NOW() AND id <> $2 LIMIT 1',
        [opp.opportunity_id, sessionId]
      );
      const problem = findPublishProblem({
        willBePublished: true,
        type: opp.type,
        deliveryMode: 'native',
        hasLinkedStudy: false,
        hasInlineStudy: false,
        hasInlineSurvey: false,
        hasBookableSlot: (remainingBookable.rowCount ?? 0) > 0,
      });
      if (problem?.code === 'bookable_slot_required') {
        throw new ConflictError(
          'This is the last bookable slot of a published live session or interview. Add another upcoming slot, or unpublish the study, before removing it.'
        );
      }
    }

    await client.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    await client.query('COMMIT');
  } catch (error) {
    // Guarded as at :278/:564: a ROLLBACK that throws on a dead connection would
    // replace the error that caused it. NotFound/Validation are thrown here too,
    // so they roll back a transaction that has written nothing - harmless - and
    // reach the error middleware unchanged.
    await client.query('ROLLBACK').catch(() => {});
    // A lock_timeout on the FOR UPDATE above is a transient contention signal, not
    // a server fault: surface it as a retryable 409 with a delete-specific message,
    // matching the booking paths' own 55P03 handling, rather than the generic
    // "Resource is currently locked" the DB-error mapper would otherwise produce.
    if ((error as { code?: string }).code === '55P03') {
      // 55P03 here is whatever writer held the session row lock past the timeout
      // - a racing booking, cancel or reschedule - so the message names none in
      // particular.
      throw new ConflictError('The session is busy while another change is in progress. Please try again.');
    }
    throw error;
  } finally {
    client.release();
  }

  res.status(204).send();
}));

// POST /api/sessions/sync-booked-counts - repair booked_count drift across
// EVERY session in the database. cto/AdaptaLabs#26.
//
// SUPERADMIN ONLY. The value written is derived from the actual bookings, not
// supplied by the caller, so this is not an arbitrary-value write - but it
// rewrites every researcher's sessions, not just the caller's, so it is an
// operator repair tool rather than a per-researcher action. Under the old
// requireAdmin any researcher_admin could trigger writes to every other
// researcher's sessions; every other write in this family is owner-gated.
router.post('/sync-booked-counts', requireSuperadmin, asyncHandler(async (req: Request, res: Response) => {
  logger.info('Starting booked_count sync');

  // One transaction that LOCKS every session row before rewriting it, so the
  // recount cannot clobber a booking committed while it runs. Because every
  // writer that changes booked_count takes the session row lock first, the
  // count taken while the sweep holds the locks cannot be stale:
  //   - book and reschedule take FOR UPDATE NOWAIT on the session row, so while
  //     the sweep holds the locks a concurrent booking fails fast (a retryable
  //     409) rather than committing against a row about to be recounted;
  //   - cancel's UPDATE on the session row blocks until the sweep commits, then
  //     applies its -1 relative to the freshly synced value.
  // The old code counted and updated on separate pooled connections with no
  // lock, so a booking committed between the two overwrote the increment - it
  // could CAUSE the drift it exists to fix. The set-based UPDATE also replaces
  // the per-session N+1 (a SELECT COUNT plus an UPDATE for every row).
  //
  // ponytail: holds a lock on every session row for the length of the sweep, so
  // new bookings are briefly rejected (retryable) table-wide while it runs - it
  // is superadmin-only and rare. It can also deadlock (40P01) against reschedule
  // and delete-sessions, which lock several session rows in a different order;
  // tracked in cto/AdaptaLabs#34. Per-opportunity batching is the upgrade path
  // if either matters.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const locked = await client.query('SELECT id FROM sessions ORDER BY id FOR UPDATE');

    await client.query(`
      UPDATE sessions s
      SET booked_count = (
        SELECT COUNT(*) FROM bookings b
        WHERE b.session_id = s.id AND b.status = 'booked'
      )
    `);

    await client.query('COMMIT');

    const syncedCount = locked.rows.length;
    logger.info(`Sync complete: ${syncedCount} sessions updated`);
    res.json({
      message: `Successfully synced booked_count for ${syncedCount} sessions`,
      synced_count: syncedCount
    });
  } catch (error) {
    // Guarded for the reason spelled out at :278: a ROLLBACK that throws on a
    // dead connection would replace the error that caused it.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

export default router;
