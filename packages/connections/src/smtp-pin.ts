import { isIP } from "node:net";
import { resolvePinnedHost } from "./egress";

type Lookup = (host: string) => Promise<{ address: string }[]>;

/**
 * Validate a tenant-supplied SMTP URI and return the URI nodemailer should actually dial:
 * the host replaced by the ONE address we resolved and checked, plus `servername` so TLS
 * still validates the certificate against the original hostname.
 *
 * Why rewrite the URI instead of just pre-checking the host (audit #597): nodemailer
 * resolves the hostname itself (`shared.resolveHostname`), independently of our guard — so
 * `assertHostPublic(host)` then `createTransport(uri)` leaves a rebinding window where DNS
 * answers public for us and private for nodemailer. Handing it a literal address means no
 * lookup happens at connect time at all, so the connected address is exactly the checked one.
 *
 * The `servername` query param is nodemailer's own public option (its connection-URL parser
 * copies unknown query keys onto the transport options), and SMTPConnection would otherwise
 * derive SNI from the host — which is now an IP, i.e. no SNI and certificate validation
 * against the address. An explicit servername keeps cert checking on the hostname; a URI that
 * already sets one wins (the operator's intent, not ours). Credentials and every other query
 * option (`?requireTLS=`, `?tls.*=`) survive the round-trip untouched.
 *
 * An IP-literal host is returned unchanged: nothing to pin (no DNS), and adding a servername
 * would silently change what the certificate is checked against.
 */
export async function pinnedSmtpUri(
  uri: string,
  resolve?: Lookup,
): Promise<string> {
  const u = new URL(uri);
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const pinned = await resolvePinnedHost(host, resolve);
  if (isIP(host)) return uri;
  u.hostname = isIP(pinned) === 6 ? `[${pinned}]` : pinned;
  if (!u.searchParams.has("servername")) {
    u.searchParams.set("servername", host);
  }
  return u.toString();
}
