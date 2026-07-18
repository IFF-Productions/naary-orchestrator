import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

// listPage: keyset pagination over the Execution read-model — findMany with a
// (createdAt, workflowId) keyset filter + tiebroken orderBy, probing take+1 rows.
const findMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ execution: { findMany } }),
}));

import { ExecutionsService } from "../src/executions/executions.service";

function makeService(): ExecutionsService {
  const service = new ExecutionsService(
    {} as never,
    {
      defaultEnvId: async () => "env-test",
      resolveEnvId: async () => "env-test",
    } as never,
  );
  // Terminal rows need no Temporal calls; a bare client is fine.
  (service as unknown as { client: unknown }).client = { workflow: {} };
  return service;
}

function row(workflowId: string, createdAt: string) {
  return {
    workflowId,
    tenantId: "t-1",
    workflowKey: "wk",
    status: "completed", // terminal → no Temporal reconcile
    costUsd: null,
    createdAt: new Date(createdAt),
    archivedAt: null,
    graphVersion: null,
  };
}

beforeEach(() => {
  findMany.mockReset();
});

describe("listPage", () => {
  it("first page: plain tenant filter, tiebroken DESC order, take = limit + 1 probe", async () => {
    findMany.mockResolvedValue([row("wf-1", "2026-07-02T00:00:00Z")]);

    const out = await makeService().listPage("t-1", { limit: 2 });

    expect(findMany.mock.calls[0][0]).toEqual({
      where: { tenantId: "t-1", archivedAt: null },
      orderBy: [{ createdAt: "desc" }, { workflowId: "desc" }],
      take: 3, // limit + 1 — the extra row is the next-page probe
    });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].workflowId).toBe("wf-1");
    expect(out.nextCursor).toBeNull(); // fewer rows than the probe → no next page
  });

  it("emits nextCursor when a probe row exists, and drops the probe from items", async () => {
    findMany.mockResolvedValue([
      row("wf-3", "2026-07-03T00:00:00Z"),
      row("wf-2", "2026-07-02T00:00:00Z"),
      row("wf-1", "2026-07-01T00:00:00Z"), // the take+1 probe — not part of this page
    ]);

    const out = await makeService().listPage("t-1", { limit: 2 });

    expect(out.items.map((i) => i.workflowId)).toEqual(["wf-3", "wf-2"]);
    expect(out.nextCursor).not.toBeNull();
    // The cursor encodes the LAST RETURNED row's sort key (wf-2), not the probe's.
    const decoded = JSON.parse(
      Buffer.from(out.nextCursor as string, "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ t: "2026-07-02T00:00:00.000Z", id: "wf-2" });
  });

  it("a cursor round-trips into the keyset filter (strictly-after in DESC order)", async () => {
    // Page 1 produces the cursor…
    findMany.mockResolvedValue([
      row("wf-3", "2026-07-03T00:00:00Z"),
      row("wf-2", "2026-07-02T00:00:00Z"),
    ]);
    const page1 = await makeService().listPage("t-1", { limit: 1 });
    expect(page1.nextCursor).not.toBeNull();

    // …page 2 turns it into (createdAt < t) OR (createdAt = t AND workflowId < id).
    findMany.mockClear().mockResolvedValue([]);
    await makeService().listPage("t-1", {
      limit: 1,
      cursor: page1.nextCursor as string,
    });
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      archivedAt: null,
      OR: [
        { createdAt: { lt: new Date("2026-07-03T00:00:00.000Z") } },
        {
          createdAt: new Date("2026-07-03T00:00:00.000Z"),
          workflowId: { lt: "wf-3" },
        },
      ],
    });
  });

  it("keeps the archived filter alongside the keyset filter", async () => {
    findMany.mockResolvedValue([]);
    const cursor = Buffer.from(
      JSON.stringify({ t: "2026-07-01T00:00:00.000Z", id: "wf-9" }),
      "utf8",
    ).toString("base64url");

    await makeService().listPage("t-1", { archived: true, cursor });

    expect(findMany.mock.calls[0][0].where.archivedAt).toEqual({ not: null });
    expect(findMany.mock.calls[0][0].where.OR).toHaveLength(2);
  });

  it("clamps limit into 1..100 (garbage never reaches take)", async () => {
    findMany.mockResolvedValue([]);
    await makeService().listPage("t-1", { limit: 1000 });
    expect(findMany.mock.calls[0][0].take).toBe(101);
    findMany.mockClear().mockResolvedValue([]);
    await makeService().listPage("t-1", { limit: -5 });
    expect(findMany.mock.calls[0][0].take).toBe(2);
  });

  it("rejects a malformed cursor with 400 before any DB read", async () => {
    await expect(
      makeService().listPage("t-1", { cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Structured but wrong: valid base64url JSON with a garbage timestamp.
    const bad = Buffer.from(
      JSON.stringify({ t: "yesterday-ish", id: "wf-1" }),
      "utf8",
    ).toString("base64url");
    await expect(
      makeService().listPage("t-1", { cursor: bad }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("legacy list() keeps its shape (RunSummary[]) via the same page path", async () => {
    findMany.mockResolvedValue([row("wf-1", "2026-07-01T00:00:00Z")]);
    const out = await makeService().list("t-1");
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).toMatchObject({ workflowId: "wf-1", status: "completed" });
  });
});
