
import { createHmac, timingSafeEqual } from "node:crypto";

// Signed media URLs stay valid across the whole playback of a recording (which can
// run ~15 minutes), not just for a one-shot API call.
const ASSET_MEDIA_TTL_SECONDS = 15 * 60;

export function getIntegrationSharedSecret() {
  return process.env.FIRSTHAND_INTEGRATION_SECRET?.trim() || null;
}

// Signature for a signed asset media URL. This binds the assetId and the absolute
// expiry into the signature so the URL cannot be retargeted to another asset.
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
