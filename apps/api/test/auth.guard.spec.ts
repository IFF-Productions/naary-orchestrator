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
import type { OidcVerifier } from "../src/auth/oidc-verifier";

const verify = vi.fn();
const oidcVerify = vi.fn();
const getAllAndOverride = vi.fn();
let oidcEnabled = false;

function makeGuard(): AuthGuard {
  const oidc = {
    get enabled() {
      return oidcEnabled;
    },
    verify: oidcVerify,
  } as unknown as OidcVerifier;
  return new AuthGuard({ verify } as unknown as ApiTokenService, oidc, {
    getAllAndOverride,
  } as unknown as Reflector);
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
  oidcVerify.mockReset();
  oidcEnabled = false;
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

  it("401s when the API token is unknown", async () => {
    verify.mockResolvedValue(null);
    await expect(
      makeGuard().canActivate(
        ctx({ headers: { authorization: "Bearer nry_nope" } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("attaches the resolved tenant as the principal on a valid API token", async () => {
    verify.mockResolvedValue("t-1");
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_good" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toEqual({ tenantId: "t-1" });
    expect(oidcVerify).not.toHaveBeenCalled();
  });

  it("401s a non-`nry_` token when OIDC is disabled (no Keycloak configured)", async () => {
    const req: FakeReq = {
      headers: { authorization: "Bearer some.jwt.token" },
    };
    await expect(makeGuard().canActivate(ctx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verify).not.toHaveBeenCalled();
    expect(oidcVerify).not.toHaveBeenCalled();
  });

  it("attaches tenant + subject from a valid Keycloak JWT when OIDC is enabled", async () => {
    oidcEnabled = true;
    oidcVerify.mockResolvedValue({ tenantId: "t-9", subject: "user-42" });
    const req: FakeReq = {
      headers: { authorization: "Bearer header.payload.sig" },
      path: "/executions",
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    expect(req.principal).toEqual({ tenantId: "t-9", subject: "user-42" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("401s when an enabled OIDC verifier rejects the JWT", async () => {
    oidcEnabled = true;
    oidcVerify.mockResolvedValue(null);
    await expect(
      makeGuard().canActivate(
        ctx({ headers: { authorization: "Bearer bad.jwt" } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("403s when a /tenants/:id path tenant differs from the token's tenant", async () => {
    verify.mockResolvedValue("t-1");
    const req: FakeReq = {
      headers: { authorization: "Bearer nry_good" },
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
      headers: { authorization: "Bearer nry_good" },
      path: "/tenants/t-1/credentials",
      params: { id: "t-1" },
    };
    await expect(makeGuard().canActivate(ctx(req))).resolves.toBe(true);
  });
});
