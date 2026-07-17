import { beforeEach, describe, expect, it, vi } from "vitest";
import { V1RunsController, parseLimit } from "../src/v1/v1-runs.controller";

describe("parseLimit (public ?limit= coercion)", () => {
  it("defaults to 50 for missing/blank/garbage/non-integer", () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("")).toBe(50);
    expect(parseLimit("abc")).toBe(50);
    expect(parseLimit("10.5")).toBe(50); // non-integer → default, never a float into `take`
    expect(parseLimit("NaN")).toBe(50);
  });
  it("clamps integers into 1..100", () => {
    expect(parseLimit("10")).toBe(10);
    expect(parseLimit("0")).toBe(1); // zero → 1 (never an empty/again-defaulted page)
    expect(parseLimit("-1")).toBe(1); // negative → 1
    expect(parseLimit("1000")).toBe(100); // over cap → 100
  });
});

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
  cancel: vi.fn(),
  rerun: vi.fn(),
  approve: vi.fn(),
  listAwaiting: vi.fn(),
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

describe("V1RunsController.cancel", () => {
  it("delegates to ExecutionsService.cancel (id, tenantId) and returns accepted", async () => {
    executions.cancel.mockResolvedValue(undefined);

    const out = await ctrl.cancel("t-1", "run-9");

    expect(executions.cancel).toHaveBeenCalledWith("run-9", "t-1");
    expect(out).toEqual({ accepted: true });
  });
});

describe("V1RunsController.rerun", () => {
  it("maps the new run's workflowId → runId and passes graphVersion through", async () => {
    executions.rerun.mockResolvedValue({ workflowId: "run-new" });

    const out = await ctrl.rerun("t-1", "run-9", { graphVersion: 3 });

    expect(executions.rerun).toHaveBeenCalledWith("run-9", "t-1", 3);
    expect(out).toEqual({ runId: "run-new" });
    expect(out).not.toHaveProperty("workflowId");
  });

  it("defaults to a bodyless re-run (graphVersion undefined → latest graph)", async () => {
    executions.rerun.mockResolvedValue({ workflowId: "run-new" });

    // The controller defaults @Body() to {} so a legacy bodyless POST still works.
    await ctrl.rerun("t-1", "run-9");

    expect(executions.rerun).toHaveBeenCalledWith("run-9", "t-1", undefined);
  });
});

describe("V1RunsController.approve", () => {
  it("passes approved + comment through in the service arg order", async () => {
    executions.approve.mockResolvedValue(undefined);

    const out = await ctrl.approve("t-1", "run-9", {
      approved: true,
      comment: "ship it",
    });

    // service signature is (id, approved, tenantId, comment) — tenantId is NOT a body arg.
    expect(executions.approve).toHaveBeenCalledWith(
      "run-9",
      true,
      "t-1",
      "ship it",
    );
    expect(out).toEqual({ accepted: true });
  });

  it("a reject is approved:false (one handler, no separate endpoint)", async () => {
    executions.approve.mockResolvedValue(undefined);

    await ctrl.approve("t-1", "run-9", { approved: false });

    expect(executions.approve).toHaveBeenCalledWith(
      "run-9",
      false,
      "t-1",
      undefined,
    );
  });
});

describe("V1RunsController.awaiting", () => {
  it("maps AwaitingApproval[] to the v1 shape (workflowId → runId)", async () => {
    executions.listAwaiting.mockResolvedValue([
      {
        workflowId: "run-7",
        workflowKey: "refunds",
        nodeId: "node-approve-1",
        title: "Approve refund?",
        instructions: "Confirm $42 refund.",
        createdAt: "2026-07-04T12:00:00.000Z",
      },
    ]);

    const out = await ctrl.awaiting("t-1");

    expect(executions.listAwaiting).toHaveBeenCalledWith("t-1");
    expect(out).toEqual([
      {
        runId: "run-7",
        workflowKey: "refunds",
        nodeId: "node-approve-1",
        title: "Approve refund?",
        instructions: "Confirm $42 refund.",
        createdAt: "2026-07-04T12:00:00.000Z",
      },
    ]);
    // The internal id name did not cross the v1 boundary (workflowId → runId).
    expect(out[0]).not.toHaveProperty("workflowId");
  });

  // ROUTE-ORDER GUARD (a real assertion, not just a comment): Nest registers routes in
  // method-declaration order (MetadataScanner walks the prototype's own property names), and
  // Express matches first-declared-wins. So `awaiting()` (GET "awaiting") MUST come before
  // `get()` (GET ":id") in the source — otherwise "awaiting" is captured as an :id and the inbox
  // route is shadowed. This fails if someone reorders the handlers.
  it("declares the literal `awaiting` route before the `:id` route", () => {
    const methods = Object.getOwnPropertyNames(V1RunsController.prototype);
    expect(methods).toContain("awaiting");
    expect(methods).toContain("get");
    expect(methods.indexOf("awaiting")).toBeLessThan(methods.indexOf("get"));
  });
});
