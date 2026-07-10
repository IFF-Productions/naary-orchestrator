import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";

const getBudget = vi.fn();
const create = vi.fn();
const msgFindMany = vi.fn();
const msgCreate = vi.fn();
// appendTurn writes via $transaction([create, create]) for atomicity. The mock records each
// create's args (so ordering assertions still work) and returns a sentinel; $transaction just
// awaits the array it's given.
const txn = vi.fn(async (ops: unknown[]) =>
  Promise.all(ops as Promise<unknown>[]),
);

vi.mock("@naary/usage", () => ({
  getBudget: (...a: unknown[]) => getBudget(...a),
}));
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    chatEndpoint: { create },
    chatMessage: {
      findMany: msgFindMany,
      create: (...a: unknown[]) => {
        msgCreate(...a);
        return Promise.resolve({});
      },
    },
    $transaction: txn,
  }),
}));

import { ChatService } from "../src/chat/chat.service";

beforeEach(() => vi.clearAllMocks());

describe("ChatService.createEndpoint", () => {
  it("refuses to register a public chat when the tenant has NO budget cap", async () => {
    getBudget.mockResolvedValue(null);
    await expect(
      new ChatService().createEndpoint("t-1", "support-chat"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only workflowId (would be an unusable endpoint)", async () => {
    getBudget.mockResolvedValue({ monthlyCapUsd: 50 });
    await expect(
      new ChatService().createEndpoint("t-1", "   "),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it("registers and returns the public path when a budget cap exists", async () => {
    getBudget.mockResolvedValue({ monthlyCapUsd: 50 });
    create.mockResolvedValue({ id: "c-1" });
    const out = await new ChatService().createEndpoint("t-1", "support-chat");
    expect(out).toEqual({ chatId: "c-1", chatPath: "/c/c-1" });
  });
});

describe("ChatService history (cross-message memory)", () => {
  it("loadHistory returns the last turns oldest-first (desc fetch reversed)", async () => {
    msgFindMany.mockResolvedValue([
      { role: "assistant", text: "b" },
      { role: "user", text: "a" },
    ]); // desc (newest first) from the DB
    const out = await new ChatService().loadHistory("t-1", "c-1", "s-1");
    expect(out).toEqual([
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
    ]); // returned oldest-first
  });

  it("loadHistory is empty (no query) for a missing sessionId", async () => {
    const out = await new ChatService().loadHistory("t-1", "c-1", "");
    expect(out).toEqual([]);
    expect(msgFindMany).not.toHaveBeenCalled();
  });

  it("appendTurn writes the user row then the assistant row", async () => {
    await new ChatService().appendTurn("t-1", "c-1", "s-1", "hi", "hello");
    expect(msgCreate).toHaveBeenCalledTimes(2);
    expect(msgCreate.mock.calls[0][0].data).toMatchObject({
      role: "user",
      text: "hi",
    });
    expect(msgCreate.mock.calls[1][0].data).toMatchObject({
      role: "assistant",
      text: "hello",
    });
  });

  it("appendTurn is a no-op without a sessionId", async () => {
    await new ChatService().appendTurn("t-1", "c-1", "", "hi", "hello");
    expect(msgCreate).not.toHaveBeenCalled();
  });
});
