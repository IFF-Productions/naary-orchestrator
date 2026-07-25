import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF defense for outbound connection traffic (Sec#2). A connection's
 * `serverUrl` is user-supplied and later fetched server-side with the tenant's
 * bearer token attached — so an attacker could point it at cloud metadata
 * (169.254.169.254), the DB/Temporal host, or their own server to exfiltrate the
 * token. We enforce https + resolve the host and reject any private/loopback/
 * link-local/reserved address.
 *
 * Checking at CALL time (not just at creation) shrinks the rebinding window, but it does
 * NOT close it on its own (audit #597): the caller then hands the hostname to a client
 * that resolves it a SECOND time, and the second answer can be private. Only PINNING —
 * connecting to the exact address that was validated — closes it. `safe-fetch.ts` pins
 * HTTP at the undici connector; non-HTTP callers (SQL drivers, SMTP) pin via
 * `resolvePinnedHost` below and pass the returned address to the driver.
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

/**
 * Expand an IPv6 literal to its 8 hextets, or null if unparseable. Handles `::`
 * compression and an embedded dotted-v4 tail (`::ffff:1.2.3.4`). String prefix
 * checks are NOT enough here: Node's URL parser normalizes IPv4-mapped addresses
 * to the hex-compressed form (`[::ffff:127.0.0.1]` → `::ffff:7f00:1`), which a
 * dotted-decimal regex never matches — the bypass behind issue #590.
 */
function expandV6(ip: string): number[] | null {
  let s = ip;
  const v4tail = s.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const p = v4tail[1].split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return null;
    }
    s =
      s.slice(0, s.length - v4tail[1].length) +
      (((p[0] << 8) | p[1]).toString(16) +
        ":" +
        (((p[2] << 8) | p[3]) >>> 0).toString(16));
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : head.length !== 8) return null;
  const groups = [
    ...head,
    ...(halves.length === 2 ? Array<string>(missing).fill("0") : []),
    ...tail,
  ];
  if (groups.length !== 8) return null;
  const out = groups.map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  return out.some(Number.isNaN) ? null : out;
}

function isBlockedV6(ip: string): boolean {
  // A zone index (fe80::1%eth0) is inherently link-local/interface-scoped.
  const lower = ip.toLowerCase();
  if (lower.includes("%")) return true;
  const g = expandV6(lower);
  if (!g) return true; // unparseable → unsafe
  const embeddedV4 = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    // IPv4-mapped ::ffff:0:0/96 (both dotted and hex-compressed spellings land here).
    if (g[5] === 0xffff) return isBlockedV4(embeddedV4(g[6], g[7]));
    if (g[5] === 0) {
      // `::` (unspecified), `::1` (loopback), and deprecated IPv4-compatible ::a.b.c.d.
      if (g[6] === 0 && g[7] <= 1) return true;
      return isBlockedV4(embeddedV4(g[6], g[7]));
    }
  }
  // NAT64 (64:ff9b::/96) — the suffix is a real IPv4 destination.
  if (
    g[0] === 0x64 &&
    g[1] === 0xff9b &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0
  ) {
    return isBlockedV4(embeddedV4(g[6], g[7]));
  }
  // 6to4 (2002::/16) — hextets 1-2 embed the v4 address.
  if (g[0] === 0x2002) return isBlockedV4(embeddedV4(g[1], g[2]));
  // Teredo (2001:0::/32) — the client v4 is obfuscated; reject outright.
  if (g[0] === 0x2001 && g[1] === 0) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if (g[0] >= 0xff00) return true; // ff00::/8 multicast
  return false;
}

type Lookup = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: Lookup = (host) => lookup(host, { all: true });

/**
 * Resolve a bare host ONCE, reject if any address is private/loopback/link-local/reserved,
 * and return the single address the caller MUST connect to — the SSRF guard for NON-HTTP
 * outbound (SQL drivers, SMTP), where the https-only `assertEgressAllowed` doesn't apply.
 *
 * Returning the address is the whole point (#597): a caller that validates a hostname and
 * then hands the *hostname* to a driver lets the driver re-resolve it, so DNS can answer
 * public for us and private for the driver (rebinding TOCTOU). Pass this address to the
 * driver as the connect target — keeping the ORIGINAL hostname as the TLS servername, so
 * certificate validation is unchanged — and the connected address is exactly the checked
 * one. An IP literal needs no lookup and is returned as-is (after validation).
 *
 * Note this deliberately collapses a multi-address (round-robin / dual-stack) host to one
 * address: pinning and per-address failover are mutually exclusive. Same property as the
 * pinned HTTP path. `resolve` is injectable for tests.
 */
export async function resolvePinnedHost(
  host: string,
  resolve: Lookup = defaultLookup,
): Promise<string> {
  const h = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!h) throw new BlockedEgressError("empty host");
  const addresses = isIP(h) ? [h] : (await resolve(h)).map((a) => a.address);
  if (addresses.length === 0) {
    throw new BlockedEgressError("host did not resolve");
  }
  // Reject if ANY answer is internal — a record set that mixes public and private is
  // exactly what a rebinding attack looks like, so don't cherry-pick the public one.
  for (const ip of addresses) {
    if (isBlockedIp(ip)) {
      throw new BlockedEgressError(
        "host resolves to a private/reserved address",
      );
    }
  }
  return addresses[0];
}

/**
 * Assert a bare host is public. Thin wrapper over `resolvePinnedHost` so there is ONE
 * validation path — use it only where the caller genuinely cannot pin (it leaves the
 * rebinding window open); prefer `resolvePinnedHost` and connect to what it returns.
 */
export async function assertHostPublic(
  host: string,
  resolve: Lookup = defaultLookup,
): Promise<void> {
  await resolvePinnedHost(host, resolve);
}

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
