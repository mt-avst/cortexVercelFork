
import { createHmac, timingSafeEqual } from "node:crypto";

export const FIRSTHAND_INTEGRATION_SIGNATURE_HEADER = "x-firsthand-signature";
export const FIRSTHAND_INTEGRATION_TIMESTAMP_HEADER = "x-firsthand-timestamp";

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

// Signed media URLs live longer than the request-auth tolerance above: the browser
// needs the URL to stay valid across the whole playback of a recording (which can run
// ~15 minutes), not just for a one-shot API call.
const ASSET_MEDIA_TTL_SECONDS = 15 * 60;

export type IntegrationAuthResult =
  | { kind: "authorized" }
  | { kind: "not_configured"; message: string }
  | {
      kind: "rejected";
      reason:
        | "missing_signature"
        | "missing_timestamp"
        | "stale_timestamp"
        | "future_timestamp"
        | "invalid_signature";
    };

export function getIntegrationSharedSecret() {
  return process.env.FIRSTHAND_INTEGRATION_SECRET?.trim() || null;
}

export function isIntegrationAuthConfigured() {
  return Boolean(getIntegrationSharedSecret());
}

export function signIntegrationPayload(input: {
  body: string;
  secret: string;
  timestamp: string;
}) {
  return createHmac("sha256", input.secret)
    .update(`${input.timestamp}\n${input.body}`)
    .digest("hex");
}

export function verifyIntegrationRequest(input: {
  body: string;
  headers: Headers;
  now?: Date;
  secret?: string | null;
}): IntegrationAuthResult {
  const secret = input.secret ?? getIntegrationSharedSecret();

  if (!secret) {
    return {
      kind: "not_configured",
      message:
        "Set FIRSTHAND_INTEGRATION_SECRET to accept signed integration requests."
    };
  }

  const signature = input.headers
    .get(FIRSTHAND_INTEGRATION_SIGNATURE_HEADER)
    ?.trim();
  const timestamp = input.headers
    .get(FIRSTHAND_INTEGRATION_TIMESTAMP_HEADER)
    ?.trim();

  if (!signature) {
    return { kind: "rejected", reason: "missing_signature" };
  }

  if (!timestamp) {
    return { kind: "rejected", reason: "missing_timestamp" };
  }

  const timestampMs = Number.parseInt(timestamp, 10);

  if (!Number.isFinite(timestampMs)) {
    return { kind: "rejected", reason: "missing_timestamp" };
  }

  const nowMs = (input.now ?? new Date()).getTime();
  const deltaSeconds = (nowMs - timestampMs) / 1000;

  if (deltaSeconds > SIGNATURE_TOLERANCE_SECONDS) {
    return { kind: "rejected", reason: "stale_timestamp" };
  }

  if (deltaSeconds < -SIGNATURE_TOLERANCE_SECONDS) {
    return { kind: "rejected", reason: "future_timestamp" };
  }

  const expectedSignature = signIntegrationPayload({
    body: input.body,
    secret,
    timestamp
  });
  const providedBytes = Buffer.from(signature, "hex");
  const expectedBytes = Buffer.from(expectedSignature, "hex");

  if (
    providedBytes.length === 0 ||
    providedBytes.length !== expectedBytes.length
  ) {
    return { kind: "rejected", reason: "invalid_signature" };
  }

  if (!timingSafeEqual(providedBytes, expectedBytes)) {
    return { kind: "rejected", reason: "invalid_signature" };
  }

  return { kind: "authorized" };
}

export function getSignatureToleranceSeconds() {
  return SIGNATURE_TOLERANCE_SECONDS;
}

export function getAssetMediaTtlSeconds() {
  return ASSET_MEDIA_TTL_SECONDS;
}

// Signature for a signed asset media URL. Unlike the request-auth scheme (which signs
// `${timestamp}\n${body}` and leaves the path/query unsigned), this binds the assetId and
// the absolute expiry into the signature so the URL cannot be retargeted to another asset.
export function signAssetMedia(input: {
  assetId: string;
  exp: number;
  secret: string;
}) {
  return createHmac("sha256", input.secret)
    .update(`${input.assetId}\n${input.exp}`)
    .digest("hex");
}

export type AssetMediaSignatureResult =
  | { kind: "authorized" }
  | { kind: "not_configured"; message: string }
  | {
      kind: "rejected";
      reason:
        | "missing_signature"
        | "missing_exp"
        | "expired"
        | "invalid_signature";
    };

export function verifyAssetMediaSignature(input: {
  assetId: string;
  exp: string | null;
  sig: string | null;
  now?: Date;
  secret?: string | null;
}): AssetMediaSignatureResult {
  const secret = input.secret ?? getIntegrationSharedSecret();

  if (!secret) {
    return {
      kind: "not_configured",
      message:
        "Set FIRSTHAND_INTEGRATION_SECRET to accept signed media requests."
    };
  }

  const sig = input.sig?.trim();
  const exp = input.exp?.trim();

  if (!sig) {
    return { kind: "rejected", reason: "missing_signature" };
  }

  if (!exp) {
    return { kind: "rejected", reason: "missing_exp" };
  }

  const expMs = Number.parseInt(exp, 10);

  if (!Number.isFinite(expMs)) {
    return { kind: "rejected", reason: "missing_exp" };
  }

  const nowMs = (input.now ?? new Date()).getTime();

  if (nowMs > expMs) {
    return { kind: "rejected", reason: "expired" };
  }

  const expectedSignature = signAssetMedia({
    assetId: input.assetId,
    exp: expMs,
    secret
  });
  const providedBytes = Buffer.from(sig, "hex");
  const expectedBytes = Buffer.from(expectedSignature, "hex");

  if (
    providedBytes.length === 0 ||
    providedBytes.length !== expectedBytes.length
  ) {
    return { kind: "rejected", reason: "invalid_signature" };
  }

  if (!timingSafeEqual(providedBytes, expectedBytes)) {
    return { kind: "rejected", reason: "invalid_signature" };
  }

  return { kind: "authorized" };
}

// Builds an absolute, short-lived signed media URL for an asset, relative to the given
// base URL (typically the incoming request's own origin).
export function buildSignedAssetMediaUrl(input: {
  baseUrl: string;
  sessionId: string;
  assetId: string;
  secret: string;
  now?: Date;
}): string {
  const exp = (input.now ?? new Date()).getTime() + ASSET_MEDIA_TTL_SECONDS * 1000;
  const sig = signAssetMedia({
    assetId: input.assetId,
    exp,
    secret: input.secret
  });
  const url = new URL(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/assets/${encodeURIComponent(input.assetId)}/media`,
    input.baseUrl
  );
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
}
