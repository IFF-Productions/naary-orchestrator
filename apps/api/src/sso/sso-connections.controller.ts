import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { getPrisma } from "@naary/db";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { UpsertSsoConnectionDto } from "./sso-connection.dto";

/**
 * The tenant → IdP mapping (design SAML-SSO.md, #455 AC "tenant maps IdP"). Owner/admin only —
 * whoever controls this row controls who can sign into the workspace, which is a higher bar
 * than ordinary membership.
 *
 * Everything in the row is non-secret (an IdP's entity id, SSO URL and PUBLIC signing cert),
 * so reads echo it back in full — there is deliberately no write-only field here, unlike the
 * credential/secret endpoints.
 */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/sso")
export class SsoConnectionsController {
  /** Same bar as API-token management (tokens.controller.ts): owner or admin. */
  private assertAdmin(principal: Principal | undefined): void {
    if (!principal?.userId) {
      throw new ForbiddenException(
        "SSO configuration requires a signed-in user (not an API token).",
      );
    }
    if (principal.role !== "owner" && principal.role !== "admin") {
      throw new ForbiddenException(
        "Only an owner or admin can configure SSO for this workspace.",
      );
    }
  }

  @ApiEndpoint({
    summary: "List the workspace's SAML connections",
    description: "Non-secret IdP metadata (entity id, SSO URL, public cert).",
  })
  @Get()
  async list(
    @Param("id") tenantId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    this.assertAdmin(principal);
    return getPrisma().ssoConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });
  }

  @ApiEndpoint({
    summary: "Create or replace a SAML connection",
    description:
      "Keyed by the IdP entity id, which is unique across the instance — an entity id already mapped to ANOTHER workspace is rejected (409-style), because that uniqueness is what makes an anonymous ACS POST unambiguous.",
    conflict: true,
  })
  @Put()
  async upsert(
    @Param("id") tenantId: string,
    @Body() body: UpsertSsoConnectionDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    this.assertAdmin(principal);

    const domains = body.allowedEmailDomains
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter((d) => d.length > 0);
    if (domains.length === 0) {
      // The AC of the cross-tenant invariant: no domain list ⇒ no connection.
      throw new BadRequestException(
        "allowedEmailDomains must contain at least one domain.",
      );
    }

    const prisma = getPrisma();
    // An entity id (and a slug) already owned by a DIFFERENT workspace must not be stolen:
    // it would redirect that tenant's federated logins into this one.
    for (const clash of [
      await prisma.ssoConnection.findUnique({
        where: { idpEntityId: body.idpEntityId },
      }),
      await prisma.ssoConnection.findUnique({ where: { slug: body.slug } }),
    ]) {
      if (clash && clash.tenantId !== tenantId) {
        throw new ForbiddenException(
          "That IdP entity id or slug is already registered by another workspace.",
        );
      }
    }

    const data = {
      tenantId,
      slug: body.slug,
      label: body.label,
      idpEntityId: body.idpEntityId,
      idpSsoUrl: body.idpSsoUrl,
      idpCertPem: body.idpCertPem,
      allowedEmailDomains: domains,
      defaultRole: body.defaultRole ?? "member",
      autoProvision: body.autoProvision ?? true,
      enabled: body.enabled ?? true,
    };
    return prisma.ssoConnection.upsert({
      where: { idpEntityId: body.idpEntityId },
      create: data,
      update: data,
    });
  }

  @ApiEndpoint({
    summary: "Delete a SAML connection",
    description:
      "Federated users keep their Membership; they can no longer sign in via SSO.",
    notFound: true,
  })
  @Delete(":connectionId")
  async remove(
    @Param("id") tenantId: string,
    @Param("connectionId") connectionId: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ deleted: number }> {
    this.assertAdmin(principal);
    // Tenant-scoped deleteMany (not delete by id): a foreign id must be a no-op, never a
    // cross-tenant delete.
    const res = await getPrisma().ssoConnection.deleteMany({
      where: { id: connectionId, tenantId },
    });
    return { deleted: res.count };
  }
}
