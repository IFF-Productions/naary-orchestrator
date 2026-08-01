import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { defaultPayloadConverter } from "@temporalio/client";

/**
 * docs/design/RESUME-FROM-FAILED-NODE.md §3–§4. The eligibility BRANCHES are covered exhaustively in
 * packages/dsl (pure); what's tested here is the service's own responsibilities, each of which is a
 * way the feature could be silently wrong rather than broken:
 *
 *   - a refusal must be a 409 with the reason, never a best-effort attempt;
 *   - the at-most-once acknowledgement must be REQUIRED, not advisory;
 *   - the run must resume against the graph it WALKED, not the latest saved version;
 *   - `stepCount` must come from the snapshot (it seeds child-workflow ids — recomputing it re-runs
 *     children that already succeeded) and `costUsd` must carry, so resume isn't a budget bypass.
 */
const findUnique = vi.fn();
const create = vi.fn();
const update = vi.fn();
vi.mock("@naary/db", () => ({
  // #904: this spec has no renamed workflows, so the alias resolver is the identity. A spec
  // that DOES exercise aliases stubs it to return the live key (see workflow-key-alias.spec.ts).
  resolveWorkflowKey: async (_t: string, k: string) => k,
  getPrisma: () => ({ execution: { findUnique, create, update } }),
  getDefaultEnvironmentId: async () => "env-test",
}));

const resolveClaimChecks = vi.fn();
vi.mock("@naary/storage", () => ({
  getObjectStore: () => ({}),
  resolveClaimChecks: (v: unknown) => resolveClaimChecks(v),
}));

vi.mock("@naary/usage", () => ({
  getBudget: async () => null,
  assertWithinMonthlyBudget: async () => {},
  assertWithinCompanyMonthlyBudget: async () => {},
}));

import { ExecutionsService } from "../src/executions/executions.service";

const GRAPH = {
  startNodeId: "email",
  nodes: [
    { id: "email", type: "sendEmail" },
    { id: "http", type: "httpRequest" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "email", to: "http" },
    { from: "http", to: "end" },
  ],
};

/** History whose started event carries [graph, input, runCtx] — what queryRunGraph reads. */
const history = {
  events: [
    {
      workflowExecutionStartedEventAttributes: {
        input: {
          payloads: [
            defaultPayloadConverter.toPayload(GRAPH),
            defaultPayloadConverter.toPayload({ orderId: 7 }),
            defaultPayloadConverter.toPayload({ tenantId: "t-1" }),
          ],
        },
      },
    },
  ],
};

const start = vi.fn();

function makeService(): ExecutionsService {
  const service = new ExecutionsService(
    {
      getErrorHandler: async () => undefined,
      isActive: async () => true,
    } as never,
    {
      defaultEnvId: async () => "env-test",
      resolveEnvId: async () => "env-test",
    } as never,
  );
  (service as unknown as { client: unknown }).client = {
    workflow: {
      getHandle: () => ({ fetchHistory: async () => history }),
      start,
    },
  };
  return service;
}

const failedRow = (over: Record<string, unknown> = {}) => ({
  workflowId: "run-1",
  tenantId: "t-1",
  workflowKey: "orders",
  environmentId: "env-test",
  status: "failed",
  failedNodeId: "http",
  executedNodeIds: ["email"],
  resumeSnapshot: { __claimCheck: "resume/t-1/abc", bytes: 12 },
  resumeStepCount: 4,
  resumeMergeArrivals: null,
  costUsd: "1.25",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveClaimChecks.mockResolvedValue({ email: { status: "ok" } });
  start.mockResolvedValue(undefined);
  create.mockResolvedValue({});
});

describe("resumeEligibility", () => {
  it("is resumable for a plain sequential failure with a snapshot", async () => {
    findUnique.mockResolvedValue(failedRow());
    const v = await makeService().resumeEligibility("run-1", "t-1");
    expect(v.resumable).toBe(true);
    expect(v.failedNodeId).toBe("http");
  });

  /** The reason has to reach the UI — a disabled button with no explanation is the failure mode. */
  it("explains a refusal instead of just saying no", async () => {
    findUnique.mockResolvedValue(failedRow({ status: "completed" }));
    const v = await makeService().resumeEligibility("run-1", "t-1");
    expect(v.resumable).toBe(false);
    expect(v.reason).toBe("not_a_failure");
    expect(v.detail).toContain("completed");
  });

  it("refuses when no snapshot was stored, naming the deployment reason", async () => {
    findUnique.mockResolvedValue(failedRow({ resumeSnapshot: null }));
    const v = await makeService().resumeEligibility("run-1", "t-1");
    expect(v.reason).toBe("snapshot_missing");
    // STORAGE_PROVIDER isn't s3 in tests, which is exactly why nothing was stored.
    expect(v.detail).toMatch(/object storage/i);
  });

  it("attaches ready-to-display text when the failing node may have taken effect", async () => {
    findUnique.mockResolvedValue(failedRow({ failedNodeId: "email" }));
    const v = await makeService().resumeEligibility("run-1", "t-1");
    expect(v.warnings).toEqual(["at_most_once_node"]);
    expect(v.warningText).toContain("sendEmail");
  });
});

describe("resume", () => {
  it("409s on an ineligible run rather than attempting it", async () => {
    findUnique.mockResolvedValue(failedRow({ status: "completed" }));
    await expect(makeService().resume("run-1", "t-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(start).not.toHaveBeenCalled();
  });

  /** The acknowledgement is REQUIRED, not advisory — this is the duplicate-side-effect guard. */
  it("400s on an at-most-once node without acknowledgeSideEffects, then proceeds with it", async () => {
    findUnique.mockResolvedValue(failedRow({ failedNodeId: "email" }));
    const svc = makeService();
    await expect(svc.resume("run-1", "t-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(start).not.toHaveBeenCalled();

    await svc.resume("run-1", "t-1", { acknowledgeSideEffects: true });
    expect(start).toHaveBeenCalledOnce();
  });

  it("starts at the failed node, seeded with the rehydrated ctx", async () => {
    findUnique.mockResolvedValue(failedRow());
    await makeService().resume("run-1", "t-1");
    const args = start.mock.calls[0][1].args;
    // arg 0 is the graph the run WALKED (recovered from history), not the latest version.
    expect(args[0]).toMatchObject({ startNodeId: "email" });
    const resume = args[3];
    expect(resume.startNodeId).toBe("http");
    expect(resume.ctx).toEqual({ email: { status: "ok" } });
    // Snapshotted, never recomputed: it seeds child-workflow ids.
    expect(resume.stepCount).toBe(4);
    // Carried so a resume can't hand the run a fresh budget allowance.
    expect(resume.costUsd).toBe(1.25);
    // The snapshot may predate $vars, which the interpreter skips for any resume by default.
    expect(resume.reseedVars).toBe(true);
  });

  /**
   * A debug run must RESUME as a debug run — resuming the node that died is exactly when the
   * verbose logs and the per-node debug rows are wanted. The snapshot's own `__debug` marker (the
   * interpreter stamps it into ctx, and the ctx is snapshotted verbatim) is what carries it.
   */
  it("inherits the original run's debug flag from the snapshot", async () => {
    findUnique.mockResolvedValue(failedRow());
    resolveClaimChecks.mockResolvedValue({
      email: { status: "ok" },
      __debug: true,
    });
    await makeService().resume("run-1", "t-1");
    expect(start.mock.calls[0][1].args[2]).toMatchObject({ debug: true });
  });

  /** …and an ordinary resume's workflow args stay byte-identical — nobody gets verbose logging
   *  by accident (the same rule the start/re-run paths follow). */
  it("does not add the flag when the original run wasn't a debug run", async () => {
    findUnique.mockResolvedValue(failedRow());
    await makeService().resume("run-1", "t-1");
    expect(start.mock.calls[0][1].args[2]).not.toHaveProperty("debug");
  });

  it("records lineage on the new run", async () => {
    findUnique.mockResolvedValue(failedRow());
    await makeService().resume("run-1", "t-1");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resumedFromId: "run-1" }),
      }),
    );
  });

  /**
   * A non-null reference can still 404 — the bucket lifecycle expires it — and that can only be
   * discovered here. It must be a 409 that says so, not a run against a hollow ctx.
   */
  it("409s when the snapshot has expired out of object storage", async () => {
    findUnique.mockResolvedValue(failedRow());
    resolveClaimChecks.mockRejectedValue(new Error("NoSuchKey"));
    await expect(makeService().resume("run-1", "t-1")).rejects.toThrow(
      /no longer available/i,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("409s when the snapshot resolves to something that isn't a ctx object", async () => {
    findUnique.mockResolvedValue(failedRow());
    resolveClaimChecks.mockResolvedValue("a string, somehow");
    await expect(makeService().resume("run-1", "t-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
