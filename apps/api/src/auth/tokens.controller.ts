import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { ApiTokenService } from "./api-token.service";
import { CurrentPrincipal, type Principal, TenantId } from "./tenant.decorator";

/**
 * Manage a workspace's `nry_` API tokens (for the MCP server + CLI/CI). Workspace-scoped: the
 * active workspace comes from the token/`X-Workspace-Id`, never the body. Minting is gated to a
 * signed-in USER who is an owner/admin — an `nry_` token can't mint another (no self-replication),
 * and a plain member can't escalate. Tokens are shown in PLAINTEXT exactly once (mint response);
 * only the sha256 is stored.
 */
@Controller("tokens")
export class TokensController {
  constructor(private readonly tokens: ApiTokenService) {}

  /** Metadata for the workspace's tokens (never the token value). */
  @Get()
  list(@TenantId() tenantId: string) {
    return this.tokens.list(tenantId);
  }

  /** Mint a new token — returns the plaintext ONCE. */
  @Post()
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: { label?: string },
  ) {
    if (!principal.userId) {
      throw new ForbiddenException(
        "Creating an API token requires a signed-in user account.",
      );
    }
    if (principal.role !== "owner" && principal.role !== "admin") {
      throw new ForbiddenException(
        "Only a workspace owner or admin can create API tokens.",
      );
    }
    const label = body?.label?.trim() || "MCP token";
    return this.tokens.mint(principal.tenantId, label);
  }

  /** Revoke a token by id (tenant-scoped). */
  @Delete(":id")
  async revoke(
    @TenantId() tenantId: string,
    @Param("id") id: string,
  ): Promise<{ revoked: true }> {
    const ok = await this.tokens.revoke(tenantId, id);
    if (!ok) throw new NotFoundException("Token not found");
    return { revoked: true };
  }
}
