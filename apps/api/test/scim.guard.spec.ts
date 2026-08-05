import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@naary/db", () => ({ getPrisma: () => ({}) }));

import {
  ScimGuard,
  ScimTenant,
  type ScimRequest,
} from "../src/scim/scim.guard";
import { ScimError } from "../src/scim/scim.errors";
import type { ScimConnectionService } from "../src/scim/scim-connection.service";

/** A Nest ExecutionContext just deep enough for a guard. */
function ctxFor(req: ScimRequest) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as Parameters<ScimGuard["canActivate"]>[0];
}

const verify = vi.fn();
const guard = new ScimGuard({ verify } as unknown as ScimConnectionService);

beforeEach(() => vi.clearAllMocks());

describe("ScimGuard", () => {
  it("attaches the tenant from the VERIFIED CONNECTION and nothing else", async () => {
    verify.mockResolvedValue({
      connectionId: "conn-1",
      tenantId: "tenant-A",
      allowedEmailDomains: ["a.example"],
    });
    const req: ScimRequest = {
      headers: { authorization: "Bearer nryscim_abc" },
    };
    expect(await guard.canActivate(ctxFor(req))).toBe(true);
    expect(req.scim).toEqual({
      connectionId: "conn-1",
      tenantId: "tenant-A",
      allowedEmailDomains: ["a.example"],
    });
  });

  it("NEVER sets req.principal — a SCIM connection must not become a principal", async () => {
    verify.mockResolvedValue({
      connectionId: "conn-1",
      tenantId: "tenant-A",
      allowedEmailDomains: ["a.example"],
    });
    const req = {
      headers: { authorization: "Bearer nryscim_abc" },
    } as ScimRequest & { principal?: unknown };
    await guard.canActivate(ctxFor(req));
    // The whole reason this guard exists rather than a branch in AuthGuard: AuthGuard would
    // stamp a role (an `nry_` token becomes `owner`), and an IdP is not a workspace operator.
    expect(req.principal).toBeUndefined();
    expect(Object.keys(req.scim ?? {})).not.toContain("role");
  });

  it.each([
    ["no header", {}],
    ["a non-bearer scheme", { authorization: "Basic abc" }],
    ["an empty bearer", { authorization: "Bearer " }],
  ])("401s with %s", async (_label, headers) => {
    await expect(
      guard.canActivate(ctxFor({ headers } as ScimRequest)),
    ).rejects.toBeInstanceOf(ScimError);
    expect(verify).not.toHaveBeenCalled(); // no DB work for a malformed request
  });

  it("401s when the connection does not verify (unknown, revoked or disabled)", async () => {
    verify.mockResolvedValue(null);
    const req: ScimRequest = {
      headers: { authorization: "Bearer nryscim_gone" },
    };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(
      ScimError,
    );
    expect(req.scim).toBeUndefined();
  });

  it("gives the SAME 401 whatever the reason, so it is not an oracle for which tokens exist", async () => {
    verify.mockResolvedValue(null);
    const bodies: unknown[] = [];
    for (const t of ["nryscim_unknown", "nry_wrongkind", "not-a-token"]) {
      await guard
        .canActivate(ctxFor({ headers: { authorization: `Bearer ${t}` } }))
        .catch((e: ScimError) => bodies.push(e.getResponse()));
    }
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("renders the SCIM error envelope, not Nest's default shape", async () => {
    verify.mockResolvedValue(null);
    const err = await guard
      .canActivate(ctxFor({ headers: { authorization: "Bearer nryscim_x" } }))
      .catch((e: ScimError) => e);
    const body = (err as ScimError).getResponse() as Record<string, unknown>;
    expect(body.schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);
    expect(body.status).toBe("401"); // SCIM sends the code as a STRING
  });
});

describe("@ScimTenant", () => {
  /** createParamDecorator wraps the factory; reach it the way Nest's own tests do. */
  const factory = ScimTenant as unknown as { KEY?: string } & ((
    ...a: unknown[]
  ) => unknown);

  it("is the only source of a tenant on this surface", async () => {
    // A request that tries to name its own workspace must not be able to.
    const req = {
      headers: {
        authorization: "Bearer nryscim_abc",
        "x-workspace-id": "tenant-B",
      },
    } as ScimRequest;
    verify.mockResolvedValue({
      connectionId: "conn-1",
      tenantId: "tenant-A",
      allowedEmailDomains: ["a.example"],
    });
    await guard.canActivate(ctxFor(req));
    expect(req.scim?.tenantId).toBe("tenant-A"); // the header is ignored entirely
    expect(factory).toBeTypeOf("function");
  });
});
