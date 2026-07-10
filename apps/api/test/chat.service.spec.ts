import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";

const getBudget = vi.fn();
const create = vi.fn();

vi.mock("@naary/usage", () => ({
  getBudget: (...a: unknown[]) => getBudget(...a),
}));
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ chatEndpoint: { create } }),
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
