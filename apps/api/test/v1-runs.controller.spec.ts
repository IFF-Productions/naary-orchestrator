import { beforeEach, describe, expect, it, vi } from "vitest";
import { V1RunsController } from "../src/v1/v1-runs.controller";

/**
 * The v1 runs controller is thin glue over ExecutionsService — its job is (1) call the SAME service
 * the SPA uses and (2) map the internal result into the v1-OWNED response shape. These tests pin the
 * DTO SEAM (§5): the public wire uses `runId` (not the internal `workflowId`) and never leaks
 * internal-only fields like `archived`. If someone "simplifies" by returning the internal type raw,
 * these fail.
 */

const executions = {
  start: vi.fn(),
  list: vi.fn(),
  getState: vi.fn(),
  history: vi.fn(),
};
const environments = { resolveEnvId: vi.fn() };

let ctrl: V1RunsController;
beforeEach(() => {
  vi.clearAllMocks();
  environments.resolveEnvId.mockResolvedValue("env-1");
  ctrl = new V1RunsController(executions as never, environments as never);
});

describe("V1RunsController.start", () => {
  it("resolves the env, calls ExecutionsService.start, and maps workflowId → runId", async () => {
    executions.start.mockResolvedValue({ workflowId: "run-42" });

    const out = await ctrl.start(
      "t-1",
      { workflowKey: "triage", input: { a: 1 } },
      "sandbox",
    );

    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", "sandbox");
    // tenantId from the token, resolved env id, then input + workflowKey — never a tenant arg from the body.
    expect(executions.start).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      { a: 1 },
      "triage",
    );
    expect(out).toEqual({ runId: "run-42" });
  });
});

describe("V1RunsController.list", () => {
  it("maps RunSummary[] to the v1 shape (runId, no `archived`)", async () => {
    executions.list.mockResolvedValue([
      {
        workflowId: "run-1",
        workflowKey: "triage",
        status: "completed",
        costUsd: 0.02,
        startedAt: "2026-07-04T12:00:00.000Z",
        createdAt: "2026-07-04T12:00:00.000Z",
        archived: false, // internal-only — must NOT appear in the v1 response
        graphVersion: 3,
      },
    ]);

    const out = await ctrl.list("t-1", "10");

    expect(executions.list).toHaveBeenCalledWith("t-1", 10);
    expect(out).toEqual([
      {
        runId: "run-1",
        workflowKey: "triage",
        status: "completed",
        costUsd: 0.02,
        startedAt: "2026-07-04T12:00:00.000Z",
        graphVersion: 3,
      },
    ]);
    // The internal-only field did not cross the boundary.
    expect(out[0]).not.toHaveProperty("archived");
    expect(out[0]).not.toHaveProperty("workflowId");
    expect(out[0]).not.toHaveProperty("createdAt");
  });

  it("defaults limit to 50 when absent or non-numeric", async () => {
    executions.list.mockResolvedValue([]);
    await ctrl.list("t-1", undefined);
    expect(executions.list).toHaveBeenCalledWith("t-1", 50);
    await ctrl.list("t-1", "abc");
    expect(executions.list).toHaveBeenLastCalledWith("t-1", 50);
  });
});

describe("V1RunsController.get", () => {
  it("maps RunStateView (ctx → output) and echoes the run id", async () => {
    executions.getState.mockResolvedValue({
      status: "running",
      currentNodeId: "node-3",
      ctx: { node1: { ok: true } },
    });

    const out = await ctrl.get("t-1", "run-9");

    expect(executions.getState).toHaveBeenCalledWith("run-9", "t-1");
    expect(out).toEqual({
      runId: "run-9",
      status: "running",
      currentNodeId: "node-3",
      output: { node1: { ok: true } },
    });
  });
});

describe("V1RunsController.history", () => {
  it("maps RunEvent[] to the v1 history shape", async () => {
    executions.history.mockResolvedValue([
      {
        id: 1,
        kind: "started",
        label: "start",
        at: "2026-07-04T12:00:00.000Z",
      },
      {
        id: 2,
        kind: "activity",
        label: "callHttpRequest",
        at: "2026-07-04T12:00:01.000Z",
        detail: "GET x → 200",
      },
    ]);

    const out = await ctrl.history("t-1", "run-9");

    expect(executions.history).toHaveBeenCalledWith("run-9", "t-1");
    expect(out[1]).toEqual({
      id: 2,
      kind: "activity",
      label: "callHttpRequest",
      at: "2026-07-04T12:00:01.000Z",
      detail: "GET x → 200",
    });
  });
});
