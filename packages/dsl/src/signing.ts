import { getByPath } from "./mcp-args";
import type { HmacNodeConfig, JwtNodeConfig } from "./types";

/** The concrete hmac request after binding resolution — no secret (the key is
 *  attached in the activity from `connectionId`). `payload` is the RAW resolved
 *  value: a bound value may be a claim-check reference, which the activity
 *  rehydrates before stringifying + signing (so we don't sign the reference). */
export interface ResolvedHmac {
  connectionId: string;
  algorithm: "sha256" | "sha1";
  payload: unknown;
  encoding: "hex" | "base64";
}

/**
 * Resolve an hmac node's concrete request from ctx. Pure, deterministic graph work
 * (path-reads, no I/O, no key). `payloadBinding` overrides the static payload. The
 * raw value is passed through — stringification happens in the activity, AFTER any
 * claim-check is rehydrated.
 */
export function resolveHmac(
  config: HmacNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedHmac {
  return {
    connectionId: config.connectionId,
    algorithm: config.algorithm ?? "sha256",
    payload: config.payloadBinding
      ? getByPath(ctx[config.payloadBinding.from], config.payloadBinding.path)
      : config.payload,
    encoding: config.encoding ?? "hex",
  };
}

/** The concrete jwt request after binding resolution — no secret. */
export interface ResolvedJwt {
  connectionId: string;
  algorithm: "HS256" | "RS256";
  claims: Record<string, unknown>;
  expiresInSeconds?: number;
}

/**
 * Resolve a jwt node's claims from ctx. Static `claims` are the base; each
 * `claimsBindings` entry fills/overrides a claim with the upstream value. Pure —
 * the signing key is never here (attached in the activity). The base is cloned so a
 * binding can't mutate the in-memory graph definition.
 */
export function resolveJwt(
  config: JwtNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedJwt {
  const claims: Record<string, unknown> = config.claims
    ? (JSON.parse(JSON.stringify(config.claims)) as Record<string, unknown>)
    : {};
  for (const [name, binding] of Object.entries(config.claimsBindings ?? {})) {
    claims[name] = getByPath(ctx[binding.from], binding.path);
  }
  return {
    connectionId: config.connectionId,
    algorithm: config.algorithm ?? "HS256",
    claims,
    expiresInSeconds: config.expiresInSeconds,
  };
}
