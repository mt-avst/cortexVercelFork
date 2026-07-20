
import {
  FIRSTHAND_INTEGRATION_SIGNATURE_HEADER,
  FIRSTHAND_INTEGRATION_TIMESTAMP_HEADER,
  signIntegrationPayload
} from "./integration-auth";

export type LifecycleCallbackEvent =
  | "session_started"
  | "session_completed"
  | "session_abandoned"
  | "session_failed";

export const CALLBACK_DELIVERY_MAX_ATTEMPTS = 8;

const CALLBACK_DELIVERY_TIMEOUT_MS = 10_000;
const BASE_RETRY_DELAY_MS = 60_000;
const RETRY_BACKOFF_FACTOR = 4;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;

export type CallbackDeliveryResult =
  | { ok: true }
  | { ok: false; error: string };

export type EnqueueCallbackDeliveryInput = {
  attempts?: number;
  body: string;
  callbackUrl: string;
  event: LifecycleCallbackEvent | string;
  lastError?: string | null;
  logicalSessionId: string;
  nextAttemptAt?: string;
};

export type CallbackDeliverySummary = {
  abandoned: number;
  delivered: number;
  processed: number;
  rescheduled: number;
};

export function createEmptyCallbackDeliverySummary(): CallbackDeliverySummary {
  return { abandoned: 0, delivered: 0, processed: 0, rescheduled: 0 };
}

/**
 * When the next delivery attempt should run, given how many attempts have
 * already been made: 1m, 4m, 16m, ~1h, ~4h... capped at 24 hours.
 */
export function computeNextAttemptAtMs(attempts: number, nowMs: number) {
  const priorAttempts = Math.max(1, attempts);
  const delayMs = Math.min(
    BASE_RETRY_DELAY_MS * RETRY_BACKOFF_FACTOR ** (priorAttempts - 1),
    MAX_RETRY_DELAY_MS
  );

  return nowMs + delayMs;
}

/**
 * Sign and POST a callback body. The HMAC timestamp is generated at send time
 * so retried deliveries always carry a fresh signature (Cortex rejects
 * signatures older than five minutes).
 */
export async function deliverSignedCallback(input: {
  body: string;
  callbackUrl: string;
  fetchImpl?: typeof fetch;
  secret: string;
}): Promise<CallbackDeliveryResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timestamp = String(Date.now());
  const signature = signIntegrationPayload({
    body: input.body,
    secret: input.secret,
    timestamp
  });

  let response: Response;

  try {
    response = await fetchImpl(input.callbackUrl, {
      body: input.body,
      headers: {
        "content-type": "application/json",
        [FIRSTHAND_INTEGRATION_SIGNATURE_HEADER]: signature,
        [FIRSTHAND_INTEGRATION_TIMESTAMP_HEADER]: timestamp
      },
      method: "POST",
      signal: AbortSignal.timeout(CALLBACK_DELIVERY_TIMEOUT_MS)
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false
    };
  }

  if (!response.ok) {
    return {
      error: `callback POST returned ${response.status}`,
      ok: false
    };
  }

  return { ok: true };
}
