import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial-mock @naary/usage: keep computeCost (turn-metering uses it) + everything else REAL,
// but make the budget read controllable. Defaults = no cap (gate is a no-op).
const getBudget = vi.fn();
const isOverMonthlyBudget = vi.fn();
vi.mock("@naary/usage", async (orig) => ({
  ...(await orig<typeof import("@naary/usage")>()),
  getBudget: (...a: unknown[]) => getBudget(...a),
  isOverMonthlyBudget: (...a: unknown[]) => isOverMonthlyBudget(...a),
}));

import { BuilderSessionsController } from "../src/builder/builder-sessions.controller";

// --- Fake ServerResponse: records frames; never fires 'close'. ---
function makeRes() {
  const writes: string[] = [];
  return {
    writes,
    headWritten: false,
    writableEnded: false,
    destroyed: false,
    writeHead(_code: number, _headers: unknown) {
      this.headWritten = true;
      return this;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
      return this;
    },
    on() {
      return this; // ignore 'close' — the client stays connected in tests
    },
  };
}

const EDIT_GRAPH = {
  startNodeId: "n1",
  nodes: [{ id: "n1" }, { id: "n2" }],
  edges: [{ from: "n1", to: "n2" }],
};

function makeController() {
  const sessions = {
    getForTurn: vi.fn(),
    applyTurn: vi.fn().mockResolvedValue(undefined),
  };
  const environments = {
    resolveEnvId: vi.fn().mockResolvedValue("env-fallback"),
  };
  const generator = {
    editStream: vi.fn(async (_t, _e, _edit, _p, opts) => {
      opts?.onMeta?.("My Flow");
      opts?.onNode?.({ id: "n1", type: "start" });
      opts?.onEdge?.({ from: "n1", to: "n2" });
      return {
        name: "My Flow",
        graph: EDIT_GRAPH,
        meter: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          tokens: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 },
        },
      };
    }),
  };
  const controller = new BuilderSessionsController(
    sessions as never,
    environments as never,
    generator as never,
  );
  return { controller, sessions, environments, generator };
}

beforeEach(() => {
  getBudget.mockReset().mockResolvedValue(null); // no cap → gate is a no-op
  isOverMonthlyBudget.mockReset().mockResolvedValue(false);
});

describe("POST /builder/sessions/:id/turns — edit-mode streaming", () => {
  it("threads currentGraph as `previous`, streams frames, persists + meters the turn", async () => {
    const { controller, sessions, generator } = makeController();
    const currentGraph = {
      startNodeId: "n0",
      nodes: [{ id: "n0" }],
      edges: [],
    };
    sessions.getForTurn.mockResolvedValue({
      id: "s-1",
      status: "open",
      environmentId: "env-1",
      title: null,
      currentGraph,
    });
    const res = makeRes();

    await controller.turn("t-1", "s-1", { message: "Add Slack" }, res as never);

    // Generation ran against THIS env with the current graph as `previous`.
    expect(generator.editStream).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      { previous: currentGraph, instruction: "Add Slack" },
      undefined,
      expect.any(Object),
    );
    // Frames streamed in order, ending in the authoritative result.
    const joined = res.writes.join("");
    expect(joined).toContain("event: meta");
    expect(joined).toContain("event: node");
    expect(joined).toContain("event: edge");
    expect(res.writes[res.writes.length - 1]).toContain("event: result");
    expect(res.writes[res.writes.length - 1]).toContain('"graph"');
    // Persisted atomically with a metered, non-zero cost + a title from the first message.
    expect(sessions.applyTurn).toHaveBeenCalledTimes(1);
    const applied = sessions.applyTurn.mock.calls[0][2];
    expect(applied.userMessage).toBe("Add Slack");
    expect(applied.graph).toBe(EDIT_GRAPH);
    expect(applied.assistantSummary).toBe(
      "Updated “My Flow” — 2 nodes, 1 edge.",
    );
    expect(applied.costUsd).toBeGreaterThan(0);
    // Deterministic quick-reply options attached to the turn (#487) — always the accept option,
    // plus any gap suggestions (EDIT_GRAPH is a bare 2-node/1-edge graph → all gaps present).
    expect(applied.options).toContain("Looks good — save it");
    expect(applied.options).toContain("Add an approval step");
    expect(applied.titleIfUnset).toBe("Add Slack");
    expect(res.writableEnded).toBe(true);
  });

  it("first turn on a blank session is a create (previous undefined)", async () => {
    const { controller, sessions, generator } = makeController();
    sessions.getForTurn.mockResolvedValue({
      id: "s-1",
      status: "open",
      environmentId: "env-1",
      title: null,
      currentGraph: null,
    });

    await controller.turn(
      "t-1",
      "s-1",
      { message: "Build an onboarding flow" },
      makeRes() as never,
    );

    expect(generator.editStream).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      { previous: undefined, instruction: "Build an onboarding flow" },
      undefined,
      expect.any(Object),
    );
  });

  it("keeps an existing title (titleIfUnset undefined)", async () => {
    const { controller, sessions } = makeController();
    sessions.getForTurn.mockResolvedValue({
      id: "s-1",
      status: "open",
      environmentId: "env-1",
      title: "My existing build",
      currentGraph: { startNodeId: "n0", nodes: [{ id: "n0" }], edges: [] },
    });

    await controller.turn(
      "t-1",
      "s-1",
      { message: "tweak" },
      makeRes() as never,
    );

    expect(sessions.applyTurn.mock.calls[0][2].titleIfUnset).toBeUndefined();
  });

  it("records a non-zero cost even when the provider reports NO usage (fail-safe)", async () => {
    const { controller, sessions, generator } = makeController();
    sessions.getForTurn.mockResolvedValue({
      id: "s-1",
      status: "open",
      environmentId: "env-1",
      title: "x",
      currentGraph: { startNodeId: "n0", nodes: [{ id: "n0" }], edges: [] },
    });
    generator.editStream.mockImplementation(async () => ({
      name: "My Flow",
      graph: EDIT_GRAPH,
      meter: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        tokens: null as never,
      },
    }));

    await controller.turn("t-1", "s-1", { message: "go" }, makeRes() as never);

    expect(sessions.applyTurn.mock.calls[0][2].costUsd).toBeGreaterThan(0);
  });
});

/**
 * The canvas panel owns its draft (#1003).
 *
 * The session's `currentGraph` is seeded from the SAVED workflow and rewritten by each turn's
 * result — the whole truth for the Build with AI screen, where the draft only ever exists on the
 * server. It is not the truth for the canvas: that panel is a strip under the top bar, the canvas
 * stays editable beneath it, and a node dragged or reconfigured between turns makes the stored copy
 * stale immediately. A turn built from the stale copy comes back with those hand-edits quietly
 * removed, which is #874 wearing a different hat — a valid workflow, just not one derived from what
 * the user was looking at.
 */
describe("POST /builder/sessions/:id/turns — whose graph gets edited", () => {
  it("edits the CALLER's graph when one is sent, not the session's stored draft", async () => {
    const { controller, sessions, generator } = makeController();
    // What the server last saw — two steps.
    const stored = {
      startNodeId: "n0",
      nodes: [{ id: "n0", type: "start" }],
      edges: [],
    };
    // What is actually on the canvas: the user added a step by hand since that turn.
    const onCanvas = {
      startNodeId: "n0",
      nodes: [
        { id: "n0", type: "start" },
        { id: "hand-added", type: "httpRequest" },
      ],
      edges: [{ from: "n0", to: "hand-added" }],
    };
    sessions.getForTurn.mockResolvedValue({
      id: "s-1",
      status: "open",
      environmentId: "env-1",
      title: "x",
      currentGraph: stored,
    });

    await controller.turn(
      "t-1",
      "s-1",
      { message: "Add a Slack notification", graph: onCanvas },
      makeRes() as never,
    );

    const edit = generator.editStream.mock.calls[0][2];
    // The hand-added step is in what the model is asked to change. Without this, the returned
    // "change" silently deletes it.
    expect(edit.previous).toEqual(onCanvas);
    expect(edit.previous).not.toEqual(stored);
  });

  it("still edits the session's draft when the caller sends none (the Build with AI screen)", async () => {
    const { controller, sessions, generator } = makeController();
    const stored = {
      startNodeId: "n0",
      nodes: [{ id: "n0", type: "start" }],
      edges: [],
    };
    sessions.getForTurn.mockResolvedValue({
      id: "s-1",
      status: "open",
      environmentId: "env-1",
      title: "x",
      currentGraph: stored,
    });

    await controller.turn(
      "t-1",
      "s-1",
      { message: "Add a Slack notification" },
      makeRes() as never,
    );

    expect(generator.editStream.mock.calls[0][2].previous).toBe(stored);
  });
});

describe("POST /builder/sessions/:id/turns — preconditions fire BEFORE any frame", () => {
  it("400 (no writeHead) for an empty message", async () => {
    const { controller, generator } = makeController();
    const res = makeRes();
    await expect(
      controller.turn("t-1", "s-1", { message: "   " }, res as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(res.headWritten).toBe(false);
    expect(generator.editStream).not.toHaveBeenCalled();
  });

  it("404 (no writeHead) when the session isn't this workspace's", async () => {
    const { controller, sessions, generator } = makeController();
    sessions.getForTurn.mockRejectedValue(new NotFoundException());
    const res = makeRes();
    await expect(
      controller.turn("t-1", "s-x", { message: "hi" }, res as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(res.headWritten).toBe(false);
    expect(generator.editStream).not.toHaveBeenCalled();
  });

  it("409 (no writeHead, no generation) when the session is closed", async () => {
    const { controller, sessions, generator } = makeController();
    sessions.getForTurn.mockResolvedValue({
      id: "s-1",
      status: "closed",
      environmentId: "env-1",
      title: "x",
      currentGraph: null,
    });
    const res = makeRes();
    await expect(
      controller.turn("t-1", "s-1", { message: "hi" }, res as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(res.headWritten).toBe(false);
    expect(res.writes).toHaveLength(0);
    expect(generator.editStream).not.toHaveBeenCalled();
  });

  it("402 (no writeHead) when the workspace is over its monthly budget", async () => {
    const { controller, sessions, generator } = makeController();
    sessions.getForTurn.mockResolvedValue({
      id: "s-1",
      status: "open",
      environmentId: "env-1",
      title: "x",
      currentGraph: null,
    });
    getBudget.mockResolvedValue({
      monthlyCapUsd: 10,
      onBudgetExceeded: "reject",
    });
    isOverMonthlyBudget.mockResolvedValue(true);
    const res = makeRes();

    await expect(
      controller.turn("t-1", "s-1", { message: "hi" }, res as never),
    ).rejects.toMatchObject({ status: 402 });
    expect(res.headWritten).toBe(false);
    expect(generator.editStream).not.toHaveBeenCalled();
  });
});
