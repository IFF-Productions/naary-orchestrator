import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { UserScoped } from "../auth/user-scoped.decorator";
import { AcceptInvitationDto, CreateInvitationDto } from "./invitation.dto";
import {
  type CreatedInvitation,
  type InvitationView,
  InvitationsService,
} from "./invitations.service";

/**
 * Manage a workspace's pending invites (design §7) — admin+ (RolesGuard, controller-scoped
 * so it runs after the global AuthGuard). tenantId comes from the path; AuthGuard has
 * already verified the caller is a member of it, RolesGuard that they're admin+.
 */
@Controller("tenants/:id/invitations")
@UseGuards(RolesGuard)
@Roles("admin")
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /** Create an invite → returns the raw token ONCE (store only its hash). */
  @Post()
  @HttpCode(201)
  create(
    @Param("id") tenantId: string,
    @Body() body: CreateInvitationDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreatedInvitation> {
    return this.invitations.create(
      tenantId,
      body.email,
      body.role ?? "member",
      principal.role,
      principal.userId ?? "api-token",
    );
  }

  @Get()
  list(@Param("id") tenantId: string): Promise<InvitationView[]> {
    return this.invitations.list(tenantId);
  }

  @Delete(":iid")
  @HttpCode(204)
  async revoke(
    @Param("id") tenantId: string,
    @Param("iid") id: string,
  ): Promise<void> {
    await this.invitations.revoke(tenantId, id);
  }
}

/**
 * Accept an invite (design Path B). NOT tenant-scoped — the token identifies the workspace,
 * and the accepter may have no membership there yet, so it's `@UserScoped()` (auth'd user,
 * no workspace check). The token rides in the BODY, never the URL, so it can't leak into
 * request logs / the audit path before it's consumed.
 */
@Controller("invitations")
export class AcceptInvitationController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post("accept")
  @UserScoped()
  async accept(
    @Body() body: AcceptInvitationDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ tenantId: string; role: string }> {
    if (!principal.userId) {
      throw new ForbiddenException(
        "Accepting an invitation requires a signed-in user account.",
      );
    }
    return this.invitations.accept(
      body.token,
      principal.userId,
      principal.email,
      principal.emailVerified ?? false,
    );
  }
}
