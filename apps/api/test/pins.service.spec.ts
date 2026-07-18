import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ pinnedData: { findMany, upsert, deleteMany } }),
  Prisma: {},
}));

import { PinsService } from "../src/pins/pins.service";

const svc = new PinsService();

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
  upsert.mockReset().mockResolvedValue({});
  deleteMany.mockReset().mockResolvedValue({ count: 0 });
});

// Slice 6b: every pin op is env-scoped — a sandbox pin must be invisible to prod.
describe("PinsService env scoping", () => {
  it("list filters by tenant + env + workflow and maps rows to {nodeId: output}", async () => {
    findMany.mockResolvedValue([
      { nodeId: "a", output: { x: 1 } },
      { nodeId: "b", output: "two" },
    ]);
    const out = await svc.list("t-1", "env-a", "wf");
    expect(out).toEqual({ a: { x: 1 }, b: "two" });
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      environmentId: "env-a",
      workflowKey: "wf",
    });
  });

  it("set upserts on the 4-part compound key and stamps env on create", async () => {
    await svc.set("t-1", "env-a", "wf", "node-1", { y: 2 });
    expect(upsert.mock.calls[0][0]).toMatchObject({
      where: {
        tenantId_environmentId_workflowKey_nodeId: {
          tenantId: "t-1",
          environmentId: "env-a",
          workflowKey: "wf",
          nodeId: "node-1",
        },
      },
      create: {
        tenantId: "t-1",
        environmentId: "env-a",
        workflowKey: "wf",
        nodeId: "node-1",
        output: { y: 2 },
      },
      update: { output: { y: 2 } },
    });
  });

  it("clear deletes env-scoped and reports whether a pin existed", async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    expect(await svc.clear("t-1", "env-a", "wf", "node-1")).toBe(true);
    expect(deleteMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      environmentId: "env-a",
      workflowKey: "wf",
      nodeId: "node-1",
    });
    deleteMany.mockResolvedValue({ count: 0 });
    expect(await svc.clear("t-1", "env-a", "wf", "node-1")).toBe(false);
  });

  it("envs are isolated: env-a and env-b produce distinct where clauses, never an env-less one", async () => {
    await svc.list("t-1", "env-a", "wf");
    await svc.list("t-1", "env-b", "wf");
    const wheres = findMany.mock.calls.map((c) => c[0].where);
    expect(wheres[0].environmentId).toBe("env-a");
    expect(wheres[1].environmentId).toBe("env-b");
    for (const w of wheres) expect(w.environmentId).toBeTruthy();
  });
});
