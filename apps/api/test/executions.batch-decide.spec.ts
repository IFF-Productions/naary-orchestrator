import { WorkflowNotFoundError } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@naary/db", () => ({ getPrisma: () => ({}) }));

import { ExecutionsService } from "../src/executions/executions.service";

/**
 * Build a service whose per-id signal is controlled by `signalFor(id)`. `assertOwner`
 * is stubbed (ownership is exercised by the single-approve tests). This lets us drive
 * one run to fail (closed → WorkflowNotFoundError) while the rest succeed.
 */
function makeService(signalFor: (id: string) => () => Promise<void>) {
  const service = new ExecutionsService({} as never);
  (service as unknown as { client: unknown }).client = {
    workflow: {
      getHandle: (id: string) => ({ signal: signalFor(id) }),
    },
  };
  vi.spyOn(
    service as unknown as { assertOwner: () => Promise<void> },
    "assertOwner",
  ).mockResolvedValue(undefined);
  return service;
}

beforeEach(() => vi.clearAllMocks());

describe("approveBatch", () => {
  it("decides every run and returns ok for each; forwards the shared comment", async () => {
    const signals: Record<string, ReturnType<typeof vi.fn>> = {};
    const service = makeService((id) => {
      const s = vi.fn().mockResolvedValue(undefined);
      signals[id] = s;
      return s as unknown as () => Promise<void>;
    });

    const out = await service.approveBatch(
      ["wf-1", "wf-2"],
      true,
      "t-1",
      "ship them",
    );

    expect(out).toEqual([
      { workflowId: "wf-1", ok: true },
      { workflowId: "wf-2", ok: true },
    ]);
    expect(signals["wf-1"].mock.calls[0][1]).toEqual({
      approved: true,
      comment: "ship them",
    });
    expect(signals["wf-2"]).toHaveBeenCalledOnce();
  });

  it("a closed run doesn't abort the batch — it's ok:false, the others still succeed", async () => {
    const service = makeService((id) =>
      id === "wf-closed"
        ? // A CLOSED workflow → NOT_FOUND → approve() maps to a ConflictException.
          vi.fn().mockRejectedValue(new WorkflowNotFoundError("gone", "wf", ""))
        : vi.fn().mockResolvedValue(undefined),
    );

    const out = await service.approveBatch(
      ["wf-ok", "wf-closed", "wf-ok2"],
      false,
      "t-1",
    );

    expect(out[0]).toEqual({ workflowId: "wf-ok", ok: true });
    expect(out[2]).toEqual({ workflowId: "wf-ok2", ok: true });
    expect(out[1]).toMatchObject({ workflowId: "wf-closed", ok: false });
    expect(out[1].error).toMatch(/not awaiting approval/i);
  });

  it("de-dupes repeated ids so a double-selected run is signalled once", async () => {
    const perId: Record<string, ReturnType<typeof vi.fn>> = {};
    const service = makeService((id) => {
      perId[id] ??= vi.fn().mockResolvedValue(undefined);
      return perId[id] as unknown as () => Promise<void>;
    });

    const out = await service.approveBatch(["wf-1", "wf-1"], true, "t-1");

    expect(out).toEqual([{ workflowId: "wf-1", ok: true }]);
    expect(perId["wf-1"]).toHaveBeenCalledOnce();
  });
});
