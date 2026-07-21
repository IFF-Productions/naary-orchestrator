import type { ArgBinding } from "./core";

/**
 * HMAC node — sign a payload with a `signing` connection's secret key. The KEY is
 * never in config (only `connectionId`); it's read + used IN the activity
 * (CLAUDE.md rule 4). Output is `{ digest }` (the MAC, hex/base64). `payload` is
 * static; `payloadBinding` overrides it from an upstream output (objects are
 * JSON-stringified before signing).
 */
export interface HmacNodeConfig {
  /** A `signing` connection; its stored key is read in-activity. */
  connectionId: string;
  algorithm?: "sha256" | "sha1";
  /** Static payload to sign (string, or object → JSON). */
  payload?: unknown;
  /** Upstream binding whose value replaces `payload`. */
  payloadBinding?: ArgBinding;
  /** Output digest encoding. Default "hex". */
  encoding?: "hex" | "base64";
}

/**
 * Hash node — a one-way digest of a value (n8n's String.hash()). Unlike `hmac`/`jwt`/`totp`
 * there is NO key or connection: it just hashes. `input` is the static value; `inputBinding`
 * overrides it from an upstream output (objects are JSON-stringified before hashing). Output
 * is `{ digest }`. Runs in an ACTIVITY (node:crypto isn't in the deterministic bundle).
 */
export interface HashNodeConfig {
  /** Digest algorithm (default "sha256"). */
  algorithm?: "sha256" | "sha512" | "sha1" | "md5";
  /** Static value to hash (string, or object → JSON). */
  input?: unknown;
  /** Upstream binding whose value replaces `input`. */
  inputBinding?: ArgBinding;
  /** Output digest encoding (default "hex"). */
  encoding?: "hex" | "base64";
}

/**
 * JWT node — mint an HS256 JSON Web Token signed by a `signing` connection's key
 * (read + used IN the activity, never in config). Output is `{ token }`. `claims`
 * is the static payload; each `claimsBindings` entry fills/overrides a claim from
 * an upstream output. `iat`/`exp` are set by the signer.
 */
export interface JwtNodeConfig {
  /** A `signing` connection; its stored secret is the HS256 shared key, or (for
   *  RS256) a PEM PKCS#8 RSA PRIVATE key. */
  connectionId: string;
  /** Signature algorithm (default "HS256"). */
  algorithm?: "HS256" | "RS256";
  /** Static claims (the base payload). */
  claims?: Record<string, unknown>;
  /** claim path → upstream output binding; fills/overrides that claim. */
  claimsBindings?: Record<string, ArgBinding>;
  /** Token lifetime in seconds (sets `exp`). Omitted = no expiry. */
  expiresInSeconds?: number;
}

/**
 * TOTP node — generate the current RFC-6238 time-based one-time code from a base32
 * seed stored in a `signing` connection (the seed is read + used IN the activity,
 * never in config/history; the clock read is why this is an activity). Output is
 * `{ code }`. No bindings — the seed comes from the connection, the time from the
 * clock.
 */
export interface TotpNodeConfig {
  /** A `signing` connection whose secret is the base32 TOTP seed. */
  connectionId: string;
  /** Number of digits (default 6). */
  digits?: number;
  /** Time step in seconds (default 30). */
  period?: number;
  /** HMAC algorithm (default "sha1", per most authenticator apps). */
  algorithm?: "sha1" | "sha256" | "sha512";
}
