import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF egress allowlist for outbound lifecycle callbacks.
 *
 * `deliverSignedCallback` POSTs to a `callback_url` that ultimately originates
 * from a session payload. Before the internalised runtime became the sole
 * writer this URL was attacker-influenceable, and even now it must never be
 * pointed at the cluster's private network, cloud metadata endpoints, or the
 * loopback interface: a signed POST to `http://169.254.169.254/...` or an
 * internal service would be a server-side request forgery.
 *
 * This guard is the egress counterpart to the contract-level `isSafeTargetUrl`
 * refine (which rejects non-http(s) schemes at ingestion): here we additionally
 * require https, and deny loopback, RFC1918, carrier-grade NAT, link-local and
 * IPv6 unique-local / unspecified ranges — checking both IP-literal hosts and
 * every address a DNS host resolves to.
 *
 * Residual risk: a DNS host could rebind between this check and the socket
 * connect (TOCTOU). Fully closing that needs connection pinning to the checked
 * address; it is out of scope for this defence-in-depth guard on a path whose
 * only live producer (the HMAC hop) is being deleted, and is noted for the
 * follow-up that pins egress at the socket layer.
 */

export type EgressDecision = { allowed: true } | { allowed: false; reason: string };

export type ResolvedAddress = { address: string };
export type LookupImpl = (
  hostname: string,
  options: { all: true }
) => Promise<ResolvedAddress[]>;

function buildBlockList(): net.BlockList {
  const blocked = new net.BlockList();

  // IPv4 ranges that must never be a callback egress target.
  blocked.addSubnet("0.0.0.0", 8, "ipv4"); // "this host" / unspecified
  blocked.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918 private
  blocked.addSubnet("100.64.0.0", 10, "ipv4"); // RFC6598 carrier-grade NAT
  blocked.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local (incl. cloud metadata)
  blocked.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918 private
  blocked.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918 private

  // IPv6 equivalents.
  blocked.addAddress("::", "ipv6"); // unspecified
  blocked.addAddress("::1", "ipv6"); // loopback
  blocked.addSubnet("fc00::", 7, "ipv6"); // unique-local (ULA)
  blocked.addSubnet("fe80::", 10, "ipv6"); // link-local

  return blocked;
}

const blockList = buildBlockList();

// Extracts the IPv4 form of an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) so a
// mapped loopback/private address cannot slip past the IPv4 subnet rules.
function ipv4MappedTo4(address: string): string | null {
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  return match && net.isIP(match[1]) === 4 ? match[1] : null;
}

/**
 * Whether a resolved IP address is in a blocked range. Fails closed: anything
 * that is not a parseable IP is treated as blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;

  if (family === 6) {
    const mapped = ipv4MappedTo4(address);
    if (mapped) return blockList.check(mapped, "ipv4");
    return blockList.check(address, "ipv6");
  }

  return blockList.check(address, "ipv4");
}

/**
 * Decide whether an outbound callback to `rawUrl` is permitted. https-only;
 * denies loopback, private, link-local and unique-local destinations for both
 * IP-literal and DNS hosts.
 */
export async function checkCallbackEgress(
  rawUrl: string,
  lookupImpl: LookupImpl = dnsLookup as unknown as LookupImpl
): Promise<EgressDecision> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "callback URL is not a valid absolute URL" };
  }

  if (url.protocol !== "https:") {
    return {
      allowed: false,
      reason: `callback URL scheme "${url.protocol}" is not https`
    };
  }

  // URL keeps IPv6 literals bracketed; strip them for net.isIP / BlockList.
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");

  if (net.isIP(hostname) !== 0) {
    return isBlockedAddress(hostname)
      ? { allowed: false, reason: `callback host ${hostname} is in a blocked range` }
      : { allowed: true };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await lookupImpl(hostname, { all: true });
  } catch {
    return { allowed: false, reason: `callback host ${hostname} did not resolve` };
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: `callback host ${hostname} resolved to no addresses` };
  }

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      return {
        allowed: false,
        reason: `callback host ${hostname} resolves to blocked address ${address}`
      };
    }
  }

  return { allowed: true };
}
