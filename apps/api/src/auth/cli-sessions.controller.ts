import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { ApiEndpoint } from "../swagger/api-decorators";
import { ApiTokenService } from "./api-token.service";
import { CliRefreshTokenService } from "./cli-refresh-token.service";
import { CurrentPrincipal, type Principal } from "./tenant.decorator";

/** One CLI session (a rotation FAMILY) as Settings renders it. Carries no credential material —
 *  `familyId` is a random opaque handle, and the token hashes are never read out of the table. */
export class CliSessionView {
  @ApiProperty({
    description:
      "Opaque handle for the rotation family. The id DELETE takes; not a credential.",
  })
  familyId!: string;

  @ApiProperty({
    // Explicit `type` because Nest cannot infer one from `string | null` and would emit an
    // untyped object — the openapi-nullable-types drift guard fails on exactly that.
    type: String,
    nullable: true,
    example: "naary CLI — hassans-macbook",
    description:
      "Device hint from the login handshake, or null for a session created before labels existed.",
  })
  label!: string | null;

  @ApiProperty({
    description:
      "ISO time the human signed in (the FIRST token of the family).",
  })
  createdAt!: string;

  @ApiProperty({
    description:
      "ISO time of the newest activity in the family — in practice its last token refresh.",
  })
  lastUsedAt!: string;

  @ApiProperty({
    description:
      "ISO 90-day absolute expiry. The session dies here regardless of use.",
  })
  expiresAt!: string;
}

export class CliSessionRevokedResponse {
  @ApiProperty({ example: true })
  revoked!: boolean;
}

/**
 * "Which machines am I signed in on?" — #1078 §5's Settings surface.
 *
 * ## Own sessions only, deliberately
 *
 * Everything here is scoped by `(tenantId, userId)` taken from the guard-resolved principal, so a
 * caller sees and can revoke exactly their own sessions in their active workspace. There is no
 * admin view of another member's devices, and that is a decision rather than an omission: #1078 §5
 * asks only for "a revoke that kills the refresh family" and does not settle the offboarding-vs-
 * privacy question, so this takes the conservative branch. It costs an admin nothing, because the
 * offboarding capability already exists by a different route — `MembersService` calls
 * `CliRefreshTokenService.revokeUserSessions` on removal AND on demotion (#1117), which kills a
 * departing member's families without anyone browsing their device list.
 *
 * ## Why not on MeController
 *
 * `MeController` is `@UserScoped()`, which tells AuthGuard to SKIP the active-workspace membership
 * check — necessary for `/me` (a user with no workspace must still reach it), and exactly wrong
 * here: a tenant-less principal would reach a query on `("", userId)`. These routes are ordinary
 * workspace-scoped routes and fail closed.
 *
 * ## Why `principal.userId` is checked before anything else
 *
 * An `nry_` API token authenticates with NO `userId`, and AuthGuard stamps it `role: "owner"` in an
 * unenforced workspace — so a role check alone would let a token enumerate and revoke the sessions
 * of every human in the workspace. The identity, not the role, is the gate; same order as
 * `CliAuthController.assertMayApprove`.
 */
@ApiTags("cli-sessions")
@ApiBearerAuth("bearer")
@Controller("cli-sessions")
export class CliSessionsController {
  private readonly logger = new Logger(CliSessionsController.name);

  constructor(
    private readonly refreshTokens: CliRefreshTokenService,
    /** Appended, so every positional construction in the tests keeps working. Both halves of a
     *  sign-out live in different tables, and this controller composes them — the same shape
     *  `MembersService` uses for offboarding, rather than teaching either service about the other. */
    private readonly apiTokens: ApiTokenService,
  ) {}

  /** This user's ACTIVE CLI sessions in this workspace, newest activity first. */
  @ApiEndpoint({
    summary: "List my active CLI sessions",
    ok: [CliSessionView],
  })
  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<CliSessionView[]> {
    const userId = this.requireUser(principal);
    const sessions = await this.refreshTokens.listUserSessions(
      principal.tenantId,
      userId,
    );
    return sessions.map((s) => ({
      familyId: s.familyId,
      label: s.label,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    }));
  }

  /**
   * Sign one device out: revoke the whole rotation family AND delete the access token that device
   * is holding.
   *
   * `revokeUserFamily` re-reads ownership under the SAME `(tenantId, userId)` filter before it
   * touches anything — the path parameter is a claim, not a permission. Somebody else's family, an
   * already-revoked one and a made-up one are all the same 404, so this is not an oracle for
   * whether a family id is real.
   *
   * ORDER IS DELIBERATE, and it is the ownership check that puts it there: nothing may be deleted
   * before `revokeUserFamily` has said this family is the caller's own, so the token delete runs
   * only on `true`. `tenantId` comes from the principal on both calls, never from the request.
   *
   * WHY THE SECOND CALL EXISTS AT ALL: revoking the family stops the device minting anything new,
   * but the 12-hour `nry_` token in its `~/.naary/config.json` authenticated every REST, /api/v1 and
   * MCP request until it expired. `ApiToken.familyId` is what makes that token findable, so a
   * sign-out is a sign-out now rather than by tomorrow. The token a session minted BEFORE that
   * column existed carries no family and is not recalled — bounded by its own ≤12h expiry, and
   * unable to renew itself because the family it belongs to is now dead.
   *
   * IT DOES NOT FAIL THE REQUEST. The family is already revoked by the time this runs, so a throw
   * here would 500 a sign-out that has mostly succeeded and send the user to retry — where the
   * spent family answers 404 and reads as "revocation failed". Reporting success with the residual
   * logged is the same posture `MembersService` takes on the same pair of calls, and it degrades to
   * exactly the pre-#1078-§5 behaviour: the device stops refreshing, and its token dies at 12h.
   */
  @ApiEndpoint({
    summary: "Revoke one of my CLI sessions",
    ok: CliSessionRevokedResponse,
    notFound: true,
  })
  @Delete(":familyId")
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param("familyId") familyId: string,
  ): Promise<CliSessionRevokedResponse> {
    const userId = this.requireUser(principal);
    const ok = await this.refreshTokens.revokeUserFamily(
      principal.tenantId,
      userId,
      familyId,
    );
    if (!ok) throw new NotFoundException("CLI session not found");
    await this.apiTokens
      .revokeSessionTokens(principal.tenantId, familyId)
      .catch((err) =>
        // No token material — the family id is a random opaque handle, and the message is ours.
        this.logger.warn(
          `CLI session ${familyId}: refresh family revoked but its access token(s) were not deleted: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    return { revoked: true };
  }

  /** A CLI session belongs to a HUMAN. A principal without one (an `nry_` API token) has no
   *  sessions of its own and must not act on anyone else's. */
  private requireUser(principal: Principal): string {
    if (!principal.userId) {
      throw new ForbiddenException(
        "CLI sessions belong to a signed-in user account, not an API token.",
      );
    }
    return principal.userId;
  }
}
