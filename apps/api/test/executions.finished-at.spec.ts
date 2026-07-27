import { WorkflowNotFoundError } from "@temporalio/client";
import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn().mockResolvedValue(undefined);
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ execution: { update } }),
}));

import { accessToRunSummary } from "../src/executions/executions.access";
import { ExecutionsService } from "../src/executions/executions.service";

/**
 * #807 — a canceled or timed-out run showed no duration, forever.
 *
 * `finishedAt` was only ever written by the worker's `setExecutionStatus` activity, and a
 * `terminate()` runs NO workflow code (run-graph rethrows a cancellation before its failure path).
 * So the row kept its last synced status — usually "running", which also made it match a "running"
 * status filter — with `finishedAt` null and `durationMs` therefore null.
 *
 * Fixed on both sides: the cancel path closes the row itself, and the list's existing reconcile
 * backfills from the `describe()` it was already making.
 */

function makeService(terminate: () => Promise<void>) {
  const service = new ExecutionsService(
    {} as never,
    {
      defaultEnvId: async () => "env-test",
      resolveEnvId: async () => "env-test",
    } as never,
  );
  (service as unknown as { client: unknown }).client = {
    workflow: { getHandle: () => ({ terminate }) },
  };
  vi.spyOn(
    service as unknown as { assertOwner: () => Promise<unknown> },
    "assertOwner",
  ).mockResolvedValue({
    tenantId: "t-1",
    workflowKey: null,
    environmentId: null,
  });
  return service;
}

beforeEach(() => vi.clearAllMocks());

describe("cancel closes the read-model row", () => {
  it("stamps terminated + finishedAt after a successful terminate", async () => {
    const service = makeService(vi.fn().mockResolvedValue(undefined));

    await service.cancel("wf-1", "t-1");

    expect(update).toHaveBeenCalledOnce();
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ workflowId: "wf-1" });
    // "terminated", not "canceled": we call terminate(), so this must match what a live
    // describe() reports, or the row and the reconcile path would disagree about one run.
    expect(arg.data.status).toBe("terminated");
    expect(arg.data.finishedAt).toBeInstanceOf(Date);
  });

  it("does NOT touch the row when the run was already finished", async () => {
    const service = makeService(
      vi.fn().mockRejectedValue(new WorkflowNotFoundError("gone", "wf", "")),
    );

    await expect(service.cancel("wf-1", "t-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * The run is ALREADY terminated by the time the write runs, so a DB failure must not turn a
   * successful cancel into a 500 — the caller's retry would hit the 409 above and they'd have no
   * way to succeed. It degrades to the reconcile path, which now supplies the finish time.
   */
  it("still succeeds when the read-model write fails", async () => {
    update.mockRejectedValueOnce(new Error("pg down"));
    const service = makeService(vi.fn().mockResolvedValue(undefined));

    await expect(service.cancel("wf-1", "t-1")).resolves.toBeUndefined();
  });
});

describe("the list reconcile backfills a Temporal-only finish time", () => {
  const createdAt = new Date("2026-07-27T10:00:00Z");
  const closeTime = new Date("2026-07-27T10:00:42Z");

  const row = (finishedAt: Date | null) => ({
    workflowId: "wf-1",
    workflowKey: null,
    status: "running", // never updated — this is the stuck-row case
    costUsd: null,
    createdAt,
    finishedAt,
    failureKind: null,
    archivedAt: null,
    graphVersion: null,
  });

  const deps = (statusName: string, close?: Date) =>
    ({
      client: {
        workflow: {
          getHandle: () => ({
            describe: async () => ({
              status: { name: statusName },
              closeTime: close,
            }),
          }),
        },
      },
    }) as never;

  it("takes finishedAt from describe() when the row has none", async () => {
    const out = await accessToRunSummary(
      deps("TERMINATED", closeTime),
      row(null),
    );
    expect(out.status).toBe("terminated");
    expect(out.finishedAt).toBe(closeTime.toISOString());
    expect(out.durationMs).toBe(42_000);
  });

  it("covers a timed-out run the same way", async () => {
    const out = await accessToRunSummary(
      deps("TIMED_OUT", closeTime),
      row(null),
    );
    expect(out.status).toBe("timed_out");
    expect(out.durationMs).toBe(42_000);
  });

  /** A stamped row wins: the worker's time is the one the cost/step accounting lines up with. */
  it("never overrides a finishedAt the worker already stamped", async () => {
    const stamped = new Date("2026-07-27T10:00:05Z");
    const out = await accessToRunSummary(
      deps("TERMINATED", closeTime),
      row(stamped),
    );
    expect(out.finishedAt).toBe(stamped.toISOString());
    expect(out.durationMs).toBe(5_000);
  });

  /** A genuinely running run must not acquire a finish time from a describe() with no closeTime. */
  it("leaves a live run with no duration", async () => {
    const out = await accessToRunSummary(deps("RUNNING", undefined), row(null));
    expect(out.status).toBe("running");
    expect(out.finishedAt).toBe(null);
    expect(out.durationMs).toBe(null);
  });

  /** Clock skew between the worker/Temporal/PG must not surface as a negative duration. */
  it("clamps a finish time that precedes the start", async () => {
    const before = new Date(createdAt.getTime() - 5_000);
    const out = await accessToRunSummary(deps("TERMINATED", before), row(null));
    expect(out.durationMs).toBe(0);
  });
});
