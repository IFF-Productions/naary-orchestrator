import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import { ScimTenant, ScimGuard } from "./scim.guard";
import { ScimUsersService } from "./scim-users.service";
import type { ScimListResponse, ScimUser } from "./scim-user.response";

/** RFC 7643 §5 — what an IdP reads before it decides how to talk to us. Advertising a
 *  capability we do not have is worse than advertising none: an IdP that believes we support
 *  PATCH will send one and log a 404 on every sync. Slice 1 supports NOTHING but reads, and
 *  says so. */
const SERVICE_PROVIDER_CONFIG = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: "https://github.com/IFF-Productions/naary-orchestrator",
  patch: { supported: false },
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
 * SCIM 2.0 — READ ONLY (#1075 slice 1, design LDAP-DIRECTORY.md §3.1).
 *
 * `@Public()` for the same reason the SAML ACS is: the caller is a machine presenting its own
 * credential, not a Naary user, so the global AuthGuard has nothing to do here. Authentication
 * happens in {@link ScimGuard}, which runs after it and attaches a tenant WITHOUT attaching a
 * principal.
 *
 * DELIBERATELY NO WRITES IN THIS SLICE. No POST/PUT/PATCH/DELETE, no /Groups, no /Schemas,
 * no /ResourceTypes. This slice exists to prove the credential model and tenant scoping, and
 * a read-only surface means a misconfigured IdP pointed at it can do nothing but read its own
 * workspace — de-provisioning is destructive and arrives deliberately, in slice 2.
 *
 * ── FOR WHOEVER BUILDS SLICE 2, READ THIS BEFORE YOU WRITE A DELETE ─────────────────────
 * The de-provision path MUST route through `MembersService.removeMember`. It is the only
 * removal path that deletes the `GroupMember` rows alongside the `Membership`, invalidates
 * BOTH the membership cache and the tenant's permission cache, reports `strandedApprovals`,
 * and writes the AuditEvent that its own docstring calls "the SCIM/no-human surface". A
 * hand-rolled `membership.deleteMany` here would silently lose all four — the removed user
 * would keep cached grants past their TTL, silently regain their old groups if re-added, and
 * strand a paused compliance gate with nobody able to decide it and no record that it
 * happened. That is not a refactor to do later; it is the contract of this feature.
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
  constructor(private readonly users: ScimUsersService) {}

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
}
