import "reflect-metadata";
import type { ServerResponse } from "node:http";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `nry_` API token EXPIRY (#1078 §3, slice 1).
 *
 * The point of this file is NOT that a column exists — it is that an expired token is actually
 * REJECTED, on every surface that authenticates one. `ApiTokenService.verify()` is the single
 * resolution path (it is the only `tokenHash` lookup in the codebase), so the tests below wire the
 * REAL service into the REAL callers rather than stubbing `verify` out:
 *
 *   - REST  → the real AuthGuard, which maps a null verify to 401.
 *   - /api/v1 → the same guard on a v1 path, plus proof that the v1-only
 *     ApiTokenThrottlerGuard resolves nothing from the DB and so cannot pre-empt the check.
 *   - MCP   → the real McpController, which maps a null verify to a JSON-RPC 401.
 *
 * Everything is driven through the PLAINTEXT token, so the sha256 lookup is exercised for real.
 */

// ---------------------------------------------------------------------------
// A tiny in-memory ApiToken table keyed by the sha256 the service computes.
// ---------------------------------------------------------------------------
interface Row {
  id: string;
  tenantId: string;
  tokenHash: string;
  label: string;
  environmentId: string | null;
  expiresAt: Date | null;
}

const { rowsByHash, findUnique, update, create } = vi.hoisted(() => {
  const rowsByHash = new Map<string, Row>();
  return {
    rowsByHash,
    findUnique: vi.fn(
      async ({ where }: { where: { tokenHash: string } }) =>
        rowsByHash.get(where.tokenHash) ?? null,
    ),
    update: vi.fn(async () => undefined),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "new-id",
      label: data.label,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })),
  };
});

vi.mock("@naary/db", () => ({
  getPrisma: () => ({ apiToken: { findUnique, update, create } }),
}));

import { ApiTokenService } from "../src/auth/api-token.service";
import { AuthGuard } from "../src/auth/auth.guard";
import type { FirebaseVerifier } from "../src/auth/firebase-verifier";
import type { MembershipService } from "../src/membership/membership.service";
import type { PermissionsService } from "../src/permissions/permissions.service";
import type { SsoSessionService } from "../src/sso/sso-session.service";
import { ApiTokenThrottlerGuard } from "../src/v1/api-token-throttler.guard";
import { McpController } from "../src/mcp/mcp.controller";

const service = new ApiTokenService();

/** The `data` the service last handed to prisma.apiToken.create. */
function lastCreateData(): { tokenHash: string; expiresAt: Date | null } {
  const calls = create.mock.calls;
  return (calls[calls.length - 1][0] as { data: Record<string, unknown> })
    .data as unknown as { tokenHash: string; expiresAt: Date | null };
}

/** Seed a token row and hand back its PLAINTEXT, so every test drives the real hash path. */
async function seedToken(
  expiresAt: Date | null,
  id = "tok-1",
): Promise<string> {
  const { token } = await service.mint(
    "tenant-A",
    "test",
    expiresAt ?? undefined,
  );
  const hash = lastCreateData().tokenHash;
  rowsByHash.set(hash, {
    id,
    tenantId: "tenant-A",
    tokenHash: hash,
    label: "test",
    environmentId: null,
    expiresAt,
  });
  return token;
}

const HOUR = 60 * 60 * 1000;
const past = () => new Date(Date.now() - HOUR);
const future = () => new Date(Date.now() + HOUR);

beforeEach(() => {
  rowsByHash.clear();
  findUnique.mockClear();
  update.mockClear();
  create.mockClear();
});

// ---------------------------------------------------------------------------
// The service: the single enforcement point.
// ---------------------------------------------------------------------------
describe("ApiTokenService.verify — expiry", () => {
  it("rejects a token whose expiresAt has passed", async () => {
    const token = await seedToken(past());
    expect(await service.verify(token)).toBeNull();
  });

  it("accepts a token with a FUTURE expiresAt", async () => {
    const token = await seedToken(future());
    expect(await service.verify(token)).toEqual({
      id: "tok-1",
      tenantId: "tenant-A",
      environmentId: null,
    });
  });

  it("accepts a token with expiresAt NULL — existing tokens are grandfathered, not rotated", async () => {
    const token = await seedToken(null);
    expect(await service.verify(token)).toEqual({
      id: "tok-1",
      tenantId: "tenant-A",
      environmentId: null,
    });
  });

  it("treats the expiry instant itself as expired (<=, not <)", async () => {
    const now = new Date("2026-08-04T12:00:00Z");
    vi.setSystemTime(now);
    const token = await seedToken(new Date(now));
    expect(await service.verify(token)).toBeNull();
    vi.useRealTimers();
  });

  it("does NOT stamp lastUsedAt for an expired token (a dead token must not look active)", async () => {
    const token = await seedToken(past());
    await service.verify(token);
    expect(update).not.toHaveBeenCalled();
    // Control: a live token still stamps, so the assertion above is about expiry, not a no-op.
    const live = await seedToken(null, "tok-2");
    await service.verify(live);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("mint() stores NULL when no expiry is given — the Settings/CI default stays non-expiring", async () => {
    await service.mint("tenant-A", "ci");
    expect(lastCreateData().expiresAt).toBeNull();
  });

  it("mint() persists an explicit expiry", async () => {
    const at = future();
    await service.mint("tenant-A", "naary CLI", at);
    expect(lastCreateData().expiresAt).toBe(at);
  });
});

// ---------------------------------------------------------------------------
// REST + /api/v1: the real AuthGuard over the real service.
// ---------------------------------------------------------------------------
interface FakeReq {
  headers: Record<string, string | undefined>;
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

function makeGuard(): AuthGuard {
  return new AuthGuard(
    service,
    {
      get enabled() {
        return false;
      },
      verify: vi.fn(),
    } as unknown as FirebaseVerifier,
    { getAllAndOverride: vi.fn(() => false) } as unknown as Reflector,
    {
      listForUser: vi.fn(async () => []),
      ensureMembership: vi.fn(),
      acceptPendingInvitations: vi.fn(),
      touchLastActive: vi.fn(),
    } as unknown as MembershipService,
    {
      isTenantEnforced: vi.fn(async () => false),
    } as unknown as PermissionsService,
    {
      isSessionToken: (t: string) => t.startsWith("nrys_"),
      verify: vi.fn(),
    } as unknown as SsoSessionService,
  );
}

describe("AuthGuard — an expired nry_ token is 401 on REST and on /api/v1", () => {
  for (const path of ["/workflows", "/api/v1/runs"]) {
    it(`401s an expired token on ${path}`, async () => {
      const token = await seedToken(past());
      const req: FakeReq = {
        headers: { authorization: `Bearer ${token}` },
        path,
      };
      await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(req.principal).toBeUndefined();
    });

    it(`still admits a non-expiring token on ${path}`, async () => {
      const token = await seedToken(null);
      const req: FakeReq = {
        headers: { authorization: `Bearer ${token}` },
        path,
      };
      await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
      expect(req.principal).toMatchObject({ tenantId: "tenant-A" });
    });
  }

  it("the v1-only throttler resolves no token from the DB, so it cannot pre-empt the expiry check", async () => {
    // ApiTokenThrottlerGuard buckets on a sha256 of the raw header — deliberately DB-free and
    // guard-order independent. If it ever started resolving tokens itself, that would be a second
    // authentication path that expiry does not cover.
    const token = await seedToken(past());
    const tracker = await (
      new ApiTokenThrottlerGuard(
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as {
        getTracker(req: Record<string, unknown>): Promise<string>;
      }
    ).getTracker({ headers: { authorization: `Bearer ${token}` } });
    expect(tracker).toMatch(/^tok:[0-9a-f]{64}$/);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MCP: the second real call site of verify().
// ---------------------------------------------------------------------------
class FakeRes {
  public statusCode = 0;
  public headers: Record<string, string> = {};
  public body = "";
  setHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers)
      for (const [k, v] of Object.entries(headers))
        this.headers[k.toLowerCase()] = v;
    return this;
  }
  end(chunk?: string) {
    if (chunk) this.body += chunk;
  }
}

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};

/** Only the collaborators reached AFTER authentication are stubbed — the expired-token case
 *  never touches them, and the control case must be able to get past auth for its assertion
 *  ("not 401") to mean anything. */
function makeMcp(): McpController {
  return new McpController(
    service,
    { list: async () => [], listMcpExposed: async () => [] } as never,
    {} as never,
    {} as never,
    { defaultEnvId: async () => "env-1" } as never,
    { isTenantEnforced: async () => false } as never,
  );
}

describe("McpController — an expired nry_ token is 401", () => {
  it("rejects an expired token with the JSON-RPC unauthorized error", async () => {
    const token = await seedToken(past());
    const res = new FakeRes();
    await makeMcp().handle(
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: INIT_BODY,
      } as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe(-32001);
  });

  it("still admits a non-expiring token (the 401 above is expiry, not a broken harness)", async () => {
    const token = await seedToken(null);
    const res = new FakeRes();
    await makeMcp().handle(
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: INIT_BODY,
      } as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).not.toBe(401);
  });
});
