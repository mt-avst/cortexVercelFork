import { pool } from '../config';
import { isDatabaseAvailable } from '../utils/database';
import { logger } from '../utils/logger';
import type { SessionPayload } from '../../../shared/firsthand/contract';
import type { RuntimeMutation, RuntimeSessionRecord } from './runtime-records';

// In-process lifecycle-event write for internalised (FIRSTHAND_INTERNAL) sessions.
//
// FirstHand posted lifecycle events back to Cortex over an HMAC callback
// (src/lib/integration-callbacks.ts -> deliverSignedCallback). The merge deletes
// that hop: when the runtime is internalised there is no second app to call
// back, so the participant runtime route (B4) writes the same
// opportunity_session_events row in-process. This is the write the B3b/B3c notes
// deferred to B4 ("internal sessions have no completion notification until then").
//
// The row shape and the ON CONFLICT (firsthand_session_id, event_type) DO NOTHING
// idempotency mirror routes/firsthand.ts's HMAC `/callbacks` handler exactly, so
// the reviewer analytics surface reads identically whichever path produced it.

// Known analytics event types, matching the HMAC /callbacks route's allowlist.
export type OpportunitySessionEventType =
  | 'session_started'
  | 'session_completed'
  | 'session_abandoned'
  | 'session_failed';

// Maps a runtime mutation to the lifecycle event it represents, or null when the
// mutation is not lifecycle-significant. Ported from FirstHand's
// resolveLifecycleEvent: only "event" mutations matter, and session_completed is
// only emitted once the session is fully complete (no pending upload).
export function resolveLifecycleEvent(
  mutation: RuntimeMutation,
  session: RuntimeSessionRecord
): OpportunitySessionEventType | null {
  if (mutation.type !== 'event') return null;

  switch (mutation.eventType) {
    case 'session_started':
      return 'session_started';
    case 'upload_completed':
      return 'session_completed';
    case 'session_completed':
      return session.sessionStatus === 'completed' ? 'session_completed' : null;
    case 'session_abandoned':
    case 'consent_declined':
      return 'session_abandoned';
    case 'recording_failed':
    case 'session_failed':
    case 'upload_failed':
      return 'session_failed';
    default:
      return null;
  }
}

// Writes the lifecycle event for an internal session, best-effort. Never throws:
// a participant's runtime POST must not fail because analytics could not be
// recorded, exactly as the HMAC callback path was fire-and-forget.
export async function recordInternalSessionEvent(
  payload: SessionPayload,
  mutation: RuntimeMutation,
  session: RuntimeSessionRecord
): Promise<void> {
  // external_ref carries the Cortex opportunity id (set by the handoff route);
  // without it there is nothing to link the event to.
  const opportunityId = payload.participant.external_ref;
  if (!opportunityId) return;

  // Defensive: a session that still carries a callback_url is an HMAC session
  // whose events are delivered by the standalone app — do not double-write.
  if (payload.session.callback_url) return;

  const event = resolveLifecycleEvent(mutation, session);
  if (!event) return;

  const participantUserId = payload.participant.participant_id;
  const logicalSessionId = session.logicalSessionId ?? session.sessionId;
  const occurredAt = new Date().toISOString();

  try {
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;

    await pool.query(
      `INSERT INTO opportunity_session_events
         (opportunity_id, participant_user_id, firsthand_session_id, event_type, occurred_at, payload)
       VALUES ($1, $2::uuid, $3, $4, $5, $6)
       ON CONFLICT (firsthand_session_id, event_type) DO NOTHING`,
      [
        opportunityId,
        participantUserId || null,
        logicalSessionId,
        event,
        occurredAt,
        JSON.stringify({
          event,
          session_id: logicalSessionId,
          participant_id: participantUserId,
          external_ref: opportunityId,
          occurred_at: occurredAt,
          session_status: session.sessionStatus
        })
      ]
    );
  } catch (err) {
    // Best-effort: log and move on. The token is not in this context, so nothing
    // sensitive is logged.
    logger.warn('[firsthand] in-process session event write failed', {
      firsthand_session_id: logicalSessionId,
      event_type: event,
      errorMessage: err instanceof Error ? err.message : String(err)
    });
  }
}
