import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findMany = vi.fn();
const upsert = vi.fn();
vi.mock("@naary/db", () => ({
  // #904: this spec has no renamed workflows, so the alias resolver is the identity. A spec
  // that DOES exercise aliases stubs it to return the live key (see workflow-key-alias.spec.ts).
  resolveWorkflowKey: async (_t: string, k: string) => k,
  getPrisma: () => ({
    workflowActivation: { findUnique, findMany, upsert },
  }),
}));

import { GraphsService } from "../src/graphs/graphs.service";

const svc = () => new GraphsService();

beforeEach(() => {
  findUnique.mockReset();
  findMany.mockReset();
  upsert.mockReset().mockResolvedValue(undefined);
});

describe("GraphsService activation", () => {
  it("isActive defaults to TRUE when there is no row (existing workflows keep firing)", async () => {
    findUnique.mockResolvedValue(null);
    expect(await svc().isActive("t-1", "e1", "w")).toBe(true);
  });

  it("isActive reflects an explicit deactivation row", async () => {
    findUnique.mockResolvedValue({ active: false });
    expect(await svc().isActive("t-1", "e1", "w")).toBe(false);
  });

  it("inactiveKeys returns only the explicitly-deactivated keys", async () => {
    findMany.mockResolvedValue([{ workflowKey: "a" }, { workflowKey: "b" }]);
    const set = await svc().inactiveKeys("t-1", "e1");
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(false);
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", environmentId: "e1", active: false },
      select: { workflowKey: true },
    });
  });

  it("setActive upserts the flag", async () => {
    await svc().setActive("t-1", "e1", "w", false);
    expect(upsert).toHaveBeenCalledWith({
      where: { tenantId_environmentId_workflowKey: { tenantId: "t-1", environmentId: "e1", workflowKey: "w" } },
      create: { tenantId: "t-1", environmentId: "e1", workflowKey: "w", active: false },
      update: { active: false },
    });
  });
});
