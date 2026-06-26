import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF defense for outbound connection traffic (Sec#2). A connection's
 * `serverUrl` is user-supplied and later fetched server-side with the tenant's
 * bearer token attached — so an attacker could point it at cloud metadata
 * (169.254.169.254), the DB/Temporal host, or their own server to exfiltrate the
 * token. We enforce https + resolve the host and reject any private/loopback/
 * link-local/reserved address. Checking at CALL time (not just creation) also
 * defeats DNS rebinding.
 */
export class BlockedEgressError extends Error {
  constructor(reason: string) {
    super(`Blocked outbound request: ${reason}`);
    this.name = "BlockedEgressError";
  }
}

/** True if an IPv4/IPv6 literal is private, loopback, link-local, or reserved. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true; // not a parseable IP → treat as unsafe
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = p;
  return (
    a === 0 || // 0.0.0.0/8 "this host"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (incl. cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    a >= 224 // 224+ multicast/reserved
  );
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — classify by the embedded v4.
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  return (
    lower === "::1" || // loopback
    lower === "::" || // unspecified
    lower.startsWith("fe8") || // fe80::/10 link-local
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("fc") || // fc00::/7 unique-local
    lower.startsWith("fd")
  );
}

type Lookup = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: Lookup = (host) => lookup(host, { all: true });

/**
 * Validate an outbound URL: must be https, and every resolved address must be
 * public. Returns the parsed URL on success; throws BlockedEgressError otherwise.
 * `resolve` is injectable for tests.
 */
export async function assertEgressAllowed(
  rawUrl: string,
  resolve: Lookup = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedEgressError("invalid URL");
  }
  if (url.protocol !== "https:") {
    throw new BlockedEgressError("only https URLs are allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const addresses = isIP(host)
    ? [host]
    : (await resolve(host)).map((a) => a.address);
  if (addresses.length === 0) {
    throw new BlockedEgressError("host did not resolve");
  }
  for (const ip of addresses) {
    if (isBlockedIp(ip)) {
      throw new BlockedEgressError(
        "host resolves to a private/reserved address",
      );
    }
  }
  return url;
}
