import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, Record<string, unknown>>();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    ssoConnection: {
      findMany: async ({ where }: any) =>
        [...rows.values()].filter((r) => r.tenantId === where.tenantId),
      findUnique: async ({ where }: any) =>
        [...rows.values()].find(
          (r) =>
            (where.idpEntityId && r.idpEntityId === where.idpEntityId) ||
            (where.slug && r.slug === where.slug),
        ) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = [...rows.values()].find(
          (r) => r.idpEntityId === where.idpEntityId,
        );
        const row = {
          id: (existing?.id as string) ?? `conn_${rows.size + 1}`,
          ...(existing ?? create),
          ...update,
        };
        rows.set(row.id as string, row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [k, r] of rows) {
          if (r.id === where.id && r.tenantId === where.tenantId) {
            rows.delete(k);
            count++;
          }
        }
        return { count };
      },
    },
  }),
}));

import type { Principal } from "../src/auth/tenant.decorator";
import { SsoConnectionsController } from "../src/sso/sso-connections.controller";
import type { UpsertSsoConnectionDto } from "../src/sso/sso-connection.dto";

const owner: Principal = { tenantId: "ws-a", userId: "u-1", role: "owner" };
const member: Principal = { tenantId: "ws-a", userId: "u-2", role: "member" };
const apiToken: Principal = { tenantId: "ws-a", role: "owner" }; // no userId

const body = (over: Partial<UpsertSsoConnectionDto> = {}) =>
  ({
    slug: "acme",
    idpEntityId: "https://idp.example.com/entity",
    idpSsoUrl: "https://idp.example.com/sso",
    idpCertPem: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----",
    allowedEmailDomains: ["Tenant-A.com", "@other.com"],
    ...over,
  }) as UpsertSsoConnectionDto;

/** The self-service flag is read in the CONSTRUCTOR (boot), like REQUIRE_MFA. */
function controller(selfService: boolean): SsoConnectionsController {
  const saved = process.env.SSO_SELF_SERVICE;
  if (selfService) process.env.SSO_SELF_SERVICE = "true";
  else delete process.env.SSO_SELF_SERVICE;
  try {
    return new SsoConnectionsController();
  } finally {
    if (saved === undefined) delete process.env.SSO_SELF_SERVICE;
    else process.env.SSO_SELF_SERVICE = saved;
  }
}

beforeEach(() => rows.clear());

describe("SsoConnectionsController — who may register an IdP", () => {
  it("DEFAULT: registration is an operator action — an owner is refused", async () => {
    // Registering a connection declares "this cert may assert these domains", and nothing in a
    // request proves domain ownership. Self-service is therefore opt-in, and OFF by default.
    await expect(
      controller(false).upsert("ws-a", body(), owner),
    ).rejects.toMatchObject({ status: 403 });
    expect(rows.size).toBe(0);
  });

  it("with SSO_SELF_SERVICE=true an owner can register, and domains are normalised", async () => {
    const row = await controller(true).upsert("ws-a", body(), owner);
    expect(row).toMatchObject({
      tenantId: "ws-a",
      slug: "acme",
      allowedEmailDomains: ["tenant-a.com", "other.com"], // lowercased, `@` stripped
      defaultRole: "member",
      autoProvision: true,
      enabled: true,
    });
  });

  it("a plain member cannot register, list or delete", async () => {
    const c = controller(true);
    await expect(c.upsert("ws-a", body(), member)).rejects.toMatchObject({
      status: 403,
    });
    await expect(c.list("ws-a", member)).rejects.toMatchObject({ status: 403 });
    await expect(c.remove("ws-a", "conn_1", member)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("an `nry_` API token (no userId) cannot configure SSO", async () => {
    await expect(
      controller(true).upsert("ws-a", body(), apiToken),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("an empty domain list is refused (it would mean 'any address')", async () => {
    await expect(
      controller(true).upsert(
        "ws-a",
        body({ allowedEmailDomains: ["  "] }),
        owner,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("SsoConnectionsController — cross-workspace protection", () => {
  it("cannot steal an entity id already registered by ANOTHER workspace", async () => {
    const c = controller(true);
    await c.upsert("ws-a", body(), owner);
    // ws-b tries to claim the same IdP entity id — that would redirect ws-a's federated logins.
    await expect(
      c.upsert("ws-b", body({ slug: "beta" }), {
        tenantId: "ws-b",
        userId: "u-9",
        role: "owner",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("cannot steal another workspace's slug either", async () => {
    const c = controller(true);
    await c.upsert("ws-a", body(), owner);
    await expect(
      c.upsert(
        "ws-b",
        body({ idpEntityId: "https://other-idp/entity", slug: "acme" }),
        { tenantId: "ws-b", userId: "u-9", role: "owner" },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  /**
   * The upsert keys on `idpEntityId`, so reusing a slug that one of your OWN other connections
   * already holds used to sail past the cross-tenant check and die on the unique constraint —
   * a Prisma error surfacing as a 500. It's the caller's slug to change, so it must be a 4xx.
   */
  it("a slug already used by another connection in the SAME workspace is a 409, not a 500", async () => {
    const c = controller(true);
    await c.upsert("ws-a", body(), owner);
    await expect(
      c.upsert(
        "ws-a",
        body({ idpEntityId: "https://second-idp/entity", slug: "acme" }),
        owner,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("re-registering the SAME connection keeps its slug (an update, not a clash)", async () => {
    const c = controller(true);
    await c.upsert("ws-a", body(), owner);
    const again = await c.upsert("ws-a", body({ label: "Acme renamed" }), owner);
    expect(again.label).toBe("Acme renamed");
    expect(again.slug).toBe("acme");
  });

  it("delete is tenant-scoped: a foreign id is a no-op, never a cross-tenant delete", async () => {
    const c = controller(true);
    const row = await c.upsert("ws-a", body(), owner);
    expect(
      await c.remove("ws-b", row.id, {
        tenantId: "ws-b",
        userId: "u-9",
        role: "owner",
      }),
    ).toEqual({ deleted: 0 });
    expect(rows.size).toBe(1);
    expect(await c.remove("ws-a", row.id, owner)).toEqual({ deleted: 1 });
  });

  it("list only returns the caller's workspace connections", async () => {
    const c = controller(true);
    await c.upsert("ws-a", body(), owner);
    await c.upsert(
      "ws-b",
      body({ idpEntityId: "https://idp-b/entity", slug: "beta" }),
      { tenantId: "ws-b", userId: "u-9", role: "owner" },
    );
    const listed = await c.list("ws-a", owner);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tenantId: "ws-a" });
  });
});
