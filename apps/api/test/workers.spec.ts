import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { WorkersController } from "../src/workers/workers.controller";
import {
  WORKER_STALE_MS,
  toWorkerResponse,
} from "../src/workers/workers.service";

const row = (lastSeen: Date) => ({
  identity: "host-a/12/v0.0.10",
  host: "host-a",
  version: "v0.0.10",
  taskQueue: "orchestrator",
  activeActivities: 3,
  maxActivities: 100,
  lastSeen,
});

describe("toWorkerResponse", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");

  it("maps the fields + live slot usage and marks a recent beat online", () => {
    const out = toWorkerResponse(row(new Date(now - 5_000)), now);
    expect(out).toEqual({
      identity: "host-a/12/v0.0.10",
      host: "host-a",
      version: "v0.0.10",
      taskQueue: "orchestrator",
      activeActivities: 3,
      maxActivities: 100,
      online: true,
      lastSeen: new Date(now - 5_000).toISOString(),
    });
  });

  it("marks a replica offline once lastSeen exceeds the staleness window", () => {
    expect(
      toWorkerResponse(row(new Date(now - WORKER_STALE_MS - 1)), now).online,
    ).toBe(false);
    expect(
      toWorkerResponse(row(new Date(now - WORKER_STALE_MS + 1)), now).online,
    ).toBe(true);
  });
});

/**
 * The gate CHANGED (deliberately): workspace role no longer grants access — a platform operator does.
 *
 * The old check was `principal.role === "owner" | "admin"`, i.e. the caller's role in their OWN
 * workspace. In self-serve SaaS everyone who signs up owns one, so it admitted every customer to the
 * whole global fleet: hostnames, PIDs, worker versions and live slot counts. These tests assert the new
 * contract, including that the previously-passing owner case now 403s.
 */
describe("WorkersController (platform operators only)", () => {
  const OPERATOR = "ops@acme.io";

  /** The env is read at call time, so set/restore around each case rather than mocking the module. */
  function withOperators<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.PLATFORM_OPERATORS;
    if (value === undefined) delete process.env.PLATFORM_OPERATORS;
    else process.env.PLATFORM_OPERATORS = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_OPERATORS;
      else process.env.PLATFORM_OPERATORS = prev;
    }
  }

  it("returns the fleet for a listed operator", async () => {
    const service = { list: vi.fn().mockResolvedValue([{ identity: "w1" }]) };
    const ctrl = new WorkersController(service as never);
    await withOperators(OPERATOR, async () => {
      const out = await ctrl.list({
        tenantId: "t",
        role: "member",
        email: OPERATOR,
      } as never);
      expect(out).toEqual([{ identity: "w1" }]);
    });
    expect(service.list).toHaveBeenCalledOnce();
  });

  /**
   * The regression this exists to prevent. An owner used to see the whole fleet; now they don't unless
   * they're also a named operator.
   */
  it("403s a workspace OWNER who is not a listed operator", async () => {
    const service = { list: vi.fn() };
    const ctrl = new WorkersController(service as never);
    await withOperators(OPERATOR, async () => {
      await expect(
        ctrl.list({
          tenantId: "t",
          role: "owner",
          email: "customer@example.com",
        } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    expect(service.list).not.toHaveBeenCalled();
  });

  /** FAIL CLOSED: with nothing configured, nobody gets in — not even an owner. */
  it("403s everyone when PLATFORM_OPERATORS is unset", async () => {
    const service = { list: vi.fn() };
    const ctrl = new WorkersController(service as never);
    await withOperators(undefined, async () => {
      for (const role of ["owner", "admin", "member"]) {
        await expect(
          ctrl.list({ tenantId: "t", role, email: OPERATOR } as never),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
    });
    expect(service.list).not.toHaveBeenCalled();
  });

  /** API tokens carry no email, so they can never be operators — even stamped `owner`. */
  it("403s an API-token principal", async () => {
    const service = { list: vi.fn() };
    const ctrl = new WorkersController(service as never);
    await withOperators(OPERATOR, async () => {
      await expect(
        ctrl.list({ tenantId: "t", role: "owner" } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    expect(service.list).not.toHaveBeenCalled();
  });
});
