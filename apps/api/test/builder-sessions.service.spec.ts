import { NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const builderSession = {
  create: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
};
const builderTurn = { create: vi.fn() };
// $transaction runs the callback with a tx client exposing the same models.
const tx = { builderSession, builderTurn };
const $transaction = vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx));

vi.mock("@naary/db", () => ({
  getPrisma: () => ({ builderSession, builderTurn, $transaction }),
  // Minimal Prisma.Decimal stub — records the value + supports toNumber() for round-trips.
  Prisma: {
    Decimal: class {
      constructor(public value: string) {}
      toNumber() {
        return Number(this.value);
      }
    },
  },
}));

import { BuilderSessionsService } from "../src/builder/builder-sessions.service";

// `getLatestNamed`, not `getLatest`: the ACTOR-AWARE accessor, which applies the same
// per-workflow view grant as `GET /graphs/:workflowKey`. Seeding used the system-context
// `getLatest` while nothing in the UI could pass a workflowKey; "Edit with AI" reaches it, so an
// unchecked read would disclose a workflow the member cannot open.
const getLatestNamed = vi.fn();
const graphs = {
  getLatestNamed,
} as unknown as import("../src/graphs/graphs.service").GraphsService;
const svc = new BuilderSessionsService(graphs);

const NOW = new Date("2026-08-02T14:00:00.000Z");

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: "s-1",
    status: "open",
    closedReason: null,
    workflowKey: null,
    environmentId: "env-prod",
    title: null,
    currentGraph: null,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    turns: [],
    ...over,
  };
}

beforeEach(() => {
  for (const m of [
    builderSession.create,
    builderSession.findFirst,
    builderSession.findMany,
    builderSession.updateMany,
    builderTurn.create,
    $transaction,
    getLatestNamed,
  ])
    m.mockReset();
  // Default: $transaction re-invokes the callback with the tx client.
  $transaction.mockImplementation(async (cb) => cb(tx));
});

describe("BuilderSessionsService.open", () => {
  it("passes the ACTOR through when seeding, so a view grant is enforced", async () => {
    // The security property, asserted directly: an unchecked read here would stream back a
    // workflow the member cannot open in a grant-enforcing workspace. If someone swaps this for
    // the system-context `getLatest` again, this fails.
    getLatestNamed.mockResolvedValue({ graph: { nodes: [], edges: [] } });
    builderSession.create.mockResolvedValue(sessionRow({ workflowKey: "wf-1" }));
    const actor = { userId: "u-1" } as never;
    await svc.open("t-1", "e-1", { workflowKey: "wf-1" }, actor);
    expect(getLatestNamed).toHaveBeenCalledWith("t-1", "e-1", "wf-1", actor);
  });

  it("opens a blank session (no workflowKey → null draft, no graph lookup)", async () => {
    builderSession.create.mockResolvedValue(sessionRow());

    const out = await svc.open("t-1", "env-prod", {});

    expect(getLatestNamed).not.toHaveBeenCalled();
    expect(builderSession.create).toHaveBeenCalledWith({
      data: {
        tenantId: "t-1",
        environmentId: "env-prod",
        workflowKey: null,
        title: null,
        currentGraph: undefined,
      },
      include: { turns: { orderBy: { createdAt: "asc" } } },
    });
    expect(out.status).toBe("open");
    expect(out.currentGraph).toBeNull();
    expect(out.turns).toEqual([]);
  });

  it("seeds the working draft from the named workflow's latest graph", async () => {
    const graph = { nodes: [{ id: "n1" }], edges: [] };
    getLatestNamed.mockResolvedValue({ graph, contentHash: "h", version: 3 });
    builderSession.create.mockResolvedValue(
      sessionRow({ workflowKey: "onboarding", currentGraph: graph }),
    );

    const out = await svc.open("t-1", "env-prod", {
      workflowKey: "  onboarding  ",
      title: "  Onboarding build  ",
    });

    // Seeds from the SAME tenant + environment (a prod build seeds the prod graph).
    // 4th arg `undefined`: this call passes no actor, and GraphsService treats a missing
    // actor as an internal/trigger caller that is never grant-checked (assertActor). Asserted
    // explicitly so the actor position can't be dropped from the call without a failure.
    expect(getLatestNamed).toHaveBeenCalledWith(
      "t-1",
      "env-prod",
      "onboarding",
      undefined,
    );
    expect(builderSession.create).toHaveBeenCalledWith({
      data: {
        tenantId: "t-1",
        environmentId: "env-prod",
        workflowKey: "onboarding", // trimmed
        title: "Onboarding build", // trimmed
        currentGraph: graph,
      },
      include: { turns: { orderBy: { createdAt: "asc" } } },
    });
    expect(out.currentGraph).toEqual(graph);
  });

  it("seeds a null draft when the named workflow has no graph yet", async () => {
    getLatestNamed.mockResolvedValue(null);
    builderSession.create.mockResolvedValue(
      sessionRow({ workflowKey: "empty" }),
    );

    await svc.open("t-1", "env-prod", { workflowKey: "empty" });

    expect(builderSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentGraph: undefined }),
      }),
    );
  });
});

describe("BuilderSessionsService.get — tenant-scoped", () => {
  it("returns the session with turns, mapped", async () => {
    builderSession.findFirst.mockResolvedValue(
      sessionRow({
        turns: [
          {
            id: "turn-1",
            role: "user",
            content: "Add Slack",
            costUsd: null,
            createdAt: NOW,
          },
          {
            id: "turn-2",
            role: "assistant",
            content: "Added a Slack node",
            costUsd: { toNumber: () => 0.0123 },
            options: ["Add an approval step", "Looks good — save it"],
            createdAt: NOW,
          },
        ],
      }),
    );

    const out = await svc.get("t-1", "s-1");

    expect(builderSession.findFirst).toHaveBeenCalledWith({
      where: { id: "s-1", tenantId: "t-1" },
      include: { turns: { orderBy: { createdAt: "asc" } } },
    });
    expect(out.turns).toHaveLength(2);
    expect(out.turns[1].costUsd).toBe(0.0123);
    expect(out.turns[0].costUsd).toBeNull();
    // Assistant-turn quick-reply options flow through the mapper (#487); user turn defaults to [].
    expect(out.turns[1].options).toEqual([
      "Add an approval step",
      "Looks good — save it",
    ]);
    expect(out.turns[0].options).toEqual([]);
  });

  it("404s when the id isn't this workspace's (no cross-tenant read)", async () => {
    builderSession.findFirst.mockResolvedValue(null);
    await expect(svc.get("t-1", "s-other")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("BuilderSessionsService.close — idempotent, first-close-wins", () => {
  it("closes an open session with the reason + timestamp", async () => {
    builderSession.findFirst
      .mockResolvedValueOnce({ id: "s-1", status: "open" }) // scope check
      .mockResolvedValueOnce(
        sessionRow({ status: "closed", closedReason: "done", closedAt: NOW }),
      ); // reload via get()
    builderSession.updateMany.mockResolvedValue({ count: 1 });

    const out = await svc.close("t-1", "s-1", "done");

    expect(builderSession.updateMany).toHaveBeenCalledWith({
      where: { id: "s-1", tenantId: "t-1", status: { not: "closed" } },
      data: expect.objectContaining({ status: "closed", closedReason: "done" }),
    });
    expect(out.status).toBe("closed");
    expect(out.closedReason).toBe("done");
  });

  it("is a no-op write when already closed (does not overwrite the reason)", async () => {
    builderSession.findFirst
      .mockResolvedValueOnce({ id: "s-1", status: "closed" }) // scope check
      .mockResolvedValueOnce(
        sessionRow({ status: "closed", closedReason: "saved", closedAt: NOW }),
      );

    const out = await svc.close("t-1", "s-1", "done");

    // First close (saved) wins — no second write.
    expect(builderSession.updateMany).not.toHaveBeenCalled();
    expect(out.closedReason).toBe("saved");
  });

  it("404s (no write) for a cross-tenant id", async () => {
    builderSession.findFirst.mockResolvedValueOnce(null);
    await expect(svc.close("t-1", "s-other", "done")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(builderSession.updateMany).not.toHaveBeenCalled();
  });
});

describe("BuilderSessionsService.listOpen", () => {
  it("returns open sessions only, most-recently-touched first, without graph/turns", async () => {
    builderSession.findMany.mockResolvedValue([
      {
        id: "s-2",
        status: "open",
        workflowKey: "b",
        title: "B",
        updatedAt: NOW,
      },
    ]);

    const out = await svc.listOpen("t-1", "env-prod");

    expect(builderSession.findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", environmentId: "env-prod", status: "open" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        workflowKey: true,
        title: true,
        updatedAt: true,
      },
    });
    expect(out).toEqual([
      {
        id: "s-2",
        status: "open",
        workflowKey: "b",
        title: "B",
        updatedAt: NOW.toISOString(),
      },
    ]);
  });
});

describe("BuilderSessionsService.getForTurn — lean, tenant-scoped", () => {
  it("returns status + draft + env + title (no turns)", async () => {
    const graph = { startNodeId: "n1", nodes: [{ id: "n1" }], edges: [] };
    builderSession.findFirst.mockResolvedValue({
      id: "s-1",
      status: "open",
      environmentId: "env-prod",
      title: null,
      currentGraph: graph,
    });

    const out = await svc.getForTurn("t-1", "s-1");

    expect(builderSession.findFirst).toHaveBeenCalledWith({
      where: { id: "s-1", tenantId: "t-1" },
      select: {
        id: true,
        status: true,
        environmentId: true,
        title: true,
        currentGraph: true,
      },
    });
    expect(out).toEqual({
      id: "s-1",
      status: "open",
      environmentId: "env-prod",
      title: null,
      currentGraph: graph,
    });
  });

  it("404s for a cross-tenant id", async () => {
    builderSession.findFirst.mockResolvedValue(null);
    await expect(svc.getForTurn("t-1", "s-other")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("BuilderSessionsService.applyTurn — atomic, status-guarded", () => {
  const graph = { startNodeId: "n1", nodes: [{ id: "n1" }], edges: [] };

  it("writes the draft + both turns in one transaction (title set when unset)", async () => {
    builderSession.updateMany.mockResolvedValue({ count: 1 });

    await svc.applyTurn("t-1", "s-1", {
      userMessage: "Add Slack",
      graph: graph as never,
      assistantSummary: "Updated — 1 node, 0 edges.",
      options: ["Add an approval step", "Looks good — save it"],
      costUsd: 0.0123,
      titleIfUnset: "Add Slack",
    });

    expect($transaction).toHaveBeenCalledTimes(1);
    // Draft updated only for an OPEN session (the drop-guard).
    expect(builderSession.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "s-1", tenantId: "t-1", status: "open" },
      data: { currentGraph: graph },
    });
    // Title set via a SEPARATE guard on `title: null` so a concurrent first turn can't clobber it.
    expect(builderSession.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "s-1", tenantId: "t-1", title: null },
      data: { title: "Add Slack" },
    });
    // User turn then assistant turn (with a Decimal cost). The user turn carries NO options.
    expect(builderTurn.create).toHaveBeenCalledTimes(2);
    expect(builderTurn.create).toHaveBeenNthCalledWith(1, {
      data: { sessionId: "s-1", role: "user", content: "Add Slack" },
    });
    const assistant = builderTurn.create.mock.calls[1][0];
    expect(assistant.data.role).toBe("assistant");
    expect(assistant.data.content).toBe("Updated — 1 node, 0 edges.");
    // Quick-reply options ride ONLY on the assistant turn (#487).
    expect(assistant.data.options).toEqual([
      "Add an approval step",
      "Looks good — save it",
    ]);
    expect(assistant.data.costUsd.toNumber()).toBeCloseTo(0.0123, 6);
  });

  it("omits the title when already set (titleIfUnset undefined)", async () => {
    builderSession.updateMany.mockResolvedValue({ count: 1 });

    await svc.applyTurn("t-1", "s-1", {
      userMessage: "tweak",
      graph: graph as never,
      assistantSummary: "…",
      options: [],
      costUsd: 0.01,
    });

    expect(builderSession.updateMany).toHaveBeenCalledTimes(1); // no separate title update
    expect(builderSession.updateMany).toHaveBeenCalledWith({
      where: { id: "s-1", tenantId: "t-1", status: "open" },
      data: { currentGraph: graph }, // no title key
    });
  });

  it("drops the turn (writes NO turns) when the session closed mid-stream", async () => {
    builderSession.updateMany.mockResolvedValue({ count: 0 }); // status guard matched nothing

    await svc.applyTurn("t-1", "s-1", {
      userMessage: "late",
      graph: graph as never,
      assistantSummary: "…",
      options: [],
      costUsd: 0.01,
    });

    expect(builderTurn.create).not.toHaveBeenCalled();
  });
});
