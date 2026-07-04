import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { BlockedEgressError, isBlockedIp } from "./egress";

/**
 * SSRF-hardened fetch. The `assertEgressAllowed`/`assertHostPublic` pre-checks
 * validate the FIRST hop, but plain `fetch` then (a) follows redirects without
 * re-checking each `Location` (redirect-bypass) and (b) re-resolves the hostname
 * independently of the guard (DNS-rebinding TOCTOU). This closes both by validating
 * at the TRANSPORT layer: a custom undici connector runs for EVERY connection —
 * including every redirect hop — resolves the host itself, rejects any
 * private/reserved IP, and connects by PINNING the validated IP (so the connected
 * address is exactly the one that was checked). IP-literal targets are validated
 * directly (no DNS lookup fires for a literal).
 */
const baseConnect = buildConnector({});

/** Build a guarded dispatcher. `isBlocked` is injectable so tests can exercise the
 *  ALLOW path against a local server (default is the real private/reserved check). */
export function createGuardedDispatcher(
  isBlocked: (ip: string) => boolean = isBlockedIp,
): Agent {
  const guardedConnect: ReturnType<typeof buildConnector> = (
    opts,
    callback,
  ) => {
    const host = opts.hostname;
    // IP literal → validate directly (dns.lookup never runs for a literal).
    if (isIP(host)) {
      if (isBlocked(host)) {
        callback(
          new BlockedEgressError("host is a private/reserved address"),
          null,
        );
        return;
      }
      baseConnect(opts, callback);
      return;
    }
    // Hostname → resolve, validate the address, then connect PINNED to that IP
    // (keeping the servername so TLS cert validation still checks the hostname).
    dnsLookup(host, (err, address) => {
      if (err) {
        callback(err, null);
        return;
      }
      if (isBlocked(String(address))) {
        callback(
          new BlockedEgressError("host resolves to a private/reserved address"),
          null,
        );
        return;
      }
      baseConnect(
        {
          ...opts,
          hostname: String(address),
          servername: opts.servername ?? host,
        },
        callback,
      );
    });
  };
  return new Agent({ connect: guardedConnect });
}

/** Shared dispatcher — one connection pool, guarded connector (real predicate). */
const guardedDispatcher = createGuardedDispatcher();

/** `fetch` bound to a specific dispatcher — the default export uses the shared
 *  guarded one; tests pass a dispatcher with a relaxed predicate to hit the allow path. */
export function safeFetchWith(
  dispatcher: Agent,
  url: string,
  init?: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> {
  return undiciFetch(url, { ...init, dispatcher });
}

/**
 * Drop-in `fetch` that routes through the guarded dispatcher. Use this for ALL
 * outbound HTTP in activities (httpRequest, rssRead) instead of global `fetch`.
 * The `assertEgressAllowed` pre-check is still worthwhile (https-only + fail fast
 * with a clear error before opening a socket); this is the transport backstop that
 * also covers redirects + rebinding.
 */
export function safeFetch(
  url: string,
  init?: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> {
  return safeFetchWith(guardedDispatcher, url, init);
}
