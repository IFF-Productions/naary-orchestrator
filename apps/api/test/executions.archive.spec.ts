import { beforeEach, describe, expect, it, vi } from "vitest";

// setArchived: assertOwner reads findUnique, then flips the flag via update.
// list: findMany with an archivedAt filter; terminal rows need no Temporal calls.
const findUnique = vi.fn();
const update = vi.fn();
const findMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ execution: { findUnique, update, findMany } }),
}));

import { ExecutionsService } from "../src/executions/executions.service";

function makeService(): ExecutionsService {
  const service = new ExecutionsService({} as never, { defaultEnvId: async () => "env-test", resolveEnvId: async () => "env-test" } as never);
  // No Temporal calls are made for terminal rows / archive writes; a bare client is fine.
  (service as unknown as { client: unknown }).client = { workflow: {} };
  return service;
}

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset().mockResolvedValue({});
  findMany.mockReset();
});

describe("setArchived", () => {
  it("archives an owned run — stamps archivedAt with a Date", async () => {
    findUnique.mockResolvedValue({ workflowId: "wf-1", tenantId: "t-1" });
    await makeService().setArchived("wf-1", "t-1", true);
    expect(update).toHaveBeenCalledWith({
      where: { workflowId: "wf-1" },
      data: { archivedAt: expect.any(Date) },
    });
  });

  it("restores an owned run — clears archivedAt to null", async () => {
    findUnique.mockResolvedValue({ workflowId: "wf-1", tenantId: "t-1" });
    await makeService().setArchived("wf-1", "t-1", false);
    expect(update).toHaveBeenCalledWith({
      where: { workflowId: "wf-1" },
      data: { archivedAt: null },
    });
  });

  it("forbids archiving a run owned by another tenant (no write)", async () => {
    findUnique.mockResolvedValue({ workflowId: "wf-1", tenantId: "other" });
    await expect(
      makeService().setArchived("wf-1", "t-1", true),
    ).rejects.toThrow(/another tenant/);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("archiveBatch", () => {
  it("archives owned runs and reports the ones that slip (per-run outcome)", async () => {
    findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        where.workflowId === "other"
          ? { workflowId: "other", tenantId: "someone-else" }
          : { workflowId: where.workflowId, tenantId: "t-1" },
      ),
    );

    const out = await makeService().archiveBatch(
      ["wf-1", "other", "wf-2"],
      "t-1",
      true,
    );

    expect(out).toEqual([
      { workflowId: "wf-1", ok: true },
      {
        workflowId: "other",
        ok: false,
        error: expect.stringContaining("another tenant"),
      },
      { workflowId: "wf-2", ok: true },
    ]);
    expect(update).toHaveBeenCalledTimes(2); // only the two owned runs were written
  });

  it("dedupes repeated ids", async () => {
    findUnique.mockResolvedValue({ workflowId: "wf-1", tenantId: "t-1" });
    const out = await makeService().archiveBatch(
      ["wf-1", "wf-1"],
      "t-1",
      false,
    );
    expect(out).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("list archived filter", () => {
  const row = {
    workflowId: "wf-1",
    tenantId: "t-1",
    workflowKey: "wk",
    status: "completed", // terminal → no Temporal reconcile
    costUsd: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
  };

  it("default view filters to active (archivedAt: null) and maps archived=false", async () => {
    findMany.mockResolvedValue([{ ...row, archivedAt: null }]);
    const out = await makeService().list("t-1");
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      archivedAt: null,
    });
    expect(out[0].archived).toBe(false);
  });

  it("archived view filters to archivedAt: {not:null} and maps archived=true", async () => {
    findMany.mockResolvedValue([
      { ...row, archivedAt: new Date("2026-07-02T00:00:00Z") },
    ]);
    const out = await makeService().list("t-1", 50, true);
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      archivedAt: { not: null },
    });
    expect(out[0].archived).toBe(true);
  });
});
