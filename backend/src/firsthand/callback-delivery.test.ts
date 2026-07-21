import { describe, expect, it, vi } from "vitest";

import {
  CALLBACK_DELIVERY_MAX_ATTEMPTS,
  computeNextAttemptAtMs,
  deliverSignedCallback
} from "./callback-delivery";
import { verifyIntegrationRequest } from "./integration-auth";

const SECRET = "a".repeat(48);
// A public IP literal so the egress guard needs no DNS lookup in these tests.
const CALLBACK_URL = "https://93.184.216.34/api/firsthand/callbacks";
const BODY = JSON.stringify({ event: "session_completed", session_id: "s-1" });

describe("computeNextAttemptAtMs", () => {
  const nowMs = Date.UTC(2026, 6, 5, 12, 0, 0);

  it("backs off exponentially from one minute", () => {
    expect(computeNextAttemptAtMs(1, nowMs)).toBe(nowMs + 60_000);
    expect(computeNextAttemptAtMs(2, nowMs)).toBe(nowMs + 4 * 60_000);
    expect(computeNextAttemptAtMs(3, nowMs)).toBe(nowMs + 16 * 60_000);
  });

  it("caps the delay at 24 hours", () => {
    expect(computeNextAttemptAtMs(10, nowMs)).toBe(nowMs + 24 * 60 * 60_000);
  });

  it("treats zero or negative attempts as the first retry", () => {
    expect(computeNextAttemptAtMs(0, nowMs)).toBe(nowMs + 60_000);
    expect(computeNextAttemptAtMs(-3, nowMs)).toBe(nowMs + 60_000);
  });
});

describe("deliverSignedCallback", () => {
  it("POSTs the body with a verifiable HMAC signature", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200 })
    );

    const result = await deliverSignedCallback({
      body: BODY,
      callbackUrl: CALLBACK_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: SECRET
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [capturedUrl, capturedInit] = fetchImpl.mock.calls[0];
    expect(String(capturedUrl)).toBe(CALLBACK_URL);

    // Never follow redirects: a 3xx to a private host would bypass the egress
    // guard, which only validated the original URL.
    expect(capturedInit?.redirect).toBe("error");

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("content-type")).toBe("application/json");

    const verification = verifyIntegrationRequest({
      body: BODY,
      headers,
      secret: SECRET
    });
    expect(verification.kind).toBe("authorized");
  });

  it("reports failure on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));

    const result = await deliverSignedCallback({
      body: BODY,
      callbackUrl: CALLBACK_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: SECRET
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("503");
  });

  it("reports failure when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });

    const result = await deliverSignedCallback({
      body: BODY,
      callbackUrl: CALLBACK_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: SECRET
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("socket hang up");
  });

  it("blocks a non-https callback target without issuing a request", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    const result = await deliverSignedCallback({
      body: BODY,
      callbackUrl: "http://cortex.example.com/api/firsthand/callbacks",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: SECRET
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("egress blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks a loopback callback target without issuing a request", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    const result = await deliverSignedCallback({
      body: BODY,
      callbackUrl: "https://127.0.0.1:9000/api/firsthand/callbacks",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: SECRET
    });

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("CALLBACK_DELIVERY_MAX_ATTEMPTS", () => {
  it("allows a bounded number of attempts", () => {
    expect(CALLBACK_DELIVERY_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(CALLBACK_DELIVERY_MAX_ATTEMPTS).toBeLessThanOrEqual(12);
  });
});
