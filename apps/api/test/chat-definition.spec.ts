import { describe, expect, it } from "vitest";
import type { GraphDef } from "@naary/dsl";
import {
  MAX_MESSAGE_LENGTH,
  extractChatDefinition,
  isDurableSession,
  validateMessage,
} from "../src/chat/chat-definition";

function chatGraph(config: unknown): GraphDef {
  return {
    startNodeId: "chat",
    nodes: [
      { id: "chat", type: "chatTrigger", config: config as never },
      { id: "end", type: "end" },
    ],
    edges: [{ from: "chat", to: "end" }],
  };
}

describe("extractChatDefinition", () => {
  it("returns the public definition when the entry node is a chatTrigger", () => {
    const def = extractChatDefinition(
      chatGraph({ title: "Support", greeting: "Hi!", placeholder: "Ask…" }),
      "c-1",
    );
    expect(def).toEqual({
      chatId: "c-1",
      title: "Support",
      greeting: "Hi!",
      placeholder: "Ask…",
    });
  });

  it("returns null when the entry node is NOT a chatTrigger", () => {
    const graph: GraphDef = {
      startNodeId: "wh",
      nodes: [
        { id: "wh", type: "webhookTrigger" },
        { id: "end", type: "end" },
      ],
      edges: [{ from: "wh", to: "end" }],
    };
    expect(extractChatDefinition(graph, "c-1")).toBeNull();
  });

  it("does not echo unknown config keys to the browser", () => {
    const def = extractChatDefinition(
      chatGraph({ secretInternal: "x" }),
      "c-1",
    );
    expect(def).not.toHaveProperty("secretInternal");
  });
});

describe("validateMessage", () => {
  it("accepts a message + optional sessionId", () => {
    expect(validateMessage({ message: "hello", sessionId: "s-1" })).toEqual({
      ok: true,
      message: "hello",
      sessionId: "s-1",
    });
  });

  it("defaults a missing/oversized sessionId to empty", () => {
    expect(validateMessage({ message: "hi" })).toEqual({
      ok: true,
      message: "hi",
      sessionId: "",
    });
    const res = validateMessage({ message: "hi", sessionId: "x".repeat(500) });
    expect(res.ok && res.sessionId).toBe("");
  });

  it("rejects a missing/blank/non-string message", () => {
    expect(validateMessage({}).ok).toBe(false);
    expect(validateMessage({ message: "  " }).ok).toBe(false);
    expect(validateMessage({ message: 42 }).ok).toBe(false);
    expect(validateMessage("nope").ok).toBe(false);
  });

  it("rejects an oversized message", () => {
    const res = validateMessage({
      message: "x".repeat(MAX_MESSAGE_LENGTH + 1),
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringMatching(/exceeds/),
    });
  });
});

describe("isDurableSession", () => {
  it("is true only when the chatTrigger opted in", () => {
    expect(isDurableSession(chatGraph({ durableSession: true }))).toBe(true);
    expect(isDurableSession(chatGraph({ durableSession: false }))).toBe(false);
    expect(isDurableSession(chatGraph({}))).toBe(false); // default = option B
  });

  it("is false when the entry node isn't a chatTrigger", () => {
    const g: GraphDef = {
      startNodeId: "wh",
      nodes: [{ id: "wh", type: "webhookTrigger" }],
      edges: [],
    };
    expect(isDurableSession(g)).toBe(false);
  });
});
