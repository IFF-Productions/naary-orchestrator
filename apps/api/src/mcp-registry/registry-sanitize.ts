/**
 * PURE sanitization for MCP-registry data (#578).
 *
 * THREAT MODEL: every field of a community registry entry is written by whoever published the
 * server — it is attacker-authorable text that we (a) return to a browser and (b) offer to write
 * into a Connection's `serverUrl`, which the WORKER later connects to with the tenant's bearer
 * token. So nothing from upstream is trusted:
 *
 *   - the transport URL must be https, credential-free, and not point at a private/reserved or
 *     loopback host, or it is dropped (never merely "flagged"). A `http://169.254.169.254/…` entry
 *     that reached a Connection would turn a tenant's MCP call into an SSRF with their token
 *     attached;
 *   - every string is length-capped and stripped of control characters (log/CSV/terminal injection);
 *   - link fields (homepage/repository) are restricted to http/https — a `javascript:` homepage in a
 *     community entry is the realistic XSS vector in a React app, since React escapes text but will
 *     happily put an arbitrary string in an `href`;
 *   - the result count is capped, so a hostile/huge registry response can't be relayed wholesale.
 *
 * DEFENCE IN DEPTH, not the only layer: the connection-create DTO independently re-checks https,
 * and the worker's MCP client calls `assertEgressAllowed` (a DNS-resolving, rebinding-proof check)
 * at the moment of egress. The check here is deliberately SYNCHRONOUS — resolving DNS for every row
 * of every search would make this endpoint a lookup amplifier.
 */
import { isBlockedIp } from "@naary/connections";

/** Trust tier shown in the UI. `curated` = in-repo, human-vetted; `community` = from the registry. */
export type McpTrustTier = "curated" | "community";

/** One browsable MCP server, already sanitized. This is the API's response shape. */
export interface McpRegistryServer {
  /** Stable identifier (registry name, or the curated entry's key). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description. Plain TEXT — never HTML; the UI must render it as text. */
  description: string;
  /** The https MCP endpoint to pre-fill as a Connection's `serverUrl`. */
  transportUrl: string;
  /** Streamable-HTTP is the only transport our MCP client speaks today. */
  transport: "http";
  /** Which auth scheme to pre-select on the connection form. */
  authMode: "api_token" | "pat" | "oauth" | "none";
  /** True when the server needs a credential from the user. */
  requiresAuth: boolean;
  trust: McpTrustTier;
  /** Optional http/https link for "learn more". Absent when upstream gave none/an unsafe one. */
  homepage?: string;
  /** Free-form tags/categories, capped + sanitized. */
  tags: string[];
}

/** Caps — bound both the payload we relay and what a UI has to render. */
export const MAX_SERVERS = 200;
export const MAX_NAME_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 400;
export const MAX_URL_CHARS = 2048;
export const MAX_TAGS = 8;
export const MAX_TAG_CHARS = 32;

/** Hostnames that are internal by NAME rather than by address. `assertEgressAllowed` catches these
 *  by resolution at egress time; refusing them here keeps them out of the UI (and out of a saved
 *  Connection) in the first place. */
const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
];

/** Collapse whitespace, strip C0/C1 control characters, and cap the length. */
export function sanitizeText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return cleaned.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/**
 * The transport URL, or null when it must not be offered. https-only, no embedded credentials, no
 * IP-literal/loopback/private host, no internal-by-name host, length-capped.
 */
export function sanitizeTransportUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // `https://user:pass@host/` — a credential in a URL we would hand to a tenant's connection form.
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return null;
  // An IP literal can be checked exactly, right here (no DNS needed).
  if (/^[0-9.]+$/.test(host) || host.includes(":")) {
    if (isBlockedIp(host)) return null;
  }
  if (
    BLOCKED_HOST_SUFFIXES.some((s) =>
      s.startsWith(".") ? host.endsWith(s) : host === s,
    )
  ) {
    return null;
  }
  // A host with no dot is either a bare internal name or a search-domain lookup — never a public
  // MCP endpoint.
  if (!host.includes(".")) return null;
  return url.toString();
}

/** An http/https link, or undefined. Anything else (javascript:, data:, file:) is dropped — this is
 *  the field that would otherwise become a hostile `href`. */
export function sanitizeLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_CHARS) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Auth scheme from an upstream hint, defaulting to `oauth` (what remote MCP servers overwhelmingly
 *  use) whenever the entry says it needs auth but not how. */
export function sanitizeAuthMode(
  value: unknown,
  requiresAuth: boolean,
): McpRegistryServer["authMode"] {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "oauth" || v === "oauth2" || v === "oauth2.1") return "oauth";
  if (v === "api_token" || v === "apikey" || v === "api_key")
    return "api_token";
  if (v === "pat" || v === "token" || v === "bearer") return "pat";
  if (v === "none" || v === "no_auth" || v === "public") return "none";
  return requiresAuth ? "oauth" : "none";
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const t of value) {
    const tag = sanitizeText(t, MAX_TAG_CHARS);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** First non-empty string among `keys` — the defensive read the upstream schema forces on us
 *  (the same pattern as the code-agent drivers' `firstString`). */
function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/**
 * Map ONE raw registry entry to a sanitized server, or null to drop it.
 *
 * The upstream registry's exact schema is NOT verified by this repo (we have no network in CI and
 * no contract test against it), so every read is defensive across the plausible field names and any
 * entry that doesn't yield a usable https remote URL is dropped rather than guessed at.
 */
export function sanitizeRegistryEntry(raw: unknown): McpRegistryServer | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const e = raw as Record<string, unknown>;

  // Remote transports: the registry nests them under `remotes` (an array of {type,url}); some
  // responses put a flat url/endpoint at the top level. Take the first that sanitizes clean.
  let transportUrl: string | null = null;
  let authHint: unknown;
  const remotes = e.remotes ?? e.remote ?? e.transports;
  if (Array.isArray(remotes)) {
    for (const r of remotes) {
      if (typeof r !== "object" || r === null) continue;
      const rr = r as Record<string, unknown>;
      const candidate = sanitizeTransportUrl(pick(rr, ["url", "endpoint"]));
      if (candidate) {
        transportUrl = candidate;
        authHint = pick(rr, [
          "auth",
          "authType",
          "auth_type",
          "authentication",
        ]);
        break;
      }
    }
  }
  transportUrl ??= sanitizeTransportUrl(
    pick(e, ["url", "endpoint", "serverUrl", "server_url"]),
  );
  // No usable remote endpoint (e.g. a stdio/npx-only server) → not connectable by us. Drop it
  // rather than surface a row that can't produce a working Connection.
  if (!transportUrl) return null;

  const name = sanitizeText(pick(e, ["name", "title", "id"]), MAX_NAME_CHARS);
  if (!name) return null;
  const id = sanitizeText(pick(e, ["id", "name"]), MAX_NAME_CHARS) || name;
  const description = sanitizeText(
    pick(e, ["description", "summary"]),
    MAX_DESCRIPTION_CHARS,
  );
  authHint ??= pick(e, ["auth", "authType", "auth_type", "authentication"]);
  const requiresAuthRaw = pick(e, ["requiresAuth", "requires_auth"]);
  // Default to "needs a credential": telling a user a server is open when it isn't is a worse
  // failure than an extra empty token field.
  const requiresAuth =
    typeof requiresAuthRaw === "boolean"
      ? requiresAuthRaw
      : sanitizeAuthMode(authHint, true) !== "none";
  const authMode = sanitizeAuthMode(authHint, requiresAuth);

  return {
    id,
    name,
    description,
    transportUrl,
    transport: "http",
    authMode,
    requiresAuth: authMode !== "none",
    trust: "community",
    ...(sanitizeLink(pick(e, ["homepage", "website", "repository", "repoUrl"]))
      ? {
          homepage: sanitizeLink(
            pick(e, ["homepage", "website", "repository", "repoUrl"]),
          ),
        }
      : {}),
    tags: sanitizeTags(pick(e, ["tags", "categories", "keywords"])),
  };
}

/** Find the server array in an upstream response body, tolerating the plausible envelopes. */
export function extractEntries(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body !== "object" || body === null) return [];
  const b = body as Record<string, unknown>;
  for (const key of ["servers", "data", "items", "results"]) {
    if (Array.isArray(b[key])) return b[key] as unknown[];
  }
  return [];
}

/** Sanitize a whole upstream response: drop unusable rows, de-duplicate by transport URL, cap. */
export function sanitizeRegistryResponse(body: unknown): McpRegistryServer[] {
  const out: McpRegistryServer[] = [];
  const seen = new Set<string>();
  for (const raw of extractEntries(body)) {
    const server = sanitizeRegistryEntry(raw);
    if (!server) continue;
    if (seen.has(server.transportUrl)) continue;
    seen.add(server.transportUrl);
    out.push(server);
    if (out.length >= MAX_SERVERS) break;
  }
  return out;
}

/** Case-insensitive substring match over name/description/tags. Pure, so the same filter serves
 *  the upstream and curated paths identically. */
export function matchesQuery(s: McpRegistryServer, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    s.name.toLowerCase().includes(needle) ||
    s.description.toLowerCase().includes(needle) ||
    s.tags.some((t) => t.toLowerCase().includes(needle))
  );
}
