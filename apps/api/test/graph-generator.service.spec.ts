import "reflect-metadata";
import {
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { MissingCredentialError } from "@naary/secrets";
import { APICallError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphGeneratorService } from "../src/graphs/graph-generator.service";

// Mock only the model network — credentials are injected. Keeps the test hermetic
// (no key, no LLM); like agent.activity.spec, the live model call is deferred.
const generateText = vi.fn();
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  generateText: (...args: unknown[]) => generateText(...args),
}));

const getDecryptedKey = vi.fn();
const listProviders = vi.fn();
const listConnections = vi.fn().mockResolvedValue([]);
function makeService(): GraphGeneratorService {
  return new GraphGeneratorService(
    { getDecryptedKey, listProviders } as never,
    { list: listConnections } as never,
  );
}

// A structurally valid graph the model might emit.
const validOut = {
  name: "Feed to email",
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "start", to: "end" }],
};
// Invalid: edge points at a node that doesn't exist → validateGraph rejects.
const invalidOut = {
  name: "Broken",
  startNodeId: "start",
  nodes: [{ id: "start", type: "start" }],
  edges: [{ from: "start", to: "ghost" }],
};

beforeEach(() => {
  generateText.mockReset();
  getDecryptedKey.mockReset().mockResolvedValue("sk-ant-test");
  // Default: the tenant has a valid Anthropic key, so auto-select resolves to anthropic
  // (preserving the historical default when the caller names no provider).
  listProviders
    .mockReset()
    .mockResolvedValue([{ provider: "anthropic", isValid: true }]);
});

describe("GraphGeneratorService", () => {
  it("returns a validated draft graph on the first attempt", async () => {
    generateText.mockResolvedValue({ text: JSON.stringify(validOut) });

    const res = await makeService().generate("t-1", "email me a daily digest");

    expect(res.name).toBe("Feed to email");
    expect(res.graph.startNodeId).toBe("start");
    expect(res.graph.nodes).toHaveLength(2);
    expect(getDecryptedKey).toHaveBeenCalledWith("t-1", "anthropic");
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("grounds the model in the tenant's real connections + the integration action catalog", async () => {
    listConnections.mockResolvedValue([
      {
        id: "conn_abc",
        type: "github",
        label: "GitHub (prod)",
        serverUrl: "https://api.github.com",
      },
    ]);
    generateText.mockResolvedValue({ text: JSON.stringify(validOut) });

    await makeService().generate("t-1", "comment on a github issue");

    const prompt = generateText.mock.calls[0][0].prompt as string;
    // The model is told the EXACT connection id (so it never invents "github").
    expect(prompt).toContain('id="conn_abc"');
    expect(prompt).toContain("AVAILABLE CONNECTIONS");
    // …and the real integration provider/action list (so it can't invent an action).
    expect(prompt).toContain('provider="github" action="create_issue"');
  });

  it("tells the model NOT to use connection-bound nodes when the tenant has none", async () => {
    listConnections.mockResolvedValue([]);
    generateText.mockResolvedValue({ text: JSON.stringify(validOut) });
    await makeService().generate("t-1", "do a thing");
    const prompt = generateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("NO CONNECTIONS are configured");
  });

  it("repairs once: invalid graph → feeds the error back → valid on retry", async () => {
    generateText
      .mockResolvedValueOnce({ text: JSON.stringify(invalidOut) })
      .mockResolvedValueOnce({ text: JSON.stringify(validOut) });

    const res = await makeService().generate("t-1", "do a thing");

    expect(res.graph.nodes).toHaveLength(2);
    expect(generateText).toHaveBeenCalledTimes(2);
    // the repair prompt carries the validator error + the previous graph
    const repairArgs = generateText.mock.calls[1][0];
    expect(String(repairArgs.prompt)).toContain("ghost");
  });

  it("gives up with 422 when the repair is still invalid (no infinite loop)", async () => {
    generateText.mockResolvedValue({ text: JSON.stringify(invalidOut) });

    await expect(makeService().generate("t-1", "x")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(generateText).toHaveBeenCalledTimes(2); // one attempt + one repair, then stop
  });

  it("maps a missing tenant key to 400 with actionable copy (no model call)", async () => {
    getDecryptedKey.mockRejectedValue(
      new MissingCredentialError("t-1", "anthropic"),
    );

    await expect(makeService().generate("t-1", "x")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("maps a provider 401 to a 400 (key rejected)", async () => {
    generateText.mockRejectedValue(
      new APICallError({
        message: "unauthorized",
        url: "https://api.anthropic.com/v1/messages",
        requestBodyValues: {},
        statusCode: 401,
      }),
    );

    await expect(makeService().generate("t-1", "x")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("uses an explicitly requested provider (openai) and its key", async () => {
    generateText.mockResolvedValue({ text: JSON.stringify(validOut) });

    await makeService().generate("t-1", "make a flow", "openai");

    expect(getDecryptedKey).toHaveBeenCalledWith("t-1", "openai");
    // no auto-select needed when the caller names a provider
    expect(listProviders).not.toHaveBeenCalled();
  });

  it("auto-selects the tenant's configured provider when none is requested", async () => {
    // only OpenAI is valid → generator should pick it (anthropic absent)
    listProviders.mockResolvedValue([
      { provider: "anthropic", isValid: false },
      { provider: "openai", isValid: true },
    ]);
    generateText.mockResolvedValue({ text: JSON.stringify(validOut) });

    await makeService().generate("t-1", "make a flow");

    expect(getDecryptedKey).toHaveBeenCalledWith("t-1", "openai");
  });

  it("400s when the tenant has no valid provider key at all", async () => {
    listProviders.mockResolvedValue([]);

    await expect(makeService().generate("t-1", "x")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("400s on an unsupported provider name", async () => {
    await expect(
      makeService().generate("t-1", "x", "cohere"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt with 400 before any key/model work", async () => {
    await expect(makeService().generate("t-1", "   ")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getDecryptedKey).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
});
