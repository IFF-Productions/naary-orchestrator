import { createHash, randomBytes, randomInt } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { CLI_TOKEN_LABEL_STEM } from "./api-token.service";

/** sha256 hex — the only form of the device code persisted, exactly as ApiTokenService and
 *  CliRefreshTokenService do it. The plaintext is returned to the CLI once and stored nowhere. */
const hashCode = (code: string): string =>
  createHash("sha256").update(code).digest("hex");

/**
 * How long a pending handshake lives (#1078 §2). Short on purpose: the window in which a device
 * code is worth anything at all. Ten minutes is enough for a human to switch to a browser, sign
 * in (possibly through SSO + MFA) and approve, and short enough that an abandoned request is
 * useless almost immediately. Enforced server-side on approve AND on exchange — the client's
 * clock is never consulted.
 */
export const CLI_AUTH_REQUEST_TTL_MS = 10 * 60_000;

/** How often the CLI should poll `/auth/cli/exchange`, in seconds (RFC 8628's `interval`). */
export const CLI_AUTH_POLL_INTERVAL_SECONDS = 5;

/**
 * Bearer prefix for a DEVICE code.
 *
 * Deliberately not `nry_`, `nrys_` or `nryr_`: `"nryd_x".startsWith("nry_") === false`, so a device
 * code presented as an `Authorization` header authenticates nothing in `AuthGuard`. Same reasoning
 * as CLI_REFRESH_TOKEN_PREFIX — a credential for exactly one endpoint should be incapable of
 * authenticating a request, not merely unused for one.
 */
export const CLI_DEVICE_CODE_PREFIX = "nryd_";

/** Label for a token minted by a browser login. The suffix is the sanitized hostname the CLI
 *  reported, so the workspace's token list names the device. */
export const CLI_TOKEN_LABEL_PREFIX = `${CLI_TOKEN_LABEL_STEM} — `;

/**
 * The user-code alphabet: no vowels (so a random code can't spell something unfortunate) and no
 * `0/O/1/I/5/S`-style look-alikes, because this is read off a terminal and retyped by hand.
 */
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRTVWXYZ2346789";
const USER_CODE_LENGTH = 8;

/** Why a decision (approve/deny) could not be applied. The caller maps every one of these to a
 *  message for a signed-in human — none of them is a credential oracle (the user code is not a
 *  secret), unlike the exchange's failures below. */
export type CliAuthDecisionFailure =
  /** No pending request with that user code. */
  | "unknown"
  /** Found, but past its 10-minute window. */
  | "expired"
  /** Already approved, denied or redeemed — terminal, and NOT re-bindable to another user. */
  | "already_decided";

export type CliAuthDecisionResult =
  { ok: true; label: string } | { ok: false; reason: CliAuthDecisionFailure };

/** What the exchange found for a presented device code. */
export type CliAuthClaim =
  /** Approved and CLAIMED by this call — the caller must now mint. Happens at most once per row. */
  | { status: "approved"; tenantId: string; userId: string; label: string }
  /** Live, but nobody has approved it yet. The CLI keeps polling. */
  | { status: "pending" }
  /** A human said "that wasn't me". Terminal; the CLI should stop polling and say so. */
  | { status: "denied" }
  /** Unknown, expired, or already redeemed — ONE state on purpose. See `claim()`. */
  | { status: "invalid" };

export interface StartedCliAuthRequest {
  /** Plaintext device code — the CLI's secret, returned once and never stored. */
  deviceCode: string;
  /** The hyphenated display form the human reads and types (canonical form is stored). */
  userCode: string;
  label: string;
  expiresAt: Date;
}

/**
 * The `naary auth` browser handshake (design #1078 §2, shape B — device code, slice 3).
 *
 * Why shape B and not the loopback redirect: §1 measured that App Check rejects a password grant
 * before it evaluates credentials, so the BROWSER must do the login; §2 then picks the device-code
 * shape over RFC 8252 loopback because the token never crosses a loopback hop (so §2A's token
 * INJECTION threat does not exist to defend) and because loopback breaks over SSH, which is exactly
 * where a CLI is used.
 *
 * What plays the role of §2A's `state` nonce here is the DEVICE CODE itself: 32 random bytes that
 * only the CLI process that called `start()` ever holds, never rendered in a browser, never in a
 * URL. The browser's approval is bound to a row; only a caller who can present that row's device
 * code can redeem it. Verification is a sha256 lookup on a UNIQUE index — the same discipline as
 * `ApiTokenService.verify()` — so there is no secret-vs-secret string compare to make constant-time.
 *
 * The two properties this class exists to guarantee:
 *
 *  1. A device code is redeemable EXACTLY ONCE. `claim()` stamps `consumedAt` with a compare-and-set
 *     on NULL and mints only if it won; a lost race mints nothing.
 *  2. A redeemed or expired code is INDISTINGUISHABLE from one that never existed — all three
 *     return `{ status: "invalid" }`, and the controller renders one identical failure for them.
 *
 * The identity is bound by `approve()`, from an AUTHENTICATED browser session, in a single
 * compare-and-set — so two concurrent approvals cannot both "succeed" with the last writer silently
 * rebinding the request to a different user.
 */
@Injectable()
export class CliAuthRequestService {
  /**
   * Open a handshake. Unauthenticated by design (the CLI has no credential yet), which is why the
   * route that calls this is rate-limited: the only thing an anonymous caller gains here is a row.
   */
  async start(
    hostname: string | undefined,
    now: Date = new Date(),
  ): Promise<StartedCliAuthRequest> {
    const deviceCode = `${CLI_DEVICE_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
    const label = `${CLI_TOKEN_LABEL_PREFIX}${sanitizeHostname(hostname)}`;
    const expiresAt = new Date(now.getTime() + CLI_AUTH_REQUEST_TTL_MS);

    // `userCode` is UNIQUE, so a collision is a P2002 — vanishingly unlikely at 26^8, but a 500 on
    // a login is not an acceptable way to find out. Retry with a fresh code a few times.
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = newUserCode();
      try {
        await getPrisma().cliAuthRequest.create({
          data: {
            deviceCodeHash: hashCode(deviceCode),
            userCode,
            label,
            createdAt: now,
            expiresAt,
          },
        });
        return {
          deviceCode,
          userCode: displayUserCode(userCode),
          label,
          expiresAt,
        };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  /**
   * Bind an identity to a pending request. Called ONLY from the authenticated browser route, with a
   * tenant/user the guard resolved — never from anything the CLI sends.
   */
  async approve(
    userCode: string,
    tenantId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<CliAuthDecisionResult> {
    return this.decide(userCode, now, {
      approvedAt: now,
      tenantId,
      userId,
    });
  }

  /** "That wasn't me." Terminal, and the anti-phishing exit from a code the user did not generate. */
  async deny(
    userCode: string,
    now: Date = new Date(),
  ): Promise<CliAuthDecisionResult> {
    return this.decide(userCode, now, { deniedAt: now });
  }

  /**
   * Redeem a device code — the single-use gate.
   *
   * The `expiresAt` check IS load-bearing and has no backstop: an approval that sat unredeemed past
   * its window must not mint, and nothing below would stop it.
   *
   * The `consumedAt` check above `approvedAt` is NOT — verified by mutation, and worth writing down
   * so nobody trusts it as a control. Moving it below leaves every test green, because a replay
   * then falls through to the compare-and-set, loses it, and returns `invalid` anyway. Single use
   * rests on the CAS alone; this early return is a short-circuit that saves a pointless write.
   */
  async claim(
    deviceCode: string,
    now: Date = new Date(),
  ): Promise<CliAuthClaim> {
    const db = getPrisma();
    const row = await db.cliAuthRequest.findUnique({
      where: { deviceCodeHash: hashCode(deviceCode) },
    });
    // Unknown / expired / already redeemed collapse into ONE answer. A caller must not be able to
    // learn that a code it presented was real-but-spent: that distinction is exactly what tells an
    // attacker holding a leaked device code whether it is worth racing the legitimate CLI for.
    if (!row) return { status: "invalid" };
    if (row.expiresAt.getTime() <= now.getTime()) return { status: "invalid" };
    if (row.consumedAt) return { status: "invalid" };
    if (row.deniedAt) return { status: "denied" };
    if (!row.approvedAt || !row.tenantId || !row.userId)
      return { status: "pending" };

    // Compare-and-set. `consumedAt: null` in the WHERE is what makes redemption single-use under
    // concurrency: two callers racing the same approved row both read `consumedAt === null` above,
    // and exactly one can flip it. Only that one is told `approved`, so only that one mints.
    const claimed = await db.cliAuthRequest.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) return { status: "invalid" };

    return {
      status: "approved",
      tenantId: row.tenantId,
      userId: row.userId,
      label: row.label,
    };
  }

  /** Shared approve/deny body: validate, then apply the decision as a compare-and-set on "no
   *  decision yet". Two concurrent approvals must not both succeed with the last writer rebinding
   *  the request onto a different user — that would be the cross-user hole this slice exists to
   *  close, so the guard is in the WHERE and not in an `if`. */
  private async decide(
    userCode: string,
    now: Date,
    data: Record<string, unknown>,
  ): Promise<CliAuthDecisionResult> {
    const db = getPrisma();
    const normalized = normalizeUserCode(userCode);
    if (!normalized) return { ok: false, reason: "unknown" };
    const row = await db.cliAuthRequest.findUnique({
      where: { userCode: normalized },
    });
    if (!row) return { ok: false, reason: "unknown" };
    if (row.expiresAt.getTime() <= now.getTime())
      return { ok: false, reason: "expired" };
    if (row.approvedAt || row.deniedAt || row.consumedAt)
      return { ok: false, reason: "already_decided" };

    const decided = await db.cliAuthRequest.updateMany({
      where: {
        id: row.id,
        approvedAt: null,
        deniedAt: null,
        consumedAt: null,
      },
      data,
    });
    if (decided.count !== 1) return { ok: false, reason: "already_decided" };
    return { ok: true, label: row.label };
  }
}

/** Canonical user code: uppercase, separators and unknown characters dropped. The human types what
 *  they see ("PQ4M-TWZ9"); anything that isn't an alphabet character is noise. Returns "" when the
 *  input has no usable characters, which the caller treats as "unknown". */
export function normalizeUserCode(raw: string | undefined): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .toUpperCase()
    .split("")
    .filter((c) => USER_CODE_ALPHABET.includes(c))
    .join("");
  return cleaned.length === USER_CODE_LENGTH ? cleaned : "";
}

/** Hyphenated display form — the code as the CLI prints it and the browser shows it. */
export function displayUserCode(canonical: string): string {
  return `${canonical.slice(0, 4)}-${canonical.slice(4)}`;
}

/**
 * The hostname the CLI reports, made safe to store and render.
 *
 * It is caller-controlled text that ends up in a token LABEL shown in Settings, so: control
 * characters (which could forge a log line or break a table cell) are dropped, whitespace is
 * collapsed, and the result is capped. An empty/garbage value degrades to a fixed placeholder
 * rather than an empty label.
 */
export function sanitizeHostname(raw: string | undefined): string {
  if (typeof raw !== "string") return "unknown device";
  // ALLOWLIST, not a denylist of control characters: what a hostname or a friendly device name can
  // legitimately contain is a small closed set, and an allowlist cannot be walked around by a
  // character nobody thought of (a newline forging a log line, a bidi override, an emoji).
  const cleaned = raw
    .split("")
    .map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return cleaned || "unknown device";
}

/** Unbiased random user code (`randomInt`, not `Math.random()` or a modulo of random bytes). */
function newUserCode(): string {
  let out = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    out += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return out;
}

/** Prisma's unique-constraint error, without importing the generated client here. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}
