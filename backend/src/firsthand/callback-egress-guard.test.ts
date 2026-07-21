import { describe, expect, it, vi } from "vitest";

import {
  checkCallbackEgress,
  isBlockedAddress,
  type LookupImpl
} from "./callback-egress-guard";

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local and unique-local addresses", () => {
    for (const addr of [
      "127.0.0.1",
      "127.5.6.7",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // carrier-grade NAT
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:10.0.0.1" // IPv4-mapped private
    ]) {
      expect(isBlockedAddress(addr), addr).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const addr of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1::1"]) {
      expect(isBlockedAddress(addr), addr).toBe(false);
    }
  });

  it("fails closed on a non-IP string", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

describe("checkCallbackEgress", () => {
  const publicLookup: LookupImpl = async () => [{ address: "93.184.216.34" }];

  it("rejects a non-absolute URL", async () => {
    const decision = await checkCallbackEgress("/relative/path", publicLookup);
    expect(decision.allowed).toBe(false);
  });

  it("rejects a non-https scheme", async () => {
    const decision = await checkCallbackEgress(
      "http://cortex.example.com/api/firsthand/callbacks",
      publicLookup
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("https");
  });

  it("rejects an https loopback IP literal", async () => {
    const decision = await checkCallbackEgress("https://127.0.0.1/x", publicLookup);
    expect(decision.allowed).toBe(false);
  });

  it("rejects an https link-local metadata IP literal", async () => {
    const decision = await checkCallbackEgress(
      "https://169.254.169.254/latest/meta-data/",
      publicLookup
    );
    expect(decision.allowed).toBe(false);
  });

  it("rejects a bracketed IPv6 loopback literal", async () => {
    const decision = await checkCallbackEgress("https://[::1]/x", publicLookup);
    expect(decision.allowed).toBe(false);
  });

  it("allows an https public IP literal without a DNS lookup", async () => {
    const lookup = vi.fn(publicLookup);
    const decision = await checkCallbackEgress("https://93.184.216.34/cb", lookup);
    expect(decision.allowed).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("allows an https host that resolves only to public addresses", async () => {
    const decision = await checkCallbackEgress(
      "https://cortex.example.com/api/firsthand/callbacks",
      publicLookup
    );
    expect(decision.allowed).toBe(true);
  });

  it("blocks an https host that resolves to a private address (DNS rebinding)", async () => {
    const rebinding: LookupImpl = async () => [
      { address: "93.184.216.34" },
      { address: "10.0.0.5" }
    ];
    const decision = await checkCallbackEgress(
      "https://sneaky.example.com/cb",
      rebinding
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("10.0.0.5");
  });

  it("blocks a host that does not resolve", async () => {
    const failing: LookupImpl = async () => {
      throw new Error("ENOTFOUND");
    };
    const decision = await checkCallbackEgress("https://nope.example.com/cb", failing);
    expect(decision.allowed).toBe(false);
  });

  it("blocks a host that resolves to no addresses", async () => {
    const empty: LookupImpl = async () => [];
    const decision = await checkCallbackEgress("https://empty.example.com/cb", empty);
    expect(decision.allowed).toBe(false);
  });
});
