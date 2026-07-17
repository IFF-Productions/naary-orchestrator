// Signing/crypto nodes: hmac / hash / jwt / totp.
import { createHash, createHmac } from "node:crypto";
import { ApplicationFailure } from "@temporalio/activity";
import type { ResolvedHash, ResolvedHmac, ResolvedJwt } from "@naary/dsl";
import {
  MissingConnectionTokenError,
  NeedsReauthError,
  resolveSigningKey,
} from "@naary/connections";
import { getObjectStore, resolveClaimChecks } from "@naary/storage";
import { activityDuration, activityRuns, secondsSince } from "../../metrics";
import { type AgentMeta, toSanitizedRetryable } from "./shared";

// Signing key resolution is the injectable I/O seam for the hmac/jwt activities
// (swapped in unit tests so no DB/secret store is needed).
export const __signingDeps = { resolveSigningKey };

/** Map a missing/invalid signing key to a clear non-retryable failure; anything
 *  else is a sanitized transient (never leaks the key). */
function toSigningFailure(e: unknown, type: string): ApplicationFailure {
  if (e instanceof ApplicationFailure) return e;
  if (
    e instanceof MissingConnectionTokenError ||
    e instanceof NeedsReauthError
  ) {
    return ApplicationFailure.nonRetryable(
      "Signing connection has no usable key — reconnect it",
      "CONNECTION_REAUTH",
    );
  }
  return toSanitizedRetryable(e, type);
}

export interface HmacResult {
  status: "ok";
  digest: string;
  costUsd: number;
}

/** Coerce a rehydrated payload to the bytes that get signed (objects → JSON). */
function toSignedString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * hmac node — sign the resolved payload with the `signing` connection's key. The
 * key is read here and used in memory only (never returned/logged/in history). A
 * bound payload that was claim-checked upstream is rehydrated FIRST, so we sign the
 * real data, not the `{__claimCheck}` reference (mirrors callSqlQuery/callHttpRequest).
 */
export async function callHmac(
  cfg: ResolvedHmac,
  _input: unknown,
  meta: AgentMeta,
): Promise<HmacResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const key = await __signingDeps.resolveSigningKey(
      meta.tenantId,
      cfg.connectionId,
    );
    const payload = toSignedString(
      await resolveClaimChecks(cfg.payload, store),
    );
    const digest = createHmac(cfg.algorithm, key)
      .update(payload)
      .digest(cfg.encoding);
    activityRuns.inc({ activity: "callHmac", outcome: "ok" });
    activityDuration.observe({ activity: "callHmac" }, secondsSince(startedAt));
    return { status: "ok", digest, costUsd: 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callHmac", outcome: "error" });
    activityDuration.observe({ activity: "callHmac" }, secondsSince(startedAt));
    throw toSigningFailure(e, "HMAC_ERROR");
  }
}

export interface HashResult {
  status: "ok";
  digest: string;
  costUsd: number;
}

/**
 * hash node — a keyless one-way digest of the resolved input (n8n's String.hash()). Runs in
 * an activity (node:crypto isn't in the deterministic bundle). A claim-checked bound input is
 * rehydrated FIRST so we hash the real data, not the `{__claimCheck}` reference. No secrets.
 */
export async function callHash(
  cfg: ResolvedHash,
  _input: unknown,
  meta: AgentMeta,
): Promise<HashResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const value = toSignedString(await resolveClaimChecks(cfg.input, store));
    const digest = createHash(cfg.algorithm).update(value).digest(cfg.encoding);
    activityRuns.inc({ activity: "callHash", outcome: "ok" });
    activityDuration.observe({ activity: "callHash" }, secondsSince(startedAt));
    return { status: "ok", digest, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity: "callHash", outcome: "error" });
    activityDuration.observe({ activity: "callHash" }, secondsSince(startedAt));
    throw ApplicationFailure.nonRetryable("Hash failed", "HASH_ERROR");
  }
}

export interface JwtResult {
  status: "ok";
  token: string;
  costUsd: number;
}

/**
 * jwt node — mint an HS256 JWT from the resolved claims, signed by the `signing`
 * connection's key. `iat` is stamped; `exp` set when `expiresInSeconds` is given.
 */
export async function callJwt(
  cfg: ResolvedJwt,
  _input: unknown,
  meta: AgentMeta,
): Promise<JwtResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const key = await __signingDeps.resolveSigningKey(
      meta.tenantId,
      cfg.connectionId,
    );
    // Rehydrate any claim-checked bound claim value before signing (so the token
    // carries the real data, not a `{__claimCheck}` reference).
    const claims = (await resolveClaimChecks(cfg.claims, store)) as Record<
      string,
      unknown
    >;
    // HS256: the key is the shared secret. RS256: the key is a PEM PKCS#8 RSA
    // private key, imported into a CryptoKey.
    const { SignJWT, importPKCS8 } = await import("jose");
    const signKey =
      cfg.algorithm === "RS256"
        ? await importPKCS8(key, "RS256")
        : new TextEncoder().encode(key);
    let signer = new SignJWT(claims)
      .setProtectedHeader({ alg: cfg.algorithm })
      .setIssuedAt();
    if (cfg.expiresInSeconds && cfg.expiresInSeconds > 0) {
      signer = signer.setExpirationTime(
        new Date(Date.now() + cfg.expiresInSeconds * 1000),
      );
    }
    const token = await signer.sign(signKey);
    activityRuns.inc({ activity: "callJwt", outcome: "ok" });
    activityDuration.observe({ activity: "callJwt" }, secondsSince(startedAt));
    return { status: "ok", token, costUsd: 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callJwt", outcome: "error" });
    activityDuration.observe({ activity: "callJwt" }, secondsSince(startedAt));
    throw toSigningFailure(e, "JWT_ERROR");
  }
}

/** Decode an RFC-4648 base32 string (the TOTP seed) to bytes. Case-insensitive,
 *  ignores whitespace and padding. Throws on an invalid character (message carries
 *  no secret). */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/[=\s]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) throw new Error("invalid base32 TOTP seed");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC-4226 HOTP → the `digits`-length code for `counter`. */
function hotp(
  secret: Buffer,
  counter: number,
  digits: number,
  algorithm: string,
): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

export interface TotpConfig {
  connectionId: string;
  digits?: number;
  period?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
}

export interface TotpResult {
  status: "ok";
  code: string;
  costUsd: number;
}

// Injectable seam: the seed resolver + the clock (so tests are deterministic).
export const __totpDeps = { resolveSigningKey, now: () => Date.now() };

/**
 * totp node — generate the current RFC-6238 code from a `signing` connection's
 * base32 seed. The seed is read + used here only (never returned/logged/in
 * history); the clock read is why this is an activity, not workflow code.
 */
export async function callTotp(
  cfg: TotpConfig,
  _input: unknown,
  meta: AgentMeta,
): Promise<TotpResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const seed = await __totpDeps.resolveSigningKey(
      meta.tenantId,
      cfg.connectionId,
    );
    const secret = base32Decode(seed);
    const period = cfg.period && cfg.period > 0 ? cfg.period : 30;
    const digits = cfg.digits && cfg.digits > 0 ? cfg.digits : 6;
    const counter = Math.floor(__totpDeps.now() / 1000 / period);
    const code = hotp(secret, counter, digits, cfg.algorithm ?? "sha1");
    activityRuns.inc({ activity: "callTotp", outcome: "ok" });
    activityDuration.observe({ activity: "callTotp" }, secondsSince(startedAt));
    return { status: "ok", code, costUsd: 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callTotp", outcome: "error" });
    activityDuration.observe({ activity: "callTotp" }, secondsSince(startedAt));
    throw toSigningFailure(e, "TOTP_ERROR");
  }
}
