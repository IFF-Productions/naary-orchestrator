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
  CliAuthLogoutDto,
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
    //
    // THE REFRESH FAMILY IS CREATED FIRST, and the order is load-bearing rather than incidental:
    // the family id is what the access token is stamped with, so it has to exist before the token
    // does. It also moves the partial-failure leak in the safer direction. Before, a throw between
    // the two left a live 12h BEARER nobody was holding; now it leaves a live FAMILY nobody is
    // holding — which shows up as a phantom row in Settings (mildly confusing, revocable by the
    // user, and unable to authenticate anything, because the exchange is single-use and the CLI
    // never received the refresh token). A transaction would be the tidier answer and is not worth
    // spanning two services for a case that requires the database to fail mid-handshake.
    //
    // The device label rides along onto the refresh family, which is what Settings groups and names
    // its session rows by (#1078 §5) — a session with no device hint is one nobody revokes.
    const refresh = await this.refreshTokens.issue(
      claim.tenantId,
      claim.userId,
      new Date(),
      claim.label,
    );
    const access = await this.mintAccessToken(
      claim.tenantId,
      claim.label,
      new Date(),
      // The uid of the human who approved this login in a browser (`CliAuthRequestService.claim`
      // types it non-nullable on the approved branch, and `approve` only ever writes it from a
      // guard-resolved principal). Stamping it here is what makes the minted token revocable by
      // `MembersService` — see ApiTokenService.revokeUserCliTokens.
      claim.userId,
      // ...and the session it belongs to, which is what makes it revocable by the device's own
      // "Sign out" button — see ApiTokenService.revokeSessionTokens.
      refresh.familyId,
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
   * MEMBERSHIP IS STILL NOT RE-CHECKED HERE, and that is now a deliberate division of labour
   * rather than the gap #1117 described. Offboarding PUSHES: `MembersService.removeMember` and a
   * demotion in `changeRole` call `CliRefreshTokenService.revokeUserSessions`, which kills the
   * user's families for that workspace — so the row this route reads is already `revokedAt` and
   * the first branch in `rotate` refuses it. Keeping the check on the write side is what lets
   * this route stay ignorant of `Membership`, which matters because the legacy claim-tenant
   * owners `AuthGuard` still backfills lazily (auth.guard.ts) can have NO Membership row at the
   * instant they refresh; a fail-closed read here would lock exactly them out of the CLI.
   *
   * THE ACCESS TOKEN IS NOW REVOKED TOO. That was the first of the two residuals this comment
   * used to list, and it is closed: `ApiToken.userId` is the nullable owner column #1118 spelled
   * out, stamped by BOTH token-minting paths — the exchange above and `mintAccessToken` below, so
   * a refreshed session does not launder an owned token into an unowned one — and read by
   * `ApiTokenService.revokeUserCliTokens`, which `MembersService` calls alongside
   * `revokeUserSessions`. A removed member's live `nry_` token is deleted, not merely starved of
   * successors, so `verify()` 401s it on the next request instead of at the 12h mark.
   *
   * It is NOT surfaced as identity: `verify()` deliberately does not return `userId`, because a
   * principal carrying one would satisfy `assertMayApprove` and let a CLI token approve a login
   * that mints another CLI token. The column revokes; it never authorizes.
   *
   * `familyId` is the second such column, stamped by the same two paths under the same discipline,
   * and it answers the question `userId` cannot: WHICH of a person's devices this token is. It is
   * what lets Settings' "Sign out this device" recall the token that device holds
   * (`ApiTokenService.revokeSessionTokens`) instead of promising a sign-out 12 hours from now. It
   * is likewise absent from `verify()`.
   *
   * REUSE DETECTION NOW KILLS BOTH HALVES TOO, and that residual is closed. It used to revoke a
   * leaked family and leave the access token that family had already minted authenticating for up
   * to 12 hours — the one branch in the whole flow that fires on positive evidence of THEFT rather
   * than on a policy decision, and therefore the one where 12 hours is least affordable.
   * `CliRefreshTokenService` now takes `ApiTokenService` as a REQUIRED constructor dependency and
   * calls `revokeSessionTokens` from `afterRotation`. Required, not optional-and-skipped: a
   * revocation that silently no-ops when its collaborator is missing would test green in exactly
   * the specs that appear to cover it.
   *
   * ONE RESIDUAL, bounded and not a rotation problem: a user offboarded by a path that does not
   * delete a Membership. There is none today — `removeMember` is the only `membership.deleteMany`
   * in the codebase, and SCIM de-provisioning routes through it.
   *
   * #1078 §5's Settings surface ("list CLI sessions… with a revoke that kills the family") now
   * exists as `CliSessionsController`, and slice 4's `naary logout` is still outstanding — both are
   * callers of the same `revokeFamily`/`revokeUserSessions` pair, not new mechanism.
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
      // The family's OWN device label (#1078 §5 put it on the refresh row), so a refreshed session
      // keeps the name of the machine that logged in instead of degrading to an anonymous row on
      // its first refresh. A family minted before that column existed has none and falls back —
      // never to another device's name. Either way it starts with CLI_TOKEN_LABEL_STEM, which is
      // what the expired-token sweep matches; these are exactly the rows that would otherwise pile
      // up, two per day per session.
      rotated.label ?? `${CLI_TOKEN_LABEL_STEM} session`,
      now,
      // The owner IS carried on the refresh row (a family never spans users), so a refreshed
      // session stays as revocable as the one the exchange minted. Without this the very first
      // refresh would launder an owned token into an unowned one.
      rotated.userId,
      // Same discipline, same lesson, for the SESSION: rotation stays inside one family
      // (`mintSuccessor` copies `familyId` unchanged), so the token a day-old session is holding
      // must carry it too. Without this line, "Sign out this device" would work on a session that
      // had never refreshed and silently stop working on every session that had — the worst
      // possible shape for a security control, because it would test green.
      rotated.familyId,
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

  /**
   * End a CLI session (#1078 slice 4 — "`naary logout` (revokes the family)").
   *
   * Revokes the rotation family the presented refresh token belongs to AND deletes the presented
   * access token, because a logout that leaves a live 12-hour bearer behind is only a logout
   * tomorrow. Both are the caller's own credentials, which is what makes an unauthenticated route
   * safe here: the token IS the authorization, exactly as on exchange and refresh.
   *
   * `accessToken` IS OPTIONAL AND NO LONGER LOAD-BEARING. `revokeByToken` recalls the whole
   * family's access tokens from the refresh row's own `tenantId`/`familyId`, so a caller that
   * sends only its refresh token is signed out just as completely — the shape a `curl`, an older
   * `naary`, or a config whose access token had already rotated away would take. The by-hash
   * delete below stays because it is the ONLY thing that reaches a token minted before
   * `ApiToken.familyId` existed, or one whose family the caller cannot name.
   *
   * ALWAYS 204, whatever was found. An unknown token, a spent token and a real one are one answer
   * on purpose — the same discipline the exchange's single `invalid_grant` follows. A "revoked 1
   * family" vs "revoked 0" distinction would tell an anonymous caller that a token it holds is
   * live, which is the one bit this flow spends most of its effort not disclosing. It also makes
   * the route idempotent, so a CLI that retries after a network blip is not an error case.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiEndpoint({
    summary:
      "End a CLI session: revoke the refresh family and the access token.",
  })
  @HttpCode(204)
  @Post("logout")
  async logout(@Body() body: CliAuthLogoutDto): Promise<void> {
    if (body.refreshToken) {
      const killed = await this.refreshTokens.revokeByToken(body.refreshToken);
      // No token material, and no family id for a token that matched nothing.
      this.logger.log(`CLI logout: revoked ${killed} refresh token(s)`);
    }
    if (body.accessToken) await this.tokens.revokeByToken(body.accessToken);
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
    /** The uid this session belongs to. REQUIRED here (unlike on `mint`, where it is optional so
     *  Settings/CI tokens stay unowned): every token this method produces is a person's CLI
     *  session, and one minted without an owner is one member removal cannot revoke. */
    userId: string,
    /** The rotation family this session IS. REQUIRED here for the same reason: every token this
     *  method produces belongs to exactly one session, and one minted without a family is one
     *  "Sign out this device" cannot recall. */
    familyId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(now.getTime() + CLI_ACCESS_TOKEN_TTL_MS);
    const minted = await this.tokens.mint(
      tenantId,
      label,
      expiresAt,
      userId,
      familyId,
    );
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
