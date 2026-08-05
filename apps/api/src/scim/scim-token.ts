import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The SCIM connection bearer (design LDAP-DIRECTORY.md §3.1, #1075).
 *
 * A DISTINCT prefix from the two that already exist, and the distinctness is load-bearing
 * rather than cosmetic:
 *
 *   `nry_`     → ApiToken. AuthGuard stamps a verified one as `role: "owner"` for its tenant
 *                (the "zero grants ⇒ full-access owner stamp" branch) and ApiToken has no
 *                scope column — so it is the whole workspace, not a directory capability.
 *   `nrys_`    → an SSO session, which authenticates a USER.
 *   `nryscim_` → this. Authenticates a CONNECTION, never a principal.
 *
 * `nryscim_` cannot be mistaken for either: it does not start with `nry_` (no underscore
 * after `nry`) and does not start with `nrys_` (no underscore after `nrys`), so a SCIM token
 * presented to the global AuthGuard falls through to the user branches and is rejected as an
 * unverifiable Firebase token — it can never accidentally mint a principal.
 */
export const SCIM_TOKEN_PREFIX = "nryscim_";

/** sha256 hex — the only form of the token persisted; the plaintext is shown once at
 *  registration and cannot be recovered. Same discipline as ApiTokenService.hashToken. */
export const hashScimToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/** Mint a new plaintext SCIM bearer. 24 random bytes, base64url — ApiTokenService's shape. */
export const newScimToken = (): string =>
  `${SCIM_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;

/** Is this bearer addressed to the SCIM surface at all? Checked BEFORE any DB work so a
 *  Firebase/`nry_` bearer aimed at /scim/v2 never becomes a token-table lookup. */
export const isScimToken = (token: string): boolean =>
  token.startsWith(SCIM_TOKEN_PREFIX);

/** Constant-time hex comparison, for the places we compare two digests rather than letting
 *  the unique index do the matching. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
