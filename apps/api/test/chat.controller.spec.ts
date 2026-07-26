import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { ChatController } from "../src/chat/chat.controller";

const CHAT_GRAPH: GraphDef = {
  startNodeId: "chat",
  nodes: [
    { id: "chat", type: "chatTrigger", config: { title: "Support" } as never },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "chat", to: "end" }],
};

function makeController(opts: {
  endpoint?: unknown;
  graph?: GraphDef | null;
  awaitResult?: {
    workflowId: string;
    response?: { body?: unknown; citations?: unknown[] };
  };
  sessionResult?: { replied: boolean; reply?: unknown; citations?: unknown[] };
  /** Turnstile: site key on the definition (null = no gate) + verify() verdict (default allow). */
  siteKey?: string | null;
  /** An arbitrary bot gate (#782), e.g. `{ provider: "app_check" }`. Overrides `siteKey`. */
  gate?:
    | { provider: "turnstile"; siteKey: string }
    | { provider: "app_check" }
    | null;
  verify?: boolean;
}) {
  const chats = {
    getEndpoint: vi.fn().mockResolvedValue(opts.endpoint),
    loadHistory: vi.fn().mockResolvedValue([]),
    appendTurn: vi.fn().mockResolvedValue(undefined),
  };
  const graphs = {
    getLatest: vi
      .fn()
      .mockResolvedValue(
        opts.graph === null ? null : { graph: opts.graph ?? CHAT_GRAPH },
      ),
  };
  const executions = {
    startChatAwaitResponse: vi
      .fn()
      .mockResolvedValue(opts.awaitResult ?? { workflowId: "chat-1" }),
    sendChatSessionMessage: vi
      .fn()
      .mockResolvedValue(opts.sessionResult ?? { replied: false }),
  };
  // `publicGate` is the seam the controllers use (#782: App Check has no site key, so a bare string
  // couldn't express both providers). `opts.siteKey` still drives the Turnstile case so existing
  // cases read unchanged; `opts.gate` sets an arbitrary gate (e.g. `{ provider: "app_check" }`).
  const gate =
    opts.gate ??
    (opts.siteKey ? { provider: "turnstile", siteKey: opts.siteKey } : null);
  const turnstile = {
    publicGate: vi.fn().mockResolvedValue(gate),
    publicSiteKey: vi
      .fn()
      .mockResolvedValue(gate?.provider === "turnstile" ? gate.siteKey : null),
    verify: vi.fn().mockResolvedValue(opts.verify ?? true),
  };
  const controller = new ChatController(
    chats as never,
    graphs as never,
    executions as never,
    turnstile as never,
  );
  return { controller, chats, graphs, executions, turnstile };
}

const DURABLE_GRAPH: GraphDef = {
  startNodeId: "chat",
  nodes: [
    {
      id: "chat",
      type: "chatTrigger",
      config: { title: "Support", durableSession: true } as never,
    },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "chat", to: "end" }],
};

const ENDPOINT = {
  id: "c-1",
  tenantId: "t-1",
  environmentId: "e-1",
  workflowId: "support-chat",
};

describe("ChatController (public)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET serves the definition WITHOUT tenant/workflow identifiers", async () => {
    const { controller } = makeController({ endpoint: ENDPOINT });
    const def = await controller.definition("c-1");
    const s = JSON.stringify(def);
    expect(s).not.toContain("t-1");
    expect(s).not.toContain("support-chat");
    expect(def).toEqual({ chatId: "c-1", title: "Support" });
  });

  it("GET 404s when the graph's entry node isn't a chatTrigger", async () => {
    const wh: GraphDef = {
      startNodeId: "wh",
      nodes: [{ id: "wh", type: "webhookTrigger" }],
      edges: [],
    };
    const { controller } = makeController({ endpoint: ENDPOINT, graph: wh });
    await expect(controller.definition("c-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("POST runs the chat and returns the graph's reply (no workflowId leaked)", async () => {
    const { controller, executions } = makeController({
      endpoint: ENDPOINT,
      awaitResult: {
        workflowId: "chat-t-1-9",
        response: { body: { reply: "Hi there" } },
      },
    });
    const out = await controller.message("c-1", {
      message: "hello",
      sessionId: "s-1",
    });
    expect(out).toEqual({
      status: "replied",
      reply: { reply: "Hi there" },
      citations: [],
    });
    expect(JSON.stringify(out)).not.toContain("t-1");
    expect(executions.startChatAwaitResponse).toHaveBeenCalledWith(
      "t-1",
      "e-1",
      { graph: CHAT_GRAPH },
      { message: "hello", sessionId: "s-1", history: [] },
      "support-chat",
    );
  });

  it("threads session history into the run and persists the completed turn (memory)", async () => {
    const { controller, chats, executions } = makeController({
      endpoint: ENDPOINT,
      awaitResult: { workflowId: "chat-1", response: { body: "the answer" } },
    });
    chats.loadHistory.mockResolvedValue([{ role: "user", text: "earlier" }]);

    await controller.message("c-1", { message: "hello", sessionId: "s-1" });

    // history loaded for this session and threaded into the run input
    expect(chats.loadHistory).toHaveBeenCalledWith("t-1", "c-1", "s-1");
    expect(executions.startChatAwaitResponse.mock.calls[0][3]).toEqual({
      message: "hello",
      sessionId: "s-1",
      history: [{ role: "user", text: "earlier" }],
    });
    // the turn (user msg + reply) is persisted for the next message
    expect(chats.appendTurn).toHaveBeenCalledWith(
      "t-1",
      "c-1",
      "s-1",
      "hello",
      "the answer",
    );
  });

  it("still replies (and logs '') when the reply body is non-serializable", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify would throw on this
    const { controller, chats } = makeController({
      endpoint: ENDPOINT,
      awaitResult: { workflowId: "chat-1", response: { body: circular } },
    });
    const out = await controller.message("c-1", {
      message: "hi",
      sessionId: "s-1",
    });
    expect(out.status).toBe("replied");
    // persistence is best-effort and must not throw on a non-serializable body
    expect(chats.appendTurn).toHaveBeenCalledWith(
      "t-1",
      "c-1",
      "s-1",
      "hi",
      "",
    );
  });

  it("does NOT persist a turn when the graph didn't reply in time", async () => {
    const { controller, chats } = makeController({
      endpoint: ENDPOINT,
      awaitResult: { workflowId: "chat-1" }, // no response
    });
    const out = await controller.message("c-1", {
      message: "hi",
      sessionId: "s-1",
    });
    expect(out).toEqual({ status: "started", citations: [] });
    expect(chats.appendTurn).not.toHaveBeenCalled();
  });

  it("POST returns status 'started' when the graph doesn't reply in time", async () => {
    const { controller } = makeController({
      endpoint: ENDPOINT,
      awaitResult: { workflowId: "chat-1" }, // no response
    });
    const out = await controller.message("c-1", { message: "hello" });
    expect(out).toEqual({ status: "started", citations: [] });
  });

  it("routes to the durable session workflow when the chatTrigger opted in (option A)", async () => {
    const { controller, chats, executions } = makeController({
      endpoint: ENDPOINT,
      graph: DURABLE_GRAPH,
      sessionResult: { replied: true, reply: "durable answer" },
    });
    const out = await controller.message("c-1", {
      message: "hi",
      sessionId: "s-1",
    });
    expect(out).toEqual({
      status: "replied",
      reply: "durable answer",
      citations: [],
    });
    expect(executions.sendChatSessionMessage).toHaveBeenCalledWith(
      "t-1",
      "e-1",
      { graph: DURABLE_GRAPH },
      { message: "hi", sessionId: "s-1", chatId: "c-1" },
      "support-chat",
    );
    // durable mode owns memory itself — the controller does NOT touch the table or the B path
    expect(chats.loadHistory).not.toHaveBeenCalled();
    expect(chats.appendTurn).not.toHaveBeenCalled();
    expect(executions.startChatAwaitResponse).not.toHaveBeenCalled();
  });

  it("durable mode returns 'started' when the turn doesn't answer in time", async () => {
    const { controller } = makeController({
      endpoint: ENDPOINT,
      graph: DURABLE_GRAPH,
      sessionResult: { replied: false },
    });
    const out = await controller.message("c-1", {
      message: "hi",
      sessionId: "s-1",
    });
    expect(out).toEqual({ status: "started", citations: [] });
  });

  it("falls back to the per-message path (B) when durable is set but there's no sessionId", async () => {
    const { controller, executions } = makeController({
      endpoint: ENDPOINT,
      graph: DURABLE_GRAPH,
      awaitResult: { workflowId: "chat-1", response: { body: "b-answer" } },
    });
    const out = await controller.message("c-1", { message: "hi" }); // no sessionId
    expect(out).toEqual({
      status: "replied",
      reply: "b-answer",
      citations: [],
    });
    expect(executions.sendChatSessionMessage).not.toHaveBeenCalled();
    expect(executions.startChatAwaitResponse).toHaveBeenCalled();
  });

  it("surfaces RAG citations from the run's response on the reply (issue #482)", async () => {
    const citations = [
      { source: "docs", snippet: "Refunds take 5 days.", score: 0.9 },
    ];
    const { controller } = makeController({
      endpoint: ENDPOINT,
      awaitResult: {
        workflowId: "chat-1",
        response: { body: "You get a refund.", citations },
      },
    });
    const out = await controller.message("c-1", {
      message: "refund?",
      sessionId: "s-1",
    });
    expect(out).toEqual({
      status: "replied",
      reply: "You get a refund.",
      citations,
    });
  });

  it("surfaces citations from the durable session turn too (issue #482)", async () => {
    const citations = [
      { source: "kb", snippet: "Business hours 9-5.", score: 0.8 },
    ];
    const { controller } = makeController({
      endpoint: ENDPOINT,
      graph: DURABLE_GRAPH,
      sessionResult: { replied: true, reply: "We're open 9-5.", citations },
    });
    const out = await controller.message("c-1", {
      message: "hours?",
      sessionId: "s-1",
    });
    expect(out).toEqual({
      status: "replied",
      reply: "We're open 9-5.",
      citations,
    });
  });

  it("POST 400s on a blank message and never starts a run", async () => {
    const { controller, executions } = makeController({ endpoint: ENDPOINT });
    await expect(
      controller.message("c-1", { message: "" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(executions.startChatAwaitResponse).not.toHaveBeenCalled();
  });

  it("POST 404s (no run) when the endpoint is unknown", async () => {
    const { controller, executions } = makeController({ endpoint: null });
    await expect(
      controller.message("nope", { message: "hi" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(executions.startChatAwaitResponse).not.toHaveBeenCalled();
  });

  it("GET advertises turnstileSiteKey when the tenant's bot gate is active", async () => {
    const withGate = await makeController({
      endpoint: ENDPOINT,
      siteKey: "0xSITEKEY",
    }).controller.definition("c-1");
    expect((withGate as { turnstileSiteKey?: string }).turnstileSiteKey).toBe(
      "0xSITEKEY",
    );
    // Plus the provider-neutral shape (#782); the flat key stays for cached embedded bundles.
    expect((withGate as { botGate?: unknown }).botGate).toEqual({
      provider: "turnstile",
      siteKey: "0xSITEKEY",
    });
    const noGate = await makeController({
      endpoint: ENDPOINT,
    }).controller.definition("c-1");
    expect(noGate).not.toHaveProperty("turnstileSiteKey");
    expect(noGate).not.toHaveProperty("botGate");
  });

  /** An App Check gate carries no site key — the widget choice comes from `botGate` alone. */
  it("GET advertises an app_check gate with no site key", async () => {
    const def = await makeController({
      endpoint: ENDPOINT,
      gate: { provider: "app_check" },
    }).controller.definition("c-1");
    expect((def as { botGate?: unknown }).botGate).toEqual({
      provider: "app_check",
    });
    expect(def).not.toHaveProperty("turnstileSiteKey");
  });

  /** Either token field name reaches the gate — the legacy one keeps cached bundles working. */
  it("POST accepts the provider-neutral botToken as well as turnstileToken", async () => {
    for (const body of [
      { message: "hi", botToken: "tok-new" },
      { message: "hi", turnstileToken: "tok-old" },
    ]) {
      const { controller, turnstile } = makeController({ endpoint: ENDPOINT });
      await controller.message("c-1", body);
      expect(turnstile.verify).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        body.botToken ?? body.turnstileToken,
      );
    }
  });

  it("POST 403s (no run) when the Turnstile challenge fails — before the durable/per-message fork", async () => {
    const { controller, executions, turnstile } = makeController({
      endpoint: ENDPOINT,
      verify: false,
    });
    await expect(
      controller.message("c-1", {
        message: "hi",
        sessionId: "s-1",
        turnstileToken: "bad",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(turnstile.verify).toHaveBeenCalledWith("t-1", "e-1", "bad");
    expect(executions.startChatAwaitResponse).not.toHaveBeenCalled();
    expect(executions.sendChatSessionMessage).not.toHaveBeenCalled();
  });
});
