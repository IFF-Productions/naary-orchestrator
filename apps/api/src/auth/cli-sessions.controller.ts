import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { ApiEndpoint } from "../swagger/api-decorators";
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
  constructor(private readonly refreshTokens: CliRefreshTokenService) {}

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
   * Sign one device out: revoke the whole rotation family.
   *
   * `revokeUserFamily` re-reads ownership under the SAME `(tenantId, userId)` filter before it
   * touches anything — the path parameter is a claim, not a permission. Somebody else's family, an
   * already-revoked one and a made-up one are all the same 404, so this is not an oracle for
   * whether a family id is real.
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
