import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { ScimProvisioningService } from "./scim-provisioning.service";
import {
  ScimConnectionCtx,
  ScimTenant,
  ScimGuard,
  type ScimWriteContext,
} from "./scim.guard";
import { ScimUsersService } from "./scim-users.service";
import type { ScimListResponse, ScimUser } from "./scim-user.response";

/** RFC 7643 §5 — what an IdP reads before it decides how to talk to us. Advertising a
 *  capability we do not have is worse than advertising none: an IdP that believes we support
 *  PATCH will send one and log a 404 on every sync. Slice 1 supports NOTHING but reads, and
 *  says so. */
const SERVICE_PROVIDER_CONFIG = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: "https://github.com/IFF-Productions/naary-orchestrator",
  /**
   * TRUE SINCE #1115, and flipping this is a CONTRACT CHANGE, not a config tweak: an IdP reads
   * `ServiceProviderConfig` to decide what to send, so from here on Okta and Entra WILL send
   * `PATCH` on a leaver instead of `DELETE`. It may only say `true` because
   * {@link ScimProvisioningService.setActive} exists and `Membership.active` is honoured by the
   * authorization path — the same reason it said `false` for two slices while it was not.
   *
   * What "supported" means here is narrow and the parser enforces it: `replace`/`add` of the
   * `active` attribute. Every other operation is a 400 rather than a silent no-op, because an
   * IdP that believes it renamed someone and did not is worse served than one that gets an
   * error it can map.
   */
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  // The one filter production we implement — see scim-filter.ts.
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "OAuth Bearer Token",
      description:
        "A per-connection bearer issued by a Naary operator (prefix nryscim_), scoped to exactly one workspace.",
      primary: true,
    },
  ],
} as const;

/**
 * SCIM 2.0 — reads (slice 1) + provisioning/de-provisioning (slice 2). #1075, design
 * LDAP-DIRECTORY.md §3.1.
 *
 * `@Public()` for the same reason the SAML ACS is: the caller is a machine presenting its own
 * credential, not a Naary user, so the global AuthGuard has nothing to do here. Authentication
 * happens in {@link ScimGuard}, which runs after it and attaches a tenant WITHOUT attaching a
 * principal.
 *
 * WHAT SLICE 2 ADDS: `POST /Users` (provision) and `DELETE /Users/{id}` (de-provision).
 * WHAT #1115 ADDS: `PATCH /Users/{id}` with `active` — the SOFT de-provision, the signal an IdP
 * actually sends on a leaver, and its reversal. Still no PUT, no /Groups, no /Schemas, no
 * /ResourceTypes.
 *
 * ── THE RULE SLICE 1 WROTE HERE, NOW HONOURED ───────────────────────────────────────────
 * The de-provision path MUST route through `MembersService.removeMember`. It is the only
 * removal path that deletes the `GroupMember` rows alongside the `Membership`, invalidates
 * BOTH the membership cache and the tenant's permission cache, reports `strandedApprovals`,
 * and writes the AuditEvent that its own docstring calls "the SCIM/no-human surface". A
 * hand-rolled `membership.deleteMany` here would silently lose all four — the removed user
 * would keep cached grants past their TTL, silently regain their old groups if re-added, and
 * strand a paused compliance gate with nobody able to decide it and no record that it
 * happened. That is not a refactor to do later; it is the contract of this feature.
 *
 * It has a twin that slice 1 did not name: a subject who never signed in has NO Membership,
 * only a pending Invitation, and de-provisioning must revoke that too via
 * `MembersService.revokeInvitation` — otherwise accept-on-login re-provisions them at their
 * next sign-in. Both live in {@link ScimProvisioningService.deprovision}; nothing in this
 * controller may take a shortcut past it.
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * Excluded from the OpenAPI document: SCIM is a published external standard with its own
 * schema, and emitting our own paraphrase of it into the SPA's generated client would invite
 * someone to call it from the browser with a user token.
 */
@ApiExcludeController()
@Public()
@UseGuards(ScimGuard)
@Controller("scim/v2")
export class ScimController {
  constructor(
    private readonly users: ScimUsersService,
    private readonly provisioning: ScimProvisioningService,
  ) {}

  /** Unauthenticated-looking but still guarded: an IdP sends its bearer here too, and gating
   *  it keeps our capability list from being a public fingerprint of the deployment. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("ServiceProviderConfig")
  serviceProviderConfig(): typeof SERVICE_PROVIDER_CONFIG {
    return SERVICE_PROVIDER_CONFIG;
  }

  /** The reconcile GET: Memberships AND pending Invitations, one namespace, `active` carrying
   *  the difference. Tenant comes from the token row — never from a query parameter. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("Users")
  list(
    @ScimTenant() tenantId: string,
    @Query("filter") filter?: string,
    @Query("startIndex") startIndex?: string,
    @Query("count") count?: string,
  ): Promise<ScimListResponse> {
    return this.users.list(tenantId, { filter, startIndex, count });
  }

  /** One resource by the id the IdP stored. 404 is identical for "absent" and "belongs to
   *  another workspace" — see ScimError.notFound. */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get("Users/:id")
  get(
    @ScimTenant() tenantId: string,
    @Param("id") id: string,
  ): Promise<ScimUser> {
    return this.users.get(tenantId, id);
  }

  /**
   * Provision a subject (RFC 7644 §3.3). Creates a pending Invitation — see
   * {@link ScimProvisioningService.provision} for why it cannot be a Membership.
   *
   * The `Location` header is set from the resource we just rendered rather than from anything
   * the payload said, so an IdP that follows it lands on this connection's own tenant-scoped
   * id and no other.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("Users")
  async create(
    @ScimConnectionCtx() ctx: ScimWriteContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ScimUser> {
    const user = await this.provisioning.provision(ctx, body);
    res.setHeader("Location", user.meta.location);
    return user;
  }

  /**
   * De-provision a subject (RFC 7644 §3.6). 204 on success, and a 204 here is a PROMISE that
   * the membership and any pending invitation are gone — {@link
   * ScimProvisioningService.deprovision} asserts that rather than trusting a return value.
   *
   * Rate-limited like the other write: a de-provisioning storm from a misconfigured IdP is the
   * failure mode this endpoint has, and the limit bounds how much of one lands per minute
   * without breaking a legitimate bulk sync.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Delete("Users/:id")
  @HttpCode(204)
  remove(
    @ScimConnectionCtx() ctx: ScimWriteContext,
    @Param("id") id: string,
  ): Promise<void> {
    return this.provisioning.deprovision(ctx, id);
  }

  /**
   * The SOFT de-provision (RFC 7644 §3.5.2), #1115: `active: false` deactivates the subject's
   * membership, `active: true` restores it — with their permission groups, which is the whole
   * reason this is a column rather than a delete. See
   * {@link ScimProvisioningService.setActive}; nothing here may take a shortcut past it, for
   * the same reason the DELETE route may not.
   *
   * 204 with no body, always — §3.5.2 permits it and a uniform status is what an IdP's error
   * handling can actually rely on.
   *
   * Rate-limited alongside the other writes: a mis-mapped "deactivate everyone not in this
   * group" rule is the failure mode this endpoint has, exactly as it is for DELETE.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Patch("Users/:id")
  @HttpCode(204)
  patch(
    @ScimConnectionCtx() ctx: ScimWriteContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<void> {
    return this.provisioning.setActive(ctx, id, body);
  }
}
