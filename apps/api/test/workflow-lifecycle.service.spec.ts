import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowLifecycleService } from "../src/graphs/workflow-lifecycle.service";

/**
 * The consolidated save/delete path shared by graphs.controller and v1-workflows.controller
 * (was duplicated inline in both — the TODO(consolidate)). Pins the two invariants the
 * controllers used to carry each:
 * - ENV-SCOPED side-effects (env-scoped-schedules slice): schedules carry the env in their
 *   identity, so save syncs THIS env's schedules and delete tears down THIS env's ids —
 *   for EVERY env, default or not (the old default-env-only gate is gone).
 * - Best-effort side-effects: a scheduling hiccup must not fail the save/delete.
 */

// #904: `liveKey` maps a retired workflow key onto the live one. Identity here — this spec has no
// renamed workflows; workflow-key-alias.spec.ts is where a non-identity resolution is exercised.
const graphs = {
  upsert: vi.fn(),
  deleteWorkflow: vi.fn(),
  liveKey: vi.fn(async (_t: string, k: string) => k),
};
const schedules = {
  syncPollSchedule: vi.fn(),
  syncCronSchedule: vi.fn(),
  syncKafkaSchedule: vi.fn(),
  teardownForWorkflow: vi.fn(),
};

const GRAPH = { nodes: [], edges: [], startNodeId: "start" } as never;

let svc: WorkflowLifecycleService;
beforeEach(() => {
  vi.clearAllMocks();
  schedules.syncPollSchedule.mockResolvedValue(undefined);
  schedules.syncCronSchedule.mockResolvedValue(undefined);
  schedules.syncKafkaSchedule.mockResolvedValue(undefined);
  schedules.teardownForWorkflow.mockResolvedValue(undefined);
  svc = new WorkflowLifecycleService(graphs as never, schedules as never);
});

describe("saveWorkflow", () => {
  it("upserts, then syncs poll+cron schedules IN THE SAVED ENV", async () => {
    graphs.upsert.mockResolvedValue({ version: 2, contentHash: "h" });

    const snap = await svc.saveWorkflow("t-1", "env-1", "k", "K", GRAPH);

    // Trailing undefined = the G1 actor param (no principal in this unit test).
    expect(graphs.upsert).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "k",
      "K",
      GRAPH,
      undefined,
      undefined, // #488 saveMessage (none)
    );
    expect(schedules.syncPollSchedule).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "k",
      GRAPH,
    );
    expect(schedules.syncCronSchedule).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "k",
      GRAPH,
    );
    expect(snap).toEqual({ version: 2, contentHash: "h" });
  });

  it("a NON-default env's save syncs THAT env's schedules (env-scoped identity — no gate)", async () => {
    graphs.upsert.mockResolvedValue({ version: 1, contentHash: "h" });

    await svc.saveWorkflow("t-1", "env-sandbox", "k", "K", GRAPH);

    // Sandbox's schedules carry sandbox's env id — prod's triggers are untouched by identity.
    expect(schedules.syncPollSchedule).toHaveBeenCalledWith(
      "t-1",
      "env-sandbox",
      "k",
      GRAPH,
    );
    expect(schedules.syncCronSchedule).toHaveBeenCalledWith(
      "t-1",
      "env-sandbox",
      "k",
      GRAPH,
    );
  });

  it("schedule sync is best-effort — a scheduling failure never fails the save", async () => {
    graphs.upsert.mockResolvedValue({ version: 1, contentHash: "h" });
    schedules.syncPollSchedule.mockRejectedValue(new Error("temporal down"));
    schedules.syncCronSchedule.mockRejectedValue(new Error("temporal down"));
    schedules.syncKafkaSchedule.mockRejectedValue(new Error("temporal down"));

    await expect(
      svc.saveWorkflow("t-1", "env-1", "k", "K", GRAPH),
    ).resolves.toEqual({ version: 1, contentHash: "h" });
  });

  it("an invalid graph fails the upsert and never touches schedules", async () => {
    graphs.upsert.mockRejectedValue(new Error("Invalid graph"));

    await expect(
      svc.saveWorkflow("t-1", "env-1", "k", "K", GRAPH),
    ).rejects.toThrow("Invalid graph");
    expect(schedules.syncPollSchedule).not.toHaveBeenCalled();
    expect(schedules.syncCronSchedule).not.toHaveBeenCalled();
  });
});

describe("deleteWorkflow", () => {
  it("tears down THIS env's schedules and deletes env-scoped (no deleteShared param)", async () => {
    graphs.deleteWorkflow.mockResolvedValue(true);

    const out = await svc.deleteWorkflow("t-1", "env-1", "k");

    expect(schedules.teardownForWorkflow).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "k",
    );
    expect(graphs.deleteWorkflow).toHaveBeenCalledWith("t-1", "env-1", "k");
    expect(out).toBe(true);
  });

  it("a NON-default env's delete tears down THAT env's ids too (gate removed)", async () => {
    graphs.deleteWorkflow.mockResolvedValue(true);

    await svc.deleteWorkflow("t-1", "env-sandbox", "k");

    expect(schedules.teardownForWorkflow).toHaveBeenCalledWith(
      "t-1",
      "env-sandbox",
      "k",
    );
    expect(graphs.deleteWorkflow).toHaveBeenCalledWith(
      "t-1",
      "env-sandbox",
      "k",
    );
  });

  it("teardown is best-effort — a Temporal failure never blocks the delete", async () => {
    schedules.teardownForWorkflow.mockRejectedValue(new Error("temporal down"));
    graphs.deleteWorkflow.mockResolvedValue(true);

    await expect(svc.deleteWorkflow("t-1", "env-1", "k")).resolves.toBe(true);
  });

  it("returns false (caller 404s) when the key doesn't exist in the env", async () => {
    graphs.deleteWorkflow.mockResolvedValue(false);
    await expect(svc.deleteWorkflow("t-1", "env-1", "gone")).resolves.toBe(
      false,
    );
  });
});

// RBAC G1: the delete gate is asserted HERE (before the teardown side effect);
// the save gate lives inside GraphsService.upsert (the actor is threaded down).
import { ForbiddenException } from "@nestjs/common";
import type { Principal } from "../src/auth/tenant.decorator";
import type { PermissionsService } from "../src/permissions/permissions.service";

describe("G1 permission gates", () => {
  const member: Principal = { tenantId: "t-1", userId: "u-1", role: "member" };

  function withPerms(assertCan: ReturnType<typeof vi.fn>) {
    return new WorkflowLifecycleService(
      graphs as never,
      schedules as never,
      { assertCan } as unknown as PermissionsService,
    );
  }

  it("saveWorkflow forwards the actor to upsert (where edit-vs-create is gated)", async () => {
    graphs.upsert.mockResolvedValue({ version: 1, contentHash: "h" });
    const s = withPerms(vi.fn());
    await s.saveWorkflow("t-1", "env-1", "k", "K", GRAPH, member);
    expect(graphs.upsert).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "k",
      "K",
      GRAPH,
      member,
      undefined, // #488 saveMessage (none)
    );
  });

  it("deleteWorkflow asserts `delete` BEFORE any teardown side effect", async () => {
    const assertCan = vi
      .fn()
      .mockRejectedValue(new ForbiddenException("no delete"));
    const s = withPerms(assertCan);
    await expect(
      s.deleteWorkflow("t-1", "env-1", "k", member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertCan).toHaveBeenCalledWith(member, "delete", "k", "env-1");
    // Denied → the Temporal teardown and the DB delete must both be untouched.
    expect(schedules.teardownForWorkflow).not.toHaveBeenCalled();
    expect(graphs.deleteWorkflow).not.toHaveBeenCalled();
  });

  it("a GRANTED member's delete proceeds through the normal path", async () => {
    const assertCan = vi.fn().mockResolvedValue(undefined);
    graphs.deleteWorkflow.mockResolvedValue(true);
    const s = withPerms(assertCan);
    await expect(s.deleteWorkflow("t-1", "env-1", "k", member)).resolves.toBe(
      true,
    );
    expect(schedules.teardownForWorkflow).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "k",
    );
  });

  it("an actor-less delete (internal caller) never consults permissions", async () => {
    const assertCan = vi.fn();
    graphs.deleteWorkflow.mockResolvedValue(true);
    const s = withPerms(assertCan);
    await s.deleteWorkflow("t-1", "env-1", "k");
    expect(assertCan).not.toHaveBeenCalled();
  });

  it("an actor WITHOUT wired permissions fails CLOSED", async () => {
    const s = new WorkflowLifecycleService(graphs as never, schedules as never);
    await expect(s.deleteWorkflow("t-1", "env-1", "k", member)).rejects.toThrow(
      /PermissionsService is not wired/,
    );
    expect(graphs.deleteWorkflow).not.toHaveBeenCalled();
  });
});
