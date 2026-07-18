import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted prisma spies (the notifications spec pattern) — one shared fake client for the
// TagsService CRUD, the attach (replace-set) transaction, and the GraphsService.list batching.
const tagFindMany = vi.fn();
const tagFindFirst = vi.fn();
const tagCreate = vi.fn();
const tagUpdate = vi.fn();
const tagDeleteMany = vi.fn();
const wtFindMany = vi.fn();
const wtDeleteMany = vi.fn();
const wtCreateMany = vi.fn();
const graphFindMany = vi.fn();
const activationFindMany = vi.fn();
const $transaction = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    tag: {
      findMany: tagFindMany,
      findFirst: tagFindFirst,
      create: tagCreate,
      update: tagUpdate,
      deleteMany: tagDeleteMany,
    },
    workflowTag: {
      findMany: wtFindMany,
      deleteMany: wtDeleteMany,
      createMany: wtCreateMany,
    },
    graphDefinition: { findMany: graphFindMany },
    workflowActivation: { findMany: activationFindMany },
    $transaction,
  }),
}));

import { GraphsService } from "../src/graphs/graphs.service";
import { TagsService } from "../src/tags/tags.service";

const svc = new TagsService();

const tagRow = (over: Record<string, unknown> = {}) => ({
  id: "tag_1",
  tenantId: "t-1",
  name: "production",
  color: "#6366f1",
  createdAt: new Date("2026-07-29T12:00:00Z"),
  ...over,
});

beforeEach(() => {
  tagFindMany.mockReset().mockResolvedValue([]);
  tagFindFirst.mockReset().mockResolvedValue(null);
  tagCreate.mockReset();
  tagUpdate.mockReset();
  tagDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  wtFindMany.mockReset().mockResolvedValue([]);
  wtDeleteMany.mockReset().mockReturnValue("op:delete");
  wtCreateMany.mockReset().mockReturnValue("op:create");
  graphFindMany.mockReset().mockResolvedValue([]);
  activationFindMany.mockReset().mockResolvedValue([]);
  $transaction.mockReset().mockResolvedValue([]);
});

describe("TagsService.list", () => {
  it("returns the tenant's tags with usage counts, name-ordered", async () => {
    tagFindMany.mockResolvedValue([
      { ...tagRow({ id: "a", name: "billing" }), _count: { workflows: 2 } },
      {
        ...tagRow({ id: "b", name: "prod", color: null }),
        _count: { workflows: 0 },
      },
    ]);
    const out = await svc.list("t-1");
    expect(out).toEqual([
      { id: "a", name: "billing", color: "#6366f1", workflowCount: 2 },
      { id: "b", name: "prod", color: null, workflowCount: 0 },
    ]);
    // Tenant isolation + stable order come from the query.
    expect(tagFindMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "t-1" },
      orderBy: { name: "asc" },
    });
  });
});

describe("TagsService.create", () => {
  it("creates a tag (trimmed name) and returns workflowCount 0", async () => {
    tagCreate.mockResolvedValue(tagRow({ name: "prod" }));
    const out = await svc.create("t-1", "  prod  ", "#6366f1");
    expect(out.workflowCount).toBe(0);
    expect(tagCreate).toHaveBeenCalledWith({
      data: { tenantId: "t-1", name: "prod", color: "#6366f1" },
    });
    // The duplicate check is tenant-scoped.
    expect(tagFindFirst.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      name: "prod",
    });
  });

  it("defaults color to null", async () => {
    tagCreate.mockResolvedValue(tagRow({ color: null }));
    await svc.create("t-1", "prod");
    expect(tagCreate.mock.calls[0][0].data.color).toBeNull();
  });

  it("rejects an empty (or whitespace-only) name", async () => {
    await expect(svc.create("t-1", "   ")).rejects.toThrow(/must not be empty/);
    expect(tagCreate).not.toHaveBeenCalled();
  });

  it("rejects a name over 40 characters", async () => {
    await expect(svc.create("t-1", "x".repeat(41))).rejects.toThrow(
      /at most 40/,
    );
    expect(tagCreate).not.toHaveBeenCalled();
  });

  it("409s on a duplicate (tenantId, name)", async () => {
    tagFindFirst.mockResolvedValue({ id: "tag_existing" });
    await expect(svc.create("t-1", "prod")).rejects.toThrow(/already exists/);
    expect(tagCreate).not.toHaveBeenCalled();
  });
});

describe("TagsService.update", () => {
  it("404s for another tenant's (or unknown) tag id — scoped existence check first", async () => {
    tagFindFirst.mockResolvedValue(null);
    await expect(
      svc.update("t-1", "tag_other", { name: "new" }),
    ).rejects.toThrow(/Unknown tag/);
    expect(tagFindFirst.mock.calls[0][0].where).toEqual({
      id: "tag_other",
      tenantId: "t-1",
    });
    expect(tagUpdate).not.toHaveBeenCalled();
  });

  it("409s when renaming onto an existing name (excluding itself)", async () => {
    tagFindFirst
      .mockResolvedValueOnce({ id: "tag_1" }) // existence
      .mockResolvedValueOnce({ id: "tag_2" }); // collision
    await expect(svc.update("t-1", "tag_1", { name: "prod" })).rejects.toThrow(
      /already exists/,
    );
    expect(tagFindFirst.mock.calls[1][0].where).toEqual({
      tenantId: "t-1",
      name: "prod",
      NOT: { id: "tag_1" },
    });
    expect(tagUpdate).not.toHaveBeenCalled();
  });

  it("patches name/color after the checks pass", async () => {
    tagFindFirst
      .mockResolvedValueOnce({ id: "tag_1" })
      .mockResolvedValueOnce(null);
    tagUpdate.mockResolvedValue(tagRow({ name: "prod", color: "#0ea5e9" }));
    const out = await svc.update("t-1", "tag_1", {
      name: " prod ",
      color: "#0ea5e9",
    });
    expect(out).toEqual({ id: "tag_1", name: "prod", color: "#0ea5e9" });
    expect(tagUpdate).toHaveBeenCalledWith({
      where: { id: "tag_1" },
      data: { name: "prod", color: "#0ea5e9" },
    });
  });

  it("recolors without a rename (no collision query)", async () => {
    tagFindFirst.mockResolvedValueOnce({ id: "tag_1" });
    tagUpdate.mockResolvedValue(tagRow());
    await svc.update("t-1", "tag_1", { color: "#0ea5e9" });
    expect(tagFindFirst).toHaveBeenCalledTimes(1);
  });
});

describe("TagsService.remove", () => {
  it("deletes tenant-scoped and is idempotent", async () => {
    await svc.remove("t-1", "tag_1");
    await svc.remove("t-1", "tag_1"); // second call: count 0, still no throw
    expect(tagDeleteMany).toHaveBeenCalledWith({
      where: { id: "tag_1", tenantId: "t-1" },
    });
  });
});

describe("TagsService.setWorkflowTags (replace-set)", () => {
  it("validates ownership, then deletes-and-creates in ONE transaction", async () => {
    tagFindMany.mockResolvedValue([
      { id: "tag_2", name: "b", color: null },
      { id: "tag_1", name: "a", color: "#6366f1" },
    ]);
    const out = await svc.setWorkflowTags("t-1", "wf-1", ["tag_1", "tag_2"]);
    // Ownership check is tenant-scoped over exactly the requested ids.
    expect(tagFindMany.mock.calls[0][0].where).toEqual({
      id: { in: ["tag_1", "tag_2"] },
      tenantId: "t-1",
    });
    // Replace-set: delete the key's rows, then create the new set — atomically.
    expect(wtDeleteMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", workflowKey: "wf-1" },
    });
    expect(wtCreateMany).toHaveBeenCalledWith({
      data: [
        { tagId: "tag_1", tenantId: "t-1", workflowKey: "wf-1" },
        { tagId: "tag_2", tenantId: "t-1", workflowKey: "wf-1" },
      ],
    });
    expect($transaction).toHaveBeenCalledWith(["op:delete", "op:create"]);
    // Response preserves the caller's order (not the DB's).
    expect(out.map((t) => t.id)).toEqual(["tag_1", "tag_2"]);
  });

  it("400s when ANY id belongs to another tenant — BEFORE writing", async () => {
    tagFindMany.mockResolvedValue([{ id: "tag_1", name: "a", color: null }]);
    await expect(
      svc.setWorkflowTags("t-1", "wf-1", ["tag_1", "tag_foreign"]),
    ).rejects.toThrow(/unknown for this workspace/);
    expect(wtDeleteMany).not.toHaveBeenCalled();
    expect(wtCreateMany).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("dedupes repeated ids", async () => {
    tagFindMany.mockResolvedValue([{ id: "tag_1", name: "a", color: null }]);
    await svc.setWorkflowTags("t-1", "wf-1", ["tag_1", "tag_1"]);
    expect(wtCreateMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it("an empty array clears all tags (no ownership query needed)", async () => {
    const out = await svc.setWorkflowTags("t-1", "wf-1", []);
    expect(out).toEqual([]);
    expect(tagFindMany).not.toHaveBeenCalled();
    expect(wtDeleteMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", workflowKey: "wf-1" },
    });
    expect(wtCreateMany).toHaveBeenCalledWith({ data: [] });
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});

describe("GraphsService.list tags", () => {
  const graphRow = (workflowKey: string, version: number) => ({
    workflowKey,
    name: workflowKey,
    version,
    createdAt: new Date("2026-07-29T12:00:00Z"),
  });

  it("attaches tags via ONE batched query; workflows without tags get []", async () => {
    graphFindMany.mockResolvedValue([
      graphRow("wf-a", 2),
      graphRow("wf-a", 1), // older version of the same key — only the latest survives
      graphRow("wf-b", 1),
    ]);
    wtFindMany.mockResolvedValue([
      {
        workflowKey: "wf-a",
        tag: { id: "tag_1", name: "billing", color: "#6366f1" },
      },
      {
        workflowKey: "wf-a",
        tag: { id: "tag_2", name: "prod", color: null },
      },
    ]);
    const out = await new GraphsService().list("t-1", "e-1");
    // ONE batched lookup over exactly the listed keys — no per-row N+1.
    expect(wtFindMany).toHaveBeenCalledTimes(1);
    expect(wtFindMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "t-1", workflowKey: { in: ["wf-a", "wf-b"] } },
      include: { tag: true },
    });
    const byKey = new Map(out.map((g) => [g.workflowKey, g]));
    expect(byKey.get("wf-a")?.tags).toEqual([
      { id: "tag_1", name: "billing", color: "#6366f1" },
      { id: "tag_2", name: "prod", color: null },
    ]);
    expect(byKey.get("wf-b")?.tags).toEqual([]);
  });

  it("skips the tag query entirely when the tenant has no workflows", async () => {
    graphFindMany.mockResolvedValue([]);
    const out = await new GraphsService().list("t-1", "e-1");
    expect(out).toEqual([]);
    expect(wtFindMany).not.toHaveBeenCalled();
  });
});
