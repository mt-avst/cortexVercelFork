import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { verifyCallbackSignature } from '../utils/firsthand';

// Disable Vercel's body parser so we receive the raw bytes for HMAC verification.
export const config = { api: { bodyParser: false } };

const KNOWN_EVENT_TYPES = [
  'session_started',
  'session_completed',
  'session_abandoned',
  'session_failed',
];

function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => { data += chunk.toString('utf8'); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * POST /api/firsthand/callbacks
 * Receive lifecycle webhook events from FirstHand.
 * Auth: HMAC signature (no session cookie).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await readRawBody(req);

  if (!verifyCallbackSignature(rawBody, req.headers)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }

  const { event, session_id, participant_id, external_ref, occurred_at } = body as {
    event?: string;
    session_id?: string;
    participant_id?: string;
    external_ref?: string;
    occurred_at?: string;
  };

  if (!event || !session_id || !occurred_at) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  if (!KNOWN_EVENT_TYPES.includes(event)) {
    return res.status(400).json({ error: 'unknown_event_type', event });
  }

  if (external_ref) {
    try {
      await query(
        `INSERT INTO opportunity_session_events
           (opportunity_id, participant_user_id, firsthand_session_id, event_type, occurred_at, payload)
         VALUES ($1, $2::uuid, $3, $4, $5, $6)
         ON CONFLICT (firsthand_session_id, event_type) DO NOTHING`,
        [
          external_ref,
          participant_id || null,
          session_id,
          event,
          occurred_at,
          rawBody,
        ]
      );
    } catch (err) {
      console.warn('[firsthand] callback DB insert failed for session', session_id, err);
    }
  }

  return res.status(200).json({ received: true });
}
