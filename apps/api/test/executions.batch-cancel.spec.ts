import { WorkflowNotFoundError } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@naary/db", () => ({ getPrisma: () => ({}) }));

import { ExecutionsService } from "../src/executions/executions.service";

/**
 * Build a service whose per-id terminate is controlled by `terminateFor(id)`. `assertOwner`
 * is stubbed (single-cancel tests exercise ownership), so we can drive one run to fail
 * (already closed → WorkflowNotFoundError) while the rest cancel.
 */
function makeService(terminateFor: (id: string) => () => Promise<void>) {
  const service = new ExecutionsService(
    {} as never,
    {
      defaultEnvId: async () => "env-test",
      resolveEnvId: async () => "env-test",
    } as never,
  );
  (service as unknown as { client: unknown }).client = {
    workflow: {
      getHandle: (id: string) => ({ terminate: terminateFor(id) }),
    },
  };
  vi.spyOn(
    service as unknown as {
      assertOwner: () => Promise<{
        tenantId: string;
        workflowKey: string | null;
        environmentId: string | null;
      }>;
    },
    "assertOwner",
  ).mockResolvedValue({
    tenantId: "t-1",
    workflowKey: null,
    environmentId: null,
  });
  return service;
}

beforeEach(() => vi.clearAllMocks());

describe("cancelBatch", () => {
  it("terminates every selected run and returns ok for each", async () => {
    const perId: Record<string, ReturnType<typeof vi.fn>> = {};
    const service = makeService((id) => {
      const t = vi.fn().mockResolvedValue(undefined);
      perId[id] = t;
      return t as unknown as () => Promise<void>;
    });

    const out = await service.cancelBatch(["wf-1", "wf-2"], "t-1");

    expect(out).toEqual([
      { workflowId: "wf-1", ok: true },
      { workflowId: "wf-2", ok: true },
    ]);
    expect(perId["wf-1"]).toHaveBeenCalledOnce();
    expect(perId["wf-2"]).toHaveBeenCalledOnce();
  });

  it("an already-finished run doesn't abort the batch — it's ok:false, others still cancel", async () => {
    const service = makeService((id) =>
      id === "wf-done"
        ? // A closed workflow → NOT_FOUND → cancel() maps to a ConflictException.
          vi.fn().mockRejectedValue(new WorkflowNotFoundError("gone", "wf", ""))
        : vi.fn().mockResolvedValue(undefined),
    );

    const out = await service.cancelBatch(
      ["wf-ok", "wf-done", "wf-ok2"],
      "t-1",
    );

    expect(out[0]).toEqual({ workflowId: "wf-ok", ok: true });
    expect(out[2]).toEqual({ workflowId: "wf-ok2", ok: true });
    expect(out[1]).toMatchObject({ workflowId: "wf-done", ok: false });
    expect(out[1].error).toMatch(/already finished/i);
  });

  it("de-dupes repeated ids so a double-selected run is terminated once", async () => {
    const perId: Record<string, ReturnType<typeof vi.fn>> = {};
    const service = makeService((id) => {
      perId[id] ??= vi.fn().mockResolvedValue(undefined);
      return perId[id] as unknown as () => Promise<void>;
    });

    const out = await service.cancelBatch(["wf-1", "wf-1"], "t-1");

    expect(out).toEqual([{ workflowId: "wf-1", ok: true }]);
    expect(perId["wf-1"]).toHaveBeenCalledOnce();
  });
});
