import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { appBaseUrl } from "../connections/connect-return";
import { ApiEndpoint } from "../swagger/api-decorators";
import { CLI_TOKEN_LABEL_STEM, ApiTokenService } from "./api-token.service";
import {
  CLI_AUTH_POLL_INTERVAL_SECONDS,
  CliAuthRequestService,
} from "./cli-auth-request.service";
import {
  CliAuthDecisionDto,
  CliAuthDecisionResponse,
  CliAuthExchangeDto,
  CliAuthExchangeResponse,
  CliAuthRefreshDto,
  CliAuthStartDto,
  CliAuthStartResponse,
} from "./cli-auth.dto";
import { CliRefreshTokenService } from "./cli-refresh-token.service";
import { Public } from "./public.decorator";
import { CurrentPrincipal, type Principal } from "./tenant.decorator";

/**
 * Access-token lifetime for a CLI session (#1078 §3): "Recommended: 12-hour access tokens." It
 * covers a working day, so a developer re-authenticates about once a day even if refresh is broken,
 * and a token leaked via shell history or a laptop backup is dead the same day. One hour would be
 * tighter, but each refresh is a network round-trip AND a rewrite of `~/.naary/config.json`.
 */
export const CLI_ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The SPA route a human opens to approve a CLI login. Server-derived base (never a request
 * parameter — see `appBaseUrl`), so this can't be pointed at an attacker's page.
 */
export const CLI_VERIFICATION_PATH = "/app/cli-login";

/**
 * ONE opaque failure for the exchange, whatever actually went wrong.
 *
 * #1078's single-use requirement is only real if a SPENT code is indistinguishable from a bogus
 * one: any difference (a distinct code, a different message, an extra field) tells someone holding
 * a leaked device code whether it was ever valid, and therefore whether racing the legitimate CLI
 * for it is worth trying. Unknown, expired and already-redeemed all render EXACTLY this body.
 */
const INVALID_GRANT = {
  statusCode: 400,
  error: "invalid_grant",
  message: "That login request is invalid or has expired. Start a new one.",
} as const;

/**
 * ONE opaque failure for refresh, same reasoning. Slice 2 distinguishes six reasons internally
 * (`unknown`/`revoked`/`expired`/`idle_expired`/`reused`/`conflict`) precisely so the SERVER can
 * log and alert on them — its doc says the caller "reports ONE opaque failure to the client
 * regardless", and this is that caller. A client that could tell `reused` from `unknown` would
 * learn that a token it holds is real and was recently rotated.
 */
const INVALID_REFRESH = {
  statusCode: 401,
  error: "invalid_grant",
  message: "That refresh token is no longer valid. Sign in again.",
} as const;

/**
 * `naary auth` — the browser-login handshake (design #1078 §2 shape B, slice 3).
 *
 * The flow, and where each security property lives:
 *
 *   1. `POST /auth/cli/start` — @Public (the CLI has no credential yet). Returns a device code (the
 *      CLI's secret) + a short user code (the human's). Rate-limited because an anonymous caller
 *      can otherwise create rows without bound.
 *   2. `POST /auth/cli/approve` — AUTHENTICATED, and the ONLY place an identity enters the flow.
 *      The tenant/user come from `req.principal`, which the global AuthGuard resolved from a
 *      Firebase/SSO session — never from the body. Owner/admin only, matching TokensController:
 *      minting an `nry_` token is already an owner/admin capability and this mints one.
 *   3. `POST /auth/cli/exchange` — @Public, polled. Redeems the device code EXACTLY once
 *      (compare-and-set in `CliAuthRequestService.claim`) for a 12h access token + a refresh token.
 *   4. `POST /auth/cli/refresh` — @Public, drives slice 2's rotation state machine.
 *
 * Why 2 and 4 are @Public: the presented token IS the credential, exactly as §5 says ("both are
 * unauthenticated by design"), which is also why §5 requires them rate-limited — done per-route
 * below, on top of the global per-client-IP limiter.
 *
 * There is no `state` parameter and no constant-time compare because there is no loopback hop: in
 * shape B the DEVICE CODE plays the `state` role (32 random bytes, held only by the CLI process
 * that started the flow, never rendered in a browser or a URL), and it is verified by a sha256
 * lookup on a unique index — the same discipline as `ApiTokenService.verify()`, with no
 * secret-vs-secret string comparison anywhere to be timing-sensitive.
 */
@ApiTags("cli-auth")
@Controller("auth/cli")
export class CliAuthController {
  private readonly logger = new Logger(CliAuthController.name);

  constructor(
    private readonly requests: CliAuthRequestService,
    private readonly tokens: ApiTokenService,
    private readonly refreshTokens: CliRefreshTokenService,
  ) {}

  /**
   * Open a handshake. Anonymous by necessity.
   *
   * The throttle here bounds ROW CREATION, not credential guessing — there is nothing to guess yet.
   * Without it an unauthenticated caller can fill CliAuthRequest at will.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiEndpoint({
    summary: "Begin a CLI browser login (device-code handshake).",
    created: CliAuthStartResponse,
  })
  @Post("start")
  async start(@Body() body: CliAuthStartDto): Promise<CliAuthStartResponse> {
    const started = await this.requests.start(body?.hostname);
    return {
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri: `${appBaseUrl()}${CLI_VERIFICATION_PATH}`,
      // Time REMAINING, derived from the stored expiry rather than the constant, so the client is
      // told what the server will actually enforce. Rounded, not floored: the row is created a
      // fraction of a millisecond before this line, and "599" for a ten-minute window reads as a
      // bug to whoever sees it in a CLI.
      expiresIn: Math.max(
        0,
        Math.round((started.expiresAt.getTime() - Date.now()) / 1000),
      ),
      interval: CLI_AUTH_POLL_INTERVAL_SECONDS,
    };
  }

  /**
   * Approve a pending login as the signed-in user. This is the identity binding, and the only
   * cross-user boundary in the flow: whatever this call writes is what the exchange will mint, so
   * the tenant and user are taken from the guard-resolved principal and nothing else.
   */
  @ApiEndpoint({
    summary: "Approve a pending CLI login as the signed-in user.",
    ok: CliAuthDecisionResponse,
  })
  @HttpCode(200)
  @Post("approve")
  async approve(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CliAuthDecisionDto,
  ): Promise<CliAuthDecisionResponse> {
    this.assertMayApprove(principal);
    const result = await this.requests.approve(
      body.userCode,
      principal.tenantId,
      // Narrowed by assertMayApprove.
      principal.userId as string,
    );
    if (!result.ok) throw decisionError(result.reason);
    return { status: "approved", label: result.label };
  }

  /**
   * "That wasn't me." The anti-phishing exit: a user who is shown a code they did not generate can
   * kill it instead of leaving it live for whoever is waiting on the other end.
   *
   * Same authentication as approve — a denial is a decision on the same row, and leaving it
   * anonymous would let anyone who learns a user code cancel someone else's login.
   */
  @ApiEndpoint({
    summary: "Refuse a pending CLI login.",
    ok: CliAuthDecisionResponse,
  })
  @HttpCode(200)
  @Post("deny")
  async deny(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CliAuthDecisionDto,
  ): Promise<CliAuthDecisionResponse> {
    this.assertMayApprove(principal);
    const result = await this.requests.deny(body.userCode);
    if (!result.ok) throw decisionError(result.reason);
    return { status: "denied", label: result.label };
  }

  /**
   * Poll for the outcome and, exactly once, receive the tokens.
   *
   * The limit is deliberately above the poll rate (12/min at the advertised 5s interval) and well
   * below anything useful for guessing a 32-byte code.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiEndpoint({
    summary: "Poll a CLI login and redeem it for tokens (single use).",
    ok: CliAuthExchangeResponse,
  })
  @HttpCode(200)
  @Post("exchange")
  async exchange(
    @Body() body: CliAuthExchangeDto,
  ): Promise<CliAuthExchangeResponse> {
    const claim = await this.requests.claim(body.deviceCode);
    if (claim.status === "invalid")
      throw new BadRequestException(INVALID_GRANT);
    if (claim.status === "pending") return { status: "pending" };
    if (claim.status === "denied") return { status: "denied" };

    // Approved AND claimed by this call — `claim()` won the compare-and-set, so this branch runs at
    // most once per device code no matter how many callers race it.
    const access = await this.mintAccessToken(
      claim.tenantId,
      claim.label,
      new Date(),
    );
    const refresh = await this.refreshTokens.issue(
      claim.tenantId,
      claim.userId,
    );
    return {
      status: "authorized",
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: refresh.refreshToken,
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
      tenantId: claim.tenantId,
    };
  }

  /**
   * Trade a refresh token for a new access token + its successor refresh token.
   *
   * All the interesting behaviour (single-use rotation, the 60s grace window, family revocation on
   * reuse) is slice 2's `CliRefreshTokenService.rotate`. This route's own job is to hand it the
   * presented token and render exactly one failure for every way it can say no.
   *
   * KNOWN GAP, tracked separately — it is a revocation surface, not a hole in this handshake:
   * rotation re-checks the TOKEN but not the MEMBERSHIP, so a user removed from the workspace (or
   * demoted from owner) keeps rotating until the family's 90-day cap. That is weaker than
   * `members.service.ts`'s "revocation is immediate", because a CliRefreshToken is keyed to a
   * userId and outlives the Membership row. §5 already schedules the fix — "Settings should list
   * CLI sessions… with a revoke that kills the family" — and `revokeFamily` exists and is unused
   * outside reuse detection, waiting for exactly that caller. Not closed here because the right
   * fix is member-removal calling `revokeFamily`, which belongs with the surface that shows the
   * sessions, and because a membership re-check on this path would also have to answer for the
   * legacy claim-tenant owners `AuthGuard` still backfills.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiEndpoint({
    summary: "Rotate a CLI refresh token into a fresh access token.",
    ok: CliAuthExchangeResponse,
  })
  @HttpCode(200)
  @Post("refresh")
  async refresh(
    @Body() body: CliAuthRefreshDto,
  ): Promise<CliAuthExchangeResponse> {
    const rotated = await this.refreshTokens.rotate(body.refreshToken);
    if (!rotated.ok) {
      // Server-side only — the reason never reaches the client. `reused` in particular is an
      // incident signal (slice 2 has already revoked the family by the time we see it).
      this.logger.warn(`CLI refresh refused: ${rotated.reason}`);
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    const now = new Date();
    const access = await this.mintAccessToken(
      rotated.tenantId,
      // The original device label is not carried on the refresh row, so a refreshed session shows
      // as a CLI session without the hostname rather than borrowing another device's name. It
      // still starts with CLI_TOKEN_LABEL_STEM, which is what the expired-token sweep matches —
      // and these are exactly the rows that would otherwise pile up, two per day per session.
      `${CLI_TOKEN_LABEL_STEM} session`,
      now,
    );
    return {
      status: "authorized",
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: rotated.refreshToken,
      refreshTokenExpiresAt: rotated.expiresAt.toISOString(),
      tenantId: rotated.tenantId,
    };
  }

  /** Mint the short-lived `nry_` access token, then sweep the tenant's DEAD CLI tokens.
   *
   *  The sweep matters because refresh mints a new row every 12 hours: without it a 90-day family
   *  leaves ~180 expired rows in the workspace's token list, and §5's "a token indistinguishable
   *  from four others is a token nobody revoke[s]" stops being true. Only rows that are ALREADY
   *  expired are removed — they authenticate nothing (`verify()` returns null for them), so
   *  deleting them loses no capability. Best-effort: a failed sweep must never fail a login. */
  private async mintAccessToken(
    tenantId: string,
    label: string,
    now: Date,
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(now.getTime() + CLI_ACCESS_TOKEN_TTL_MS);
    const minted = await this.tokens.mint(tenantId, label, expiresAt);
    await this.tokens
      .pruneExpiredCliTokens(tenantId, now)
      .catch((err) =>
        this.logger.warn(
          `CLI token sweep failed for tenant=${tenantId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    return { token: minted.token, expiresAt };
  }

  /**
   * Who may authorize a CLI login.
   *
   * Identical to `TokensController.create`, and for the same reason: this MINTS an `nry_` token,
   * which AuthGuard stamps `role: "owner"` for its workspace. So it must not be reachable by
   * anyone who could not mint one directly — a plain member would escalate, and an `nry_` token
   * (no `userId`) would let a token mint another token, i.e. self-replication.
   */
  private assertMayApprove(principal: Principal): void {
    if (!principal.userId) {
      throw new ForbiddenException(
        "Approving a CLI login requires a signed-in user account.",
      );
    }
    if (principal.role !== "owner" && principal.role !== "admin") {
      throw new ForbiddenException(
        "Only a workspace owner or admin can approve a CLI login.",
      );
    }
  }
}

/** Map a decision failure to an HTTP error. These are shown to a SIGNED-IN human who is looking at
 *  the code in their own terminal, so they are specific on purpose — unlike the exchange's opaque
 *  failure, none of them tells an anonymous caller anything about a credential.
 *
 *  `reason` is the machine-readable twin of `message`, added for the SPA approve page: expired,
 *  already-used and unknown are three DIFFERENT things a human must be told apart ("something went
 *  wrong" on a security screen is the worst possible copy), and branching a UI on English prose
 *  breaks the first time the prose is edited. It discloses nothing the message doesn't already —
 *  which is only safe because this route is authenticated and owner/admin-gated; the ANONYMOUS
 *  exchange above must keep its single opaque failure, and deliberately has no `reason`. */
function decisionError(
  reason: "unknown" | "expired" | "already_decided",
): BadRequestException {
  const message =
    reason === "expired"
      ? "That login request has expired. Run the command again."
      : reason === "already_decided"
        ? "That login request has already been dealt with."
        : "No pending login request with that code.";
  return new BadRequestException({
    statusCode: 400,
    error: "cli_login_unavailable",
    reason,
    message,
  });
}
