import "reflect-metadata";
import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTokenService } from "../src/auth/api-token.service";
import { AuthGuard } from "../src/auth/auth.guard";

const verify = vi.fn();
const getAllAndOverride = vi.fn();

function makeGuard(): AuthGuard {
  return new AuthGuard(
    { verify } as unknown as ApiTokenService,
    { getAllAndOverride } as unknown as Reflector,
  );
}

interface FakeReq {
  headers: Record<string, string | undefined>;
  params?: Record<string, string>;
  path?: string;
  principal?: { tenantId: string };
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
  getAllAndOverride.mockReset().mockReturnValue(false);
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

  it("401s when the token is unknown", async () => {
    verify.mockResolvedValue(null);
    await expect(
      makeGuard().canActivate(
        ctx({ headers: { authorization: "Bearer nope" } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("attaches the resolved tenant as the principal on a valid token", async () => {
    verify.mockResolvedValue("t-1");
    const req: FakeReq = {
      headers: { authorization: "Bearer good" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toEqual({ tenantId: "t-1" });
  });

  it("403s when a /tenants/:id path tenant differs from the token's tenant", async () => {
    verify.mockResolvedValue("t-1");
    const req: FakeReq = {
      headers: { authorization: "Bearer good" },
      path: "/tenants/t-OTHER/credentials",
      params: { id: "t-OTHER" },
    };
    await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("allows a /tenants/:id path that matches the token's tenant", async () => {
    verify.mockResolvedValue("t-1");
    const req: FakeReq = {
      headers: { authorization: "Bearer good" },
      path: "/tenants/t-1/credentials",
      params: { id: "t-1" },
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
  });
});
