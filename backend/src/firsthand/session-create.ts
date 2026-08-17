import { randomBytes, randomUUID } from 'crypto';

import {
  sessionPayloadSchema,
  type SessionPayload
} from '../../../shared/firsthand/contract';
import { getStudyById, isStudiesPersistenceConfigured } from './studies-repository';
import { seedRuntimeSession } from './runtime-repository';
import { logger } from '../utils/logger';

// In-process session creation (Phase B, step B3b). This is the internalised
// equivalent of FirstHand's `POST /api/sessions` route body: it mints the
// server-side session identifiers, assembles and validates the versioned
// SessionPayload, and seeds the runtime store. It deliberately owns NONE of the
// transport concerns the FirstHand route carried (HMAC verification, request
// parsing, or public-URL rebasing) — the caller (the Cortex handoff route)
// already authenticated the Cortex user and builds the same-origin session URL.
//
// Token binding (decision 7 / H3): the caller passes `participant.participant_id
// = req.user.id`, and the assembled payload's `session.participant_id` is bound
// to it by the contract's superRefine. The participant runtime routes (B4)
// enforce that the consuming Cortex user matches `participant_id`, so a leaked
// token used by a different logged-in user is rejected. The token itself is a
// 192-bit CSPRNG value and is never derived from client input.

export const DEFAULT_SESSION_EXPIRES_IN_MINUTES = 60 * 24;
export const MAX_SESSION_EXPIRES_IN_MINUTES = 60 * 24 * 14;

export type CreateSessionParticipant = {
  participant_id: string;
  display_name?: string;
  email?: string;
  external_ref?: string;
  segment?: string;
};

export type CreateSessionInput = {
  studyId: string;
  participant: CreateSessionParticipant;
  /**
   * The opportunity the participant started from. Supplied by the route from
   * its own path parameter, never from a request body: this is what the
   * per-opportunity results gate authorises against.
   */
  opportunityId?: string;
  callbackUrl?: string;
  returnUrl?: string;
  expiresInMinutes?: number;
};

export type CreatedSession = {
  session_id: string;
  session_token: string;
  expires_at: string;
};

export type CreateSessionError =
  | 'persistence_not_configured'
  | 'study_not_found'
  | 'study_has_no_steps'
  | 'payload_assembly_failed';

export type CreateSessionResult =
  | { ok: true; session: CreatedSession }
  | { ok: false; error: CreateSessionError };

export async function createSession(
  input: CreateSessionInput
): Promise<CreateSessionResult> {
  if (!isStudiesPersistenceConfigured()) {
    return { ok: false, error: 'persistence_not_configured' };
  }

  const study = await getStudyById(input.studyId);

  if (!study) {
    return { ok: false, error: 'study_not_found' };
  }

  if (study.steps.length === 0) {
    return { ok: false, error: 'study_has_no_steps' };
  }

  const sessionId = `session_${randomUUID()}`;
  const sessionToken = `fh_${randomBytes(24).toString('base64url')}`;
  const expiresInMinutes = clampExpiryMinutes(input.expiresInMinutes);
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();

  const payload: SessionPayload = {
    contract_version: '1.0',
    study: {
      id: study.study.id,
      title: study.study.title,
      intro_text: study.study.intro_text,
      consent_text: study.study.consent_text,
      // Snapshotting this is safe in a way snapshotting the study's steps or
      // status would not be: `kind` is fixed at create and is absent from
      // UpdateStudyInput, precisely because changing it would orphan steps
      // written for the other runner. So the value cannot drift away from the
      // study underneath a live session.
      kind: study.study.kind,
      brand_name: study.study.brand_name,
      estimated_duration_minutes: study.study.estimated_duration_minutes,
      locale: study.study.locale,
      status: study.study.status
    },
    participant: {
      participant_id: input.participant.participant_id,
      display_name: input.participant.display_name,
      segment: input.participant.segment,
      external_ref: input.participant.external_ref,
      email: input.participant.email
    },
    session: {
      session_id: sessionId,
      session_token: sessionToken,
      study_id: study.study.id,
      participant_id: input.participant.participant_id,
      expires_at: expiresAt,
      single_use: true,
      // Omitted rather than set to undefined when absent, so a session with no
      // opportunity stores no key rather than a null one.
      ...(input.opportunityId ? { opportunity_id: input.opportunityId } : {}),
      callback_url: input.callbackUrl,
      return_url: input.returnUrl
    },
    steps: study.steps
  };

  const validated = sessionPayloadSchema.safeParse(payload);

  if (!validated.success) {
    // The caller only gets an opaque code, so without this an operator sees a
    // 500 with nothing naming the field. Matters more now the target_url guard
    // is stricter: a study stored under the looser rule fails here rather than
    // at the sink. PATHS ONLY, never values - a target_url or callback_url can
    // carry tokens.
    logger.error('Session payload failed contract validation', {
      studyId: study.study.id,
      issues: validated.error.issues.map((issue) => issue.path.join('.'))
    });
    return { ok: false, error: 'payload_assembly_failed' };
  }

  await seedRuntimeSession(validated.data);

  return {
    ok: true,
    session: {
      session_id: sessionId,
      session_token: sessionToken,
      expires_at: expiresAt
    }
  };
}

function clampExpiryMinutes(requested?: number): number {
  if (requested === undefined || Number.isNaN(requested) || requested <= 0) {
    return DEFAULT_SESSION_EXPIRES_IN_MINUTES;
  }

  // A positive but over-long (or Infinity) request clamps to the maximum.
  return Math.min(requested, MAX_SESSION_EXPIRES_IN_MINUTES);
}
