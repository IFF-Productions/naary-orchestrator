import "reflect-metadata";
import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTokenService } from "../src/auth/api-token.service";
import { AuthGuard, parseRequireMfa } from "../src/auth/auth.guard";
import type { FirebaseVerifier } from "../src/auth/firebase-verifier";
import type { MembershipService } from "../src/membership/membership.service";
import type { PermissionsService } from "../src/permissions/permissions.service";
import { IS_USER_SCOPED_KEY } from "../src/auth/user-scoped.decorator";

const verify = vi.fn();
const firebaseVerify = vi.fn();
const listForUser = vi.fn();
const ensureMembership = vi.fn();
const acceptPendingInvitations = vi.fn();
const touchLastActive = vi.fn();
const isTenantEnforced = vi.fn();
const getAllAndOverride = vi.fn();
let firebaseEnabled = false;
/** Routes flagged user-scoped for a given test (keyed by metadata key). */
let userScoped = false;

function makeGuard(): AuthGuard {
  const firebase = {
    get enabled() {
      return firebaseEnabled;
    },
    verify: firebaseVerify,
  } as unknown as FirebaseVerifier;
  const memberships = {
    listForUser,
    ensureMembership,
    acceptPendingInvitations,
    touchLastActive,
  } as unknown as MembershipService;
  const permissions = {
    isTenantEnforced,
  } as unknown as PermissionsService;
  return new AuthGuard(
    { verify } as unknown as ApiTokenService,
    firebase,
    { getAllAndOverride } as unknown as Reflector,
    memberships,
    permissions,
  );
}

interface FakeReq {
  headers: Record<string, string | undefined>;
  params?: Record<string, string>;
  path?: string;
  principal?: unknown;
}

function ctx(req: FakeReq): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

beforeEach(() => {
  verify.mockReset();
  firebaseVerify.mockReset();
  listForUser.mockReset().mockResolvedValue([]);
  ensureMembership.mockReset().mockResolvedValue(undefined);
  acceptPendingInvitations.mockReset().mockResolvedValue(undefined);
  touchLastActive.mockReset().mockResolvedValue(undefined);
  isTenantEnforced.mockReset().mockResolvedValue(false);
  firebaseEnabled = false;
  userScoped = false;
  // Reflector: IS_PUBLIC_KEY → false, IS_USER_SCOPED_KEY → the per-test `userScoped`.
  getAllAndOverride
    .mockReset()
    .mockImplementation((key: string) =>
      key === IS_USER_SCOPED_KEY ? userScoped : false,
    );
});

describe("AuthGuard", () => {
  it("allows @Public() routes without a token", async () => {
    getAllAndOverride.mockReturnValue(true);
    const req: FakeReq = { headers: {} };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it("401s when the bearer token is missing", async () => {
    await expect(
      makeGuard().canActivate(ctx({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("401s when the API token is unknown", async () => {
    verify.mockResolvedValue(null);
    await expect(
      makeGuard().canActivate(
        ctx({ headers: { authorization: "Bearer nry_nope" } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("attaches the resolved tenant (owner) on a valid API token", async () => {
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: null });
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_good" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toEqual({ tenantId: "t-1", role: "owner" });
    expect(firebaseVerify).not.toHaveBeenCalled();
    expect(listForUser).not.toHaveBeenCalled();
  });

  it("401s a non-`nry_` token when Firebase is disabled (no service account)", async () => {
    const req: FakeReq = {
      headers: { authorization: "Bearer some.jwt.token" },
    };
    await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verify).not.toHaveBeenCalled();
    expect(firebaseVerify).not.toHaveBeenCalled();
  });

  it("401s when an enabled Firebase verifier rejects the token", async () => {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue(null);
    await expect(
      makeGuard().canActivate(
        ctx({ headers: { authorization: "Bearer bad.jwt" } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // --- API-token cross-tenant isolation (must stay green through the guard rewrite) ---

  it("403s when a /tenants/:id path tenant differs from the API token's tenant", async () => {
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: null });
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_good" },
      path: "/tenants/t-OTHER/credentials",
      params: { id: "t-OTHER" },
    };
    await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("allows a /tenants/:id path that matches the API token's tenant", async () => {
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: null });
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_good" },
      path: "/tenants/t-1/credentials",
      params: { id: "t-1" },
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
  });

  it("still 403s a cross-tenant path UNDER A GLOBAL PREFIX (no silent bypass)", async () => {
    // A prefix must not disable tenant isolation. Enforcement keys off the /tenants/
    // segment by pattern, not a path prefix, and doesn't rely on req.params.
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: null });
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_good" },
      path: "/api/tenants/t-OTHER/credentials",
      params: {},
    };
    await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("does NOT apply the tenant check to a non-tenant route (executions/:id is a workflowId)", async () => {
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: null });
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_good" },
      path: "/executions/wh-t-1-abc123",
      params: { id: "wh-t-1-abc123" },
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
  });

  it("403s an API token whose X-Workspace-Id names a different tenant", async () => {
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: null });
    const req: FakeReq = {
      headers: {
        authorization: "Bearer nry_good",
        "x-workspace-id": "t-OTHER",
      },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  // --- API token ↔ environment binding (design ENVIRONMENTS.md §3, Slice 4) ---

  it("an env-BOUND token stamps its own env as the principal's environmentSel", async () => {
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: "env-uat" });
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_bound" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toEqual({
      tenantId: "t-1",
      role: "owner",
      environmentSel: "env-uat",
    });
  });

  it("403s an env-BOUND token that ALSO sends X-Environment-Id (conflicting intent)", async () => {
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: "env-uat" });
    const req: FakeReq = {
      headers: {
        authorization: "Bearer nry_bound",
        "x-environment-id": "env-prod",
      },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("an UNBOUND token honours the caller's X-Environment-Id header", async () => {
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: null });
    const req: FakeReq = {
      headers: {
        authorization: "Bearer nry_unbound",
        "x-environment-id": "env-sandbox",
      },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toEqual({
      tenantId: "t-1",
      role: "owner",
      environmentSel: "env-sandbox",
    });
  });

  // --- API tokens under the first-grant cliff (RBAC-GROUPS.md §4a/§8.6, slice G1) ---

  it("stamps a token `member` + tokenId when the workspace HAS grants (restricted)", async () => {
    verify.mockResolvedValue({
      id: "tok-1",
      tenantId: "t-1",
      environmentId: null,
    });
    isTenantEnforced.mockResolvedValue(true);
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_restricted" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(isTenantEnforced).toHaveBeenCalledWith("t-1");
    expect(req.principal).toEqual({
      tenantId: "t-1",
      role: "member",
      tokenId: "tok-1",
    });
  });

  it("keeps today's `owner` stamp (NO tokenId) in a zero-grant workspace — migration neutrality", async () => {
    verify.mockResolvedValue({
      id: "tok-1",
      tenantId: "t-1",
      environmentId: null,
    });
    isTenantEnforced.mockResolvedValue(false);
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_free" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toEqual({ tenantId: "t-1", role: "owner" });
  });

  it("a restricted env-BOUND token keeps its env binding alongside the member stamp", async () => {
    verify.mockResolvedValue({
      id: "tok-1",
      tenantId: "t-1",
      environmentId: "env-uat",
    });
    isTenantEnforced.mockResolvedValue(true);
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_bound" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toEqual({
      tenantId: "t-1",
      role: "member",
      tokenId: "tok-1",
      environmentSel: "env-uat",
    });
  });

  // --- Firebase user → membership resolution ---

  it("resolves the active workspace + role from membership on a /tenants/:id path", async () => {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({
      userId: "u-1",
      email: "a@b.co",
      emailVerified: true,
    });
    listForUser.mockResolvedValue([{ tenantId: "t-1", role: "admin" }]);
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/tenants/t-1/credentials",
      params: { id: "t-1" },
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toEqual({
      tenantId: "t-1",
      userId: "u-1",
      subject: "u-1",
      email: "a@b.co",
      emailVerified: true,
      role: "admin",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("stamps last-active for a Firebase user with a resolved workspace (#489)", async () => {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({
      userId: "u-1",
      email: "a@b.co",
      emailVerified: true,
    });
    listForUser.mockResolvedValue([{ tenantId: "t-1", role: "admin" }]);
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/tenants/t-1/credentials",
      params: { id: "t-1" },
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    // Fire-and-forget, but the CALL is synchronous within canActivate — assert it ran with
    // (userId, activeTenant). This is the feature's behavioral contract, not just the mock.
    expect(touchLastActive).toHaveBeenCalledWith("u-1", "t-1");
  });

  it("does NOT stamp last-active for an `nry_` API token (services never touch the Team screen) (#489)", async () => {
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: null });
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_good" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(touchLastActive).not.toHaveBeenCalled();
  });

  it("does NOT stamp last-active when NO workspace resolves (user-scoped, tenant-less) (#489)", async () => {
    firebaseEnabled = true;
    userScoped = true; // /me-style route: a tenant-less principal is allowed
    firebaseVerify.mockResolvedValue({ userId: "u-1", emailVerified: true });
    listForUser.mockResolvedValue([]); // no memberships, no claim → active is undefined
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/me",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(touchLastActive).not.toHaveBeenCalled();
  });

  it("403s a Firebase user targeting a workspace they have NO membership in (attack #1)", async () => {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({
      userId: "u-1",
      emailVerified: true,
    });
    listForUser.mockResolvedValue([{ tenantId: "t-1", role: "owner" }]);
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt", "x-workspace-id": "t-2" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("resolves the sole membership when no workspace is targeted", async () => {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({ userId: "u-1", emailVerified: true });
    listForUser.mockResolvedValue([{ tenantId: "t-1", role: "member" }]);
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toMatchObject({ tenantId: "t-1", role: "member" });
  });

  it("403s a workspace-scoped route when NO workspace resolves (fail closed, not empty scope)", async () => {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({ userId: "u-1", emailVerified: true });
    listForUser.mockResolvedValue([]); // no memberships, no claim
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("allows a @UserScoped route tenant-less when NO workspace resolves", async () => {
    firebaseEnabled = true;
    userScoped = true;
    firebaseVerify.mockResolvedValue({
      userId: "u-1",
      email: "a@b.co",
      emailVerified: true,
    });
    listForUser.mockResolvedValue([]);
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/me/workspaces",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toEqual({
      tenantId: "",
      userId: "u-1",
      subject: "u-1",
      email: "a@b.co",
      emailVerified: true,
    });
  });

  it("does NOT 403 a @UserScoped route on a stale/foreign X-Workspace-Id (no lockout)", async () => {
    // A previous user's workspace lingering in the header must not 403 the switcher's own
    // load — user-scoped routes ignore the header for enforcement.
    firebaseEnabled = true;
    userScoped = true;
    firebaseVerify.mockResolvedValue({ userId: "u-1", emailVerified: true });
    listForUser.mockResolvedValue([{ tenantId: "t-mine", role: "owner" }]);
    const req: FakeReq = {
      headers: {
        authorization: "Bearer good.jwt",
        "x-workspace-id": "t-STALE",
      },
      path: "/me/workspaces",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    // Falls back to the user's own workspace, ignoring the foreign header.
    expect(req.principal).toMatchObject({ tenantId: "t-mine" });
  });

  // --- Legacy claim → Membership migration ---

  it("honors a legacy tenant claim and backfills a Membership on first sight", async () => {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({
      userId: "u-1",
      email: "a@b.co",
      emailVerified: true,
      claimTenant: "t-claim",
    });
    listForUser.mockResolvedValue([]); // no membership row yet
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toMatchObject({
      tenantId: "t-claim",
      role: "owner",
    });
    expect(ensureMembership).toHaveBeenCalledWith(
      "u-1",
      "t-claim",
      "owner",
      "a@b.co",
    );
  });

  it("still authorizes a claim user when the backfill write fails (non-authorizing)", async () => {
    // Access is granted via the claim union, NOT the migration write — a transient DB error
    // or a P2002 race (parallel first-login requests) must not 500 an authorized user.
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({
      userId: "u-1",
      emailVerified: true,
      claimTenant: "t-claim",
    });
    listForUser.mockResolvedValue([]);
    ensureMembership.mockRejectedValue(new Error("unique constraint (P2002)"));
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toMatchObject({ tenantId: "t-claim", role: "owner" });
  });

  it("does NOT re-backfill when the claim tenant is already a membership", async () => {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({
      userId: "u-1",
      emailVerified: true,
      claimTenant: "t-claim",
    });
    listForUser.mockResolvedValue([{ tenantId: "t-claim", role: "owner" }]);
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(ensureMembership).not.toHaveBeenCalled();
  });

  // --- Invitation accept-on-login (RBAC-GROUPS.md §5, slice U1) ---

  it("runs invitation acceptance for a VERIFIED email, BEFORE the membership read", async () => {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({
      userId: "u-1",
      email: "invited@x.com",
      emailVerified: true,
    });
    // The accepted workspace is already visible on THIS request: acceptance runs first,
    // then listForUser reads the (invalidated) memberships.
    listForUser.mockResolvedValue([{ tenantId: "t-inv", role: "member" }]);
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(acceptPendingInvitations).toHaveBeenCalledWith(
      "u-1",
      "invited@x.com",
      true,
    );
    expect(acceptPendingInvitations.mock.invocationCallOrder[0]).toBeLessThan(
      listForUser.mock.invocationCallOrder[0],
    );
    expect(req.principal).toMatchObject({ tenantId: "t-inv", role: "member" });
  });

  it("does NOT accept invitations for an UNVERIFIED email (must never claim an invited address)", async () => {
    firebaseEnabled = true;
    userScoped = true; // isolate from workspace resolution
    firebaseVerify.mockResolvedValue({
      userId: "u-1",
      email: "invited@x.com",
      emailVerified: false,
    });
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/me/workspaces",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(acceptPendingInvitations).not.toHaveBeenCalled();
  });

  it("does NOT accept invitations when the token carries no email at all", async () => {
    firebaseEnabled = true;
    userScoped = true;
    firebaseVerify.mockResolvedValue({ userId: "u-1", emailVerified: true });
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/me/workspaces",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(acceptPendingInvitations).not.toHaveBeenCalled();
  });

  it("still authorizes when invitation acceptance FAILS (swallow-and-log, non-authorizing)", async () => {
    // Same posture as the claim backfill: the accept write only CONVERTS invitations —
    // access resolves from the Membership table, so a DB error here must not 500.
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({
      userId: "u-1",
      email: "invited@x.com",
      emailVerified: true,
    });
    acceptPendingInvitations.mockRejectedValue(new Error("db down"));
    listForUser.mockResolvedValue([{ tenantId: "t-1", role: "owner" }]);
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toMatchObject({ tenantId: "t-1", role: "owner" });
  });

  it("403s when the header and path name different workspaces", async () => {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue({ userId: "u-1", emailVerified: true });
    listForUser.mockResolvedValue([
      { tenantId: "t-1", role: "owner" },
      { tenantId: "t-2", role: "owner" },
    ]);
    const req: FakeReq = {
      headers: { authorization: "Bearer good.jwt", "x-workspace-id": "t-2" },
      path: "/tenants/t-1/credentials",
      params: { id: "t-1" },
    };
    await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe("AuthGuard — access allowlist (ACCESS_ALLOWED_EMAILS)", () => {
  const KEY = "ACCESS_ALLOWED_EMAILS";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  function bearerFirebase(user: unknown): FakeReq {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue(user);
    return { headers: { authorization: "Bearer good.jwt" } };
  }

  it("lets an allowed, email-VERIFIED user through (user-scoped route)", async () => {
    process.env[KEY] = "me@acme.com, other@acme.com";
    userScoped = true; // isolate the allowlist from workspace resolution
    const req = bearerFirebase({
      userId: "u-1",
      email: "ME@acme.com", // case-insensitive
      emailVerified: true,
    });
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
  });

  it("403s an allowed email that is NOT verified (the key hole)", async () => {
    process.env[KEY] = "me@acme.com";
    userScoped = true;
    const req = bearerFirebase({
      userId: "u-1",
      email: "me@acme.com",
      emailVerified: false,
    });
    await expect(makeGuard().canActivate(ctx(req))).rejects.toMatchObject({
      response: { code: "access_not_allowed" },
    });
  });

  it("403s a verified user whose email is NOT on the list, with the marker", async () => {
    process.env[KEY] = "me@acme.com";
    userScoped = true;
    const req = bearerFirebase({
      userId: "u-9",
      email: "stranger@evil.com",
      emailVerified: true,
    });
    await expect(makeGuard().canActivate(ctx(req))).rejects.toMatchObject({
      response: { code: "access_not_allowed" },
    });
    expect(ensureMembership).not.toHaveBeenCalled(); // blocked before any provisioning
  });

  it("is OPEN when the env var is unset (no allowlist)", async () => {
    delete process.env[KEY];
    userScoped = true;
    const req = bearerFirebase({
      userId: "u-1",
      email: "anyone@anywhere.com",
      emailVerified: false, // verification only matters when the list is active
    });
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
  });

  it("does NOT gate `nry_` API tokens (owner capability) even when the list is set", async () => {
    process.env[KEY] = "me@acme.com";
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: null });
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_owner" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(firebaseVerify).not.toHaveBeenCalled();
  });
});

// ── #457: instance-wide MFA enforcement (REQUIRE_MFA) ───────────────────────────────────────
// The verifier is the mock seam (no live Firebase MFA enrolment is possible here): a session
// WITH a second factor is a verified user carrying `secondFactor`, one WITHOUT simply omits it
// — exactly what userFromClaims produces from a real ID token (see firebase-verifier.spec.ts).
describe("AuthGuard — MFA enforcement (REQUIRE_MFA, #457)", () => {
  const KEY = "REQUIRE_MFA";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  function bearerFirebase(user: unknown): FakeReq {
    firebaseEnabled = true;
    firebaseVerify.mockResolvedValue(user);
    return { headers: { authorization: "Bearer good.jwt" } };
  }

  it("parseRequireMfa: only explicit truthy values enable it (default OFF)", () => {
    for (const on of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(parseRequireMfa(on)).toBe(true);
    }
    for (const off of [undefined, "", "0", "false", "no", "maybe", "  "]) {
      expect(parseRequireMfa(off)).toBe(false);
    }
  });

  it("403s `mfa_required` for a session with NO second factor", async () => {
    process.env[KEY] = "true";
    userScoped = true; // isolate the gate from workspace resolution
    const req = bearerFirebase({
      userId: "u-1",
      email: "me@acme.com",
      emailVerified: true, // enrolment, not verification, is what's missing
    });
    await expect(makeGuard().canActivate(ctx(req))).rejects.toMatchObject({
      response: { code: "mfa_required", statusCode: 403 },
    });
    // Gated BEFORE any membership write — an un-enrolled user provisions nothing.
    expect(ensureMembership).not.toHaveBeenCalled();
    expect(acceptPendingInvitations).not.toHaveBeenCalled();
  });

  it("lets a session WITH a second factor through", async () => {
    process.env[KEY] = "true";
    userScoped = true;
    const req = bearerFirebase({
      userId: "u-1",
      email: "me@acme.com",
      emailVerified: true,
      secondFactor: "totp",
    });
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
  });

  it("changes NOTHING when unset — a single-factor user still passes (default off)", async () => {
    delete process.env[KEY];
    userScoped = true;
    const req = bearerFirebase({
      userId: "u-1",
      email: "me@acme.com",
      emailVerified: true,
    });
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
  });

  it("does NOT gate `nry_` API tokens (CLI/MCP have no interactive login)", async () => {
    process.env[KEY] = "true";
    verify.mockResolvedValue({ tenantId: "t-1", environmentId: null });
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_owner" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(firebaseVerify).not.toHaveBeenCalled();
  });

  it("does NOT gate @Public() routes — they carry no user at all", async () => {
    process.env[KEY] = "true";
    // IS_PUBLIC_KEY → true (webhook ingress, hosted forms/chat, OAuth callbacks, signed
    // approve/reject links, /healthz, /metrics): no token needed, so nothing to enrol.
    getAllAndOverride.mockReset().mockReturnValue(true);
    const req: FakeReq = { headers: {}, path: "/hooks/abc" };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(firebaseVerify).not.toHaveBeenCalled();
  });

  it("still gates a workspace-scoped route (not just user-scoped ones)", async () => {
    process.env[KEY] = "true";
    userScoped = false;
    listForUser.mockResolvedValue([{ tenantId: "t-1", role: "owner" }]);
    const req = bearerFirebase({
      userId: "u-1",
      email: "me@acme.com",
      emailVerified: true,
    });
    req.path = "/tenants/t-1/credentials";
    await expect(makeGuard().canActivate(ctx(req))).rejects.toMatchObject({
      response: { code: "mfa_required" },
    });
  });
});
