import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
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
  awaitResult?: { workflowId: string; response?: { body?: unknown } };
  sessionResult?: { replied: boolean; reply?: unknown };
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
  const controller = new ChatController(
    chats as never,
    graphs as never,
    executions as never,
  );
  return { controller, chats, graphs, executions };
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
    expect(out).toEqual({ status: "replied", reply: { reply: "Hi there" } });
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
    expect(out).toEqual({ status: "started" });
    expect(chats.appendTurn).not.toHaveBeenCalled();
  });

  it("POST returns status 'started' when the graph doesn't reply in time", async () => {
    const { controller } = makeController({
      endpoint: ENDPOINT,
      awaitResult: { workflowId: "chat-1" }, // no response
    });
    const out = await controller.message("c-1", { message: "hello" });
    expect(out).toEqual({ status: "started" });
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
    expect(out).toEqual({ status: "replied", reply: "durable answer" });
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
    expect(out).toEqual({ status: "started" });
  });

  it("falls back to the per-message path (B) when durable is set but there's no sessionId", async () => {
    const { controller, executions } = makeController({
      endpoint: ENDPOINT,
      graph: DURABLE_GRAPH,
      awaitResult: { workflowId: "chat-1", response: { body: "b-answer" } },
    });
    const out = await controller.message("c-1", { message: "hi" }); // no sessionId
    expect(out).toEqual({ status: "replied", reply: "b-answer" });
    expect(executions.sendChatSessionMessage).not.toHaveBeenCalled();
    expect(executions.startChatAwaitResponse).toHaveBeenCalled();
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
});
