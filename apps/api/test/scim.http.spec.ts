import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { Controller, Post, Req, type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * SCIM over a REAL HTTP round trip, through the REAL global AuthGuard (#1075 slice 1).
 *
 * The unit specs call `ScimGuard.canActivate()` directly, which proves the guard's logic and
 * nothing about whether it RUNS. This surface is `@Public()` — the global AuthGuard returns
 * early without inspecting anything — so the entire authentication of /scim/v2 rests on the
 * ordering assumption that a controller-scoped guard executes after a global one that passed.
 *
 * That assumption fails SILENTLY in the direction that matters least and would still look
 * correct: if ScimGuard never ran, `@ScimTenant()` would throw 401 anyway. So it has to be
 * checked from the outside, against a listening server, with a credential that SHOULD work and
 * one that should not.
 */

const scimIdentityRows: Record<string, unknown>[] = [];
/** Emails the fake MembersService has "invited" — what makes a POSTed subject readable back. */
const invited = new Set<string>();
/** Alice's `Membership.active` (#1115). Mutated by the fake `setMemberActive`, read back by
 *  every membership query below, so the PATCH round trip can end at a GET rather than at a spy. */
let aliceActive = true;
const alice = () => ({
  userId: "uid-a",
  email: "alice@a.example",
  role: "member",
  active: aliceActive,
  createdAt: new Date("2026-08-04T00:00:00Z"),
});
const db = {
  membership: {
    findMany: vi.fn(async ({ where }: { where: { tenantId: string } }) =>
      where.tenantId === "tenant-A"
        ? [alice()]
        : [
            {
              userId: "uid-b",
              email: "bob@b.example",
              role: "member",
              active: true,
              createdAt: new Date("2026-08-04T00:00:00Z"),
            },
          ],
    ),
    findFirst: vi.fn(
      async ({
        where,
      }: {
        where: { tenantId?: string; email?: { equals?: string } };
      }) =>
        where?.tenantId === "tenant-A" &&
        (where?.email?.equals ?? "").toLowerCase() === "alice@a.example"
          ? alice()
          : null,
    ),
  },
  invitation: {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(
      async ({ where }: { where: { email?: { equals?: string } } }) => {
        const email = where?.email?.equals ?? "";
        return invited.has(email)
          ? { email, createdAt: new Date("2026-08-04T00:00:00Z") }
          : null;
      },
    ),
  },
  scimIdentity: {
    // Resolves ONLY rows a read has already materialised, tenant-scoped — so an id this
    // connection was never issued still 404s (the envelope test below), while an id a reconcile
    // GET handed out is addressable, which is what the PATCH round trip needs.
    findFirst: vi.fn(
      async ({ where }: { where: { id?: string; tenantId?: string } }) =>
        scimIdentityRows.find(
          (r) => r.id === where?.id && r.tenantId === where?.tenantId,
        ) ?? null,
    ),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(
      async ({
        where,
        create,
      }: {
        where: { tenantId_email: { tenantId: string; email: string } };
        create: Record<string, unknown>;
      }) => {
        const key = `${where.tenantId_email.tenantId}:${where.tenantId_email.email}`;
        const existing = scimIdentityRows.find((r) => r.key === key);
        if (existing) return existing;
        const row = {
          key,
          id: `sid-${scimIdentityRows.length + 1}`,
          createdAt: new Date("2026-08-04T00:00:00Z"),
          updatedAt: new Date("2026-08-04T00:00:00Z"),
          ...create,
        };
        scimIdentityRows.push(row);
        return row;
      },
    ),
  },
};
vi.mock("@naary/db", () => ({ getPrisma: () => db }));

import { AuditService } from "../src/audit/audit.service";
import { Public } from "../src/auth/public.decorator";
import { ApiTokenService } from "../src/auth/api-token.service";
import { AuthGuard } from "../src/auth/auth.guard";
import { FirebaseVerifier } from "../src/auth/firebase-verifier";
import { MembersService } from "../src/members/members.service";
import { MembershipService } from "../src/membership/membership.service";
import { PermissionsService } from "../src/permissions/permissions.service";
import { mountScimBodyParser } from "../src/scim/scim-body-parser";
import { ScimConnectionService } from "../src/scim/scim-connection.service";
import { ScimProvisioningService } from "../src/scim/scim-provisioning.service";
import { ScimUsersService } from "../src/scim/scim-users.service";
import { ScimController } from "../src/scim/scim.controller";
import { ScimGuard } from "../src/scim/scim.guard";
import { SsoSessionService } from "../src/sso/sso-session.service";

/** A valid `nry_` API token for tenant-B — the credential this door must NOT open. */
const API_TOKEN = "nry_a-real-workspace-token";
const SCIM_TOKEN_A = "nryscim_tenant-a-connection";

/**
 * A stand-in for EVERY OTHER ROUTE IN THE API — the ~168 paths that are not SCIM.
 *
 * It echoes what the body parsers actually left on the request, which is the only way to prove
 * the two properties that matter about mounting the SCIM parser:
 *  1. an ordinary `application/json` body still arrives intact here (the catastrophic, quiet
 *     regression: Nest skipping its own parser, or path-mounting reordering it away);
 *  2. an `application/scim+json` body is NOT parsed here — only /scim/v2 speaks SCIM.
 */
@Public()
@Controller("echo")
class EchoController {
  @Post()
  echo(@Req() req: { body?: unknown }): { parsed: boolean; body: unknown } {
    const body = req.body;
    const parsed =
      !!body && typeof body === "object" && Object.keys(body).length > 0;
    return { parsed, body: body ?? null };
  }
}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [ScimController, EchoController],
    providers: [
      ScimUsersService,
      ScimProvisioningService,
      ScimGuard,
      // The member lifecycle is faked here on purpose: this spec is about the guard chain, the
      // routing and the wire format. That de-provisioning really goes through MembersService —
      // with the group cascade, the cache invalidations and the audit row — is asserted against
      // the REAL service in scim.write-isolation.spec.ts.
      {
        provide: MembersService,
        useValue: {
          invite: async (_t: string, _c: unknown, email: string) => {
            invited.add(email);
          },
          removeMember: async () => ({ removed: false }),
          revokeInvitation: async () => undefined,
          // #1115 — the flip the PATCH route delegates to. Faked like the rest of the lifecycle;
          // that it really invalidates both caches, revokes the CLI credential and reports
          // stranded approvals is asserted against the REAL service in membership-active.spec.ts.
          setMemberActive: async (
            _t: string,
            _c: unknown,
            _u: string,
            active: boolean,
          ) => {
            aliceActive = active;
            return { changed: true, strandedApprovals: null };
          },
        },
      },
      { provide: AuditService, useValue: { record: async () => undefined } },
      {
        provide: ScimConnectionService,
        useValue: {
          verify: async (token: string) =>
            token === SCIM_TOKEN_A
              ? {
                  connectionId: "conn-a",
                  tenantId: "tenant-A",
                  allowedEmailDomains: ["a.example"],
                }
              : null,
        },
      },
      // The REAL global guard, exactly as AuthModule registers it.
      { provide: APP_GUARD, useClass: AuthGuard },
      {
        provide: ApiTokenService,
        useValue: {
          verify: async (t: string) =>
            t === API_TOKEN
              ? { id: "tok-1", tenantId: "tenant-B", environmentId: null }
              : null,
        },
      },
      {
        provide: FirebaseVerifier,
        useValue: { enabled: false, verify: async () => null },
      },
      {
        provide: MembershipService,
        useValue: { forUser: async () => [], touchLastActive: async () => {} },
      },
      {
        provide: PermissionsService,
        useValue: { isTenantEnforced: async () => false },
      },
      {
        provide: SsoSessionService,
        useValue: { isSessionToken: () => false, verify: async () => null },
      },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  // The SAME middleware main.ts installs — an IdP's `application/scim+json` body is invisible
  // to express.json() without it, and that failure only ever shows up over real HTTP.
  // The SAME call main.ts makes, before init(), because this spec exists to catch a mounting
  // or ordering bug in main.ts and cannot do that if it builds the app differently.
  mountScimBodyParser(app);
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app?.close();
});

const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { headers });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

describe("GET /scim/v2/* through the real guard chain", () => {
  it("401s with no bearer — so ScimGuard DOES run behind @Public()", async () => {
    const res = await get("/scim/v2/Users");
    expect(res.status).toBe(401);
    expect(res.body.schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);
  });

  it("authenticates a SCIM bearer and returns that connection's OWN tenant", async () => {
    const res = await get("/scim/v2/Users", {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("alice@a.example");
    expect(JSON.stringify(res.body)).not.toContain("b.example");
  });

  /**
   * The credential-model assertion, end to end. A `nry_` workspace token is a full-access
   * capability — AuthGuard stamps it `role: "owner"` — and it must not be a SCIM credential.
   * If SCIM had reused the ApiToken table, this request would succeed.
   */
  it("REJECTS a valid `nry_` API token: a workspace token is not a SCIM credential", async () => {
    const res = await get("/scim/v2/Users", {
      authorization: `Bearer ${API_TOKEN}`,
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("b.example");
  });

  it("ignores X-Workspace-Id — a request cannot name its own tenant here", async () => {
    const res = await get("/scim/v2/Users", {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
      "x-workspace-id": "tenant-B",
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("b.example");
  });

  /**
   * `patch: true` IS A CONTRACT, not a config line (#1115): an IdP reads this document to decide
   * what to send, so this assertion is the wire-level half of "PATCH is implemented". It said
   * `false` for two slices precisely because nothing behind it worked.
   */
  it("serves ServiceProviderConfig only to an authenticated connection, and advertises PATCH now that it exists", async () => {
    expect((await get("/scim/v2/ServiceProviderConfig")).status).toBe(401);
    const res = await get("/scim/v2/ServiceProviderConfig", {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.patch).toEqual({ supported: true });
    expect(res.body.bulk).toMatchObject({ supported: false });
  });

  /** PATCH is routed since #1115 — an empty `Operations` list is a 400 from the parser, and that
   *  is what proves the ROUTE exists: an unrouted method 404s before any body is read. PUT is
   *  still absent, because replacing a whole User means accepting attributes we do not store. */
  it("routes PATCH but still no PUT", async () => {
    const patched = await fetch(`${base}/scim/v2/Users/some-id`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${SCIM_TOKEN_A}`,
        "content-type": "application/scim+json",
      },
      body: JSON.stringify({ Operations: [] }),
    });
    expect(patched.status).toBe(400);
    {
      const res = await fetch(`${base}/scim/v2/Users/some-id`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${SCIM_TOKEN_A}`,
          "content-type": "application/scim+json",
        },
        body: JSON.stringify({ userName: "x@a.example" }),
      });
      expect(res.status).toBe(404);
    }
    // /Groups is not implemented either — slices 1–2 are Users.
    expect(
      (
        await get("/scim/v2/Groups", {
          authorization: `Bearer ${SCIM_TOKEN_A}`,
        })
      ).status,
    ).toBe(404);
  });

  it("returns a SCIM 400 invalidFilter for an unsupported filter rather than listing everything", async () => {
    const res = await get('/scim/v2/Users?filter=userName co "a"', {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
    });
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("invalidFilter");
  });
});

describe("the WRITE surface is behind the same door (#1075 slice 2)", () => {
  const write = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      location: res.headers.get("location"),
      text: await res.text(),
    };
  };

  it.each([
    ["POST", "/scim/v2/Users"],
    ["DELETE", "/scim/v2/Users/some-id"],
  ])(
    "401s %s with no bearer — a write cannot slip past @Public()",
    async (method, path) => {
      const res = await write(method, path, {
        "content-type": "application/scim+json",
      });
      expect(res.status).toBe(401);
      expect(res.text).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    },
  );

  /** The credential-model assertion again, on the half that DESTROYS things: an `nry_` token
   *  is stamped `role: "owner"` by AuthGuard, and must still be nothing here. */
  it.each([
    ["POST", "/scim/v2/Users"],
    ["DELETE", "/scim/v2/Users/some-id"],
  ])(
    "401s %s presented with a valid `nry_` API token",
    async (method, path) => {
      const res = await write(
        method,
        path,
        {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/scim+json",
        },
        method === "POST" ? { userName: "mallory@a.example" } : undefined,
      );
      expect(res.status).toBe(401);
    },
  );

  /**
   * THE INTEROP TRAP. Okta and Entra send `application/scim+json`, which express.json() does
   * NOT match — without scimBodyParser() the body arrives empty and every create 400s with a
   * message about a missing payload, which looks like the IdP's bug and is ours.
   */
  it("parses an application/scim+json body and 201s with a Location header", async () => {
    const res = await write(
      "POST",
      "/scim/v2/Users",
      {
        authorization: `Bearer ${SCIM_TOKEN_A}`,
        "content-type": "application/scim+json",
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "newbie@a.example",
        externalId: "okta-1",
      },
    );
    expect(res.status).toBe(201);
    const body = JSON.parse(res.text) as { id: string; active: boolean };
    expect(body.active).toBe(false); // provisioned = invited, not yet signed in
    expect(res.location).toBe(`/scim/v2/Users/${body.id}`);
  });

  /**
   * THE NARROWING, PROVEN IN BOTH DIRECTIONS.
   *
   * The SCIM parser is mounted on /scim/v2 alone. A global mount would quietly teach every one
   * of the API's other paths to accept `application/scim+json` — a wider request surface, for
   * no benefit, on routes that should keep refusing a content type they never asked for.
   */
  it("does NOT parse application/scim+json on a non-SCIM route", async () => {
    const res = await write(
      "POST",
      "/echo",
      { "content-type": "application/scim+json" },
      { userName: "mallory@a.example" },
    );
    expect(res.status).toBe(201);
    expect(JSON.parse(res.text).parsed).toBe(false);
  });

  /**
   * …and the direction that would be CATASTROPHIC AND QUIET. Both traps live here: Nest
   * skipping its own parser because ours was named `jsonParser`, and a mount that reorders
   * the parsers away from ordinary routes. Either one empties every `application/json` body
   * in the product, and nothing else in the suite would notice.
   */
  it("leaves ordinary application/json bodies intact on a non-SCIM route", async () => {
    const res = await write(
      "POST",
      "/echo",
      { "content-type": "application/json" },
      { hello: "world" },
    );
    expect(res.status).toBe(201);
    expect(JSON.parse(res.text)).toMatchObject({
      parsed: true,
      body: { hello: "world" },
    });
  });

  it("also accepts a plain application/json body", async () => {
    const res = await write(
      "POST",
      "/scim/v2/Users",
      {
        authorization: `Bearer ${SCIM_TOKEN_A}`,
        "content-type": "application/json",
      },
      { userName: "second@a.example" },
    );
    expect(res.status).toBe(201);
  });

  it("400s a userName outside the connection's allowed domains", async () => {
    const res = await write(
      "POST",
      "/scim/v2/Users",
      {
        authorization: `Bearer ${SCIM_TOKEN_A}`,
        "content-type": "application/scim+json",
      },
      { userName: "mallory@evil.example" },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text).scimType).toBe("invalidValue");
  });

  /**
   * THE PATCH ROUND TRIP — the test `patch: { supported: true }` obliges us to have.
   *
   * The unit specs call `setActive()` directly, which proves the semantics and nothing about
   * whether a body ever REACHES it. That gap is exactly the class of failure
   * `scim-body-parser.ts` exists for: Nest's own parser matches `application/json` and NOT a
   * `+json` suffix, so an IdP's perfectly valid PATCH would arrive EMPTY and 400 with "a SCIM
   * PatchOp payload is required" — which reads like a payload bug and is not one. And since
   * flipping `ServiceProviderConfig` we have told every Okta and Entra tenant to start sending
   * PATCH instead of DELETE, so "the route is mounted" is no longer enough.
   *
   * It ends at a GET, not at a spy: `active: false` has to come back out of the read surface the
   * IdP will reconcile against, or the de-provision it just performed is undone on its next sync.
   */
  it("PATCHes active:false over application/scim+json, 204s, and the GET agrees", async () => {
    // The reconcile GET materialises the stable id an IdP would store…
    const listed = await get("/scim/v2/Users", {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
    });
    const subject = (
      listed.body.Resources as {
        id: string;
        userName: string;
        active: boolean;
      }[]
    ).find((r) => r.userName === "alice@a.example");
    if (!subject) throw new Error("the reconcile GET listed no alice");
    expect(subject.active).toBe(true);

    // …and the PATCH that IdP then sends, with SCIM's own media type.
    const patched = await write(
      "PATCH",
      `/scim/v2/Users/${subject.id}`,
      {
        authorization: `Bearer ${SCIM_TOKEN_A}`,
        "content-type": "application/scim+json",
      },
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    );
    expect(patched.status).toBe(204);
    expect(patched.text).toBe("");

    const after = await get(`/scim/v2/Users/${subject.id}`, {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
    });
    expect(after.status).toBe(200);
    expect(after.body.active).toBe(false);

    // …and back again — the reversibility the column exists for, over the wire.
    const restored = await write(
      "PATCH",
      `/scim/v2/Users/${subject.id}`,
      {
        authorization: `Bearer ${SCIM_TOKEN_A}`,
        "content-type": "application/scim+json",
      },
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: true }],
      },
    );
    expect(restored.status).toBe(204);
    expect(
      (
        await get(`/scim/v2/Users/${subject.id}`, {
          authorization: `Bearer ${SCIM_TOKEN_A}`,
        })
      ).body.active,
    ).toBe(true);
  });

  it("404s a DELETE for an id this connection was never issued, in the SCIM envelope", async () => {
    const res = await write("DELETE", "/scim/v2/Users/not-mine", {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
    });
    expect(res.status).toBe(404);
    expect(res.text).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    // No hint that the id might belong to someone else.
    expect(res.text).not.toMatch(/tenant|workspace|belongs/i);
  });
});
