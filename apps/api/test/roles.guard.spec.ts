import "reflect-metadata";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RolesGuard } from "../src/auth/roles.guard";

const getAllAndOverride = vi.fn();

function makeGuard(): RolesGuard {
  return new RolesGuard({ getAllAndOverride } as unknown as Reflector);
}

function ctx(principal?: { role?: string }): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;
}

beforeEach(() => getAllAndOverride.mockReset());

describe("RolesGuard", () => {
  it("allows a route with no @Roles requirement", () => {
    getAllAndOverride.mockReturnValue(undefined);
    expect(makeGuard().canActivate(ctx({ role: "member" }))).toBe(true);
  });

  it("403s a member on an admin route", () => {
    getAllAndOverride.mockReturnValue("admin");
    expect(() => makeGuard().canActivate(ctx({ role: "member" }))).toThrow(
      ForbiddenException,
    );
  });

  it("allows an admin on an admin route", () => {
    getAllAndOverride.mockReturnValue("admin");
    expect(makeGuard().canActivate(ctx({ role: "admin" }))).toBe(true);
  });

  it("allows an owner on an admin route (hierarchy)", () => {
    getAllAndOverride.mockReturnValue("admin");
    expect(makeGuard().canActivate(ctx({ role: "owner" }))).toBe(true);
  });

  it("403s an owner-only route for an admin", () => {
    getAllAndOverride.mockReturnValue("owner");
    expect(() => makeGuard().canActivate(ctx({ role: "admin" }))).toThrow(
      ForbiddenException,
    );
  });

  it("403s a principal with no/unknown role on a gated route", () => {
    getAllAndOverride.mockReturnValue("admin");
    expect(() => makeGuard().canActivate(ctx({}))).toThrow(ForbiddenException);
    expect(() => makeGuard().canActivate(ctx({ role: "bogus" }))).toThrow(
      ForbiddenException,
    );
  });

  it("passes an nry_ API token (role owner) through an admin gate", () => {
    getAllAndOverride.mockReturnValue("admin");
    // AuthGuard sets role:"owner" for API tokens → full-access service token.
    expect(makeGuard().canActivate(ctx({ role: "owner" }))).toBe(true);
  });
});
