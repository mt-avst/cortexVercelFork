import { Request, Response, NextFunction } from 'express';
import type { SessionPayload } from '../../../shared/firsthand/contract';
import { loadParticipantSession } from '../firsthand/session-store';
import { asyncHandler } from '../utils/errorHandler';

// Express Request carries the resolved+bound participant session for the
// downstream runtime route handlers.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      firsthandSession?: SessionPayload;
    }
  }
}

/**
 * The single shared token->user binding for every participant runtime route
 * (H3 / locked decision 7). Runs AFTER `requireAuth`, so `req.user` is present.
 *
 * It loads the session addressed by the opaque `:token`, then enforces the
 * binding predicate: the logged-in Cortex user must be the participant the
 * session was minted for. A leaked bearer token replayed by a different
 * authenticated user is rejected with 403 - this is the whole reason B4 is the
 * hard gate on the internalised runtime. Anonymous access is gone:
 * FirstHand's participant OIDC / cookie path is dropped, not ported.
 *
 * Applying this once, in front of all five routes, guarantees no route can be
 * added later that serves a session without the binding check.
 */
export const bindParticipantSession = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;

    // requireAuth mounts ahead of this, but never trust ordering for an authz
    // gate - re-assert the authenticated identity here.
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Token-in-URL hygiene: the bearer token is a path segment, so suppress the
    // Referer on anything the participant surface loads next. Log redaction is
    // handled centrally in the request logger.
    res.setHeader('Referrer-Policy', 'no-referrer');

    const result = await loadParticipantSession(req.params.token);

    if (result.kind !== 'ok') {
      const status =
        result.kind === 'expired'
          ? 410
          : result.kind === 'invalid_contract'
            ? 422
            : 404;
      return res.status(status).json({ error: result.kind, message: result.message });
    }

    // The binding predicate. The contract guarantees
    // session.participant_id === participant.participant_id, and the session id
    // is the session-scoped identity the token represents.
    if (result.payload.session.participant_id !== user.id) {
      return res.status(403).json({ error: 'forbidden_participant_mismatch' });
    }

    req.firsthandSession = result.payload;
    return next();
  }
);
