import "reflect-metadata";
import {
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { MissingCredentialError } from "@naary/secrets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphGeneratorService } from "../src/graphs/graph-generator.service";

// Mock only the model network — credentials are injected. Keeps the test hermetic
// (no key, no LLM); like agent.activity.spec, the live model call is deferred. `ai` is ESM-only,
// so `orig()` is left untyped and APICallError is loaded via dynamic import where used.
const generateText = vi.fn();
vi.mock("ai", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
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

    const res = await makeService().generate(
      "t-1",
      "e-1",
      "email me a daily digest",
    );

    expect(res.name).toBe("Feed to email");
    expect(res.graph.startNodeId).toBe("start");
    expect(res.graph.nodes).toHaveLength(2);
    expect(getDecryptedKey).toHaveBeenCalledWith("t-1", "e-1", "anthropic");
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

    await makeService().generate("t-1", "e-1", "comment on a github issue");

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
    await makeService().generate("t-1", "e-1", "do a thing");
    const prompt = generateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("NO CONNECTIONS are configured");
  });

  it("repairs once: invalid graph → feeds the error back → valid on retry", async () => {
    generateText
      .mockResolvedValueOnce({ text: JSON.stringify(invalidOut) })
      .mockResolvedValueOnce({ text: JSON.stringify(validOut) });

    const res = await makeService().generate("t-1", "e-1", "do a thing");

    expect(res.graph.nodes).toHaveLength(2);
    expect(generateText).toHaveBeenCalledTimes(2);
    // the repair prompt carries the validator error + the previous graph
    const repairArgs = generateText.mock.calls[1][0];
    expect(String(repairArgs.prompt)).toContain("ghost");
  });

  it("gives up with 422 when the repair is still invalid (no infinite loop)", async () => {
    generateText.mockResolvedValue({ text: JSON.stringify(invalidOut) });

    await expect(
      makeService().generate("t-1", "e-1", "x"),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(generateText).toHaveBeenCalledTimes(2); // one attempt + one repair, then stop
  });

  it("maps a missing tenant key to 400 with actionable copy (no model call)", async () => {
    getDecryptedKey.mockRejectedValue(
      new MissingCredentialError("t-1", "anthropic"),
    );

    await expect(
      makeService().generate("t-1", "e-1", "x"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("maps a provider 401 to a 400 (key rejected)", async () => {
    const { APICallError } = await import("ai");
    generateText.mockRejectedValue(
      new APICallError({
        message: "unauthorized",
        url: "https://api.anthropic.com/v1/messages",
        requestBodyValues: {},
        statusCode: 401,
      }),
    );

    await expect(
      makeService().generate("t-1", "e-1", "x"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("uses an explicitly requested provider (openai) and its key", async () => {
    generateText.mockResolvedValue({ text: JSON.stringify(validOut) });

    await makeService().generate("t-1", "e-1", "make a flow", "openai");

    expect(getDecryptedKey).toHaveBeenCalledWith("t-1", "e-1", "openai");
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

    await makeService().generate("t-1", "e-1", "make a flow");

    expect(getDecryptedKey).toHaveBeenCalledWith("t-1", "e-1", "openai");
  });

  it("400s when the tenant has no valid provider key at all", async () => {
    listProviders.mockResolvedValue([]);

    await expect(
      makeService().generate("t-1", "e-1", "x"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("400s on an unsupported provider name", async () => {
    await expect(
      makeService().generate("t-1", "e-1", "x", "cohere"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt with 400 before any key/model work", async () => {
    await expect(
      makeService().generate("t-1", "e-1", "   "),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(getDecryptedKey).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// claude-code generation source: the builder runs headless `claude -p` so a
// tenant whose ONLY credential is the Claude Code slot (possibly a subscription
// setup-token, not an API key) can still generate — billed to their subscription.
// ---------------------------------------------------------------------------
import { __genDeps } from "../src/graphs/graph-generator.service";

const execMock = vi.fn();
const realExec = __genDeps.exec;

/** The CLI's single JSON envelope, as `claude -p --output-format json` emits it. */
function envelope(result: string, is_error = false): string {
  return JSON.stringify({ type: "result", result, is_error });
}

describe("GraphGeneratorService (claude-code source)", () => {
  beforeEach(() => {
    __genDeps.exec = execMock;
    execMock.mockReset();
    generateText.mockReset();
    listConnections.mockResolvedValue([]);
    // Tenant with ONLY a claude-code credential (the case that used to 400).
    listProviders
      .mockReset()
      .mockResolvedValue([{ provider: "claude-code", isValid: true }]);
    getDecryptedKey.mockReset().mockResolvedValue("sk-ant-oat-fake");
  });
  afterEach(() => {
    __genDeps.exec = realExec;
  });

  it("falls back to the claude-code credential and generates via the CLI", async () => {
    execMock.mockResolvedValue({
      stdout: envelope(JSON.stringify(validOut)),
      exitCode: 0,
    });

    const res = await makeService().generate("t-1", "e-1", "email me a digest");

    expect(res.graph.nodes).toHaveLength(2);
    expect(getDecryptedKey).toHaveBeenCalledWith("t-1", "e-1", "claude-code");
    expect(generateText).not.toHaveBeenCalled();
    const [binary, args] = execMock.mock.calls[0];
    expect(binary).toBe("claude");
    expect(args).toContain("--output-format");
    expect(args).toContain("plan");
  });

  it("a setup-token goes to CLAUDE_CODE_OAUTH_TOKEN; an API key to ANTHROPIC_API_KEY — never both", async () => {
    execMock.mockResolvedValue({
      stdout: envelope(JSON.stringify(validOut)),
      exitCode: 0,
    });
    await makeService().generate("t-1", "e-1", "flow");
    let env = execMock.mock.calls[0][2].env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-fake");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();

    getDecryptedKey.mockResolvedValue("sk-ant-api-fake");
    await makeService().generate("t-1", "e-1", "flow");
    env = execMock.mock.calls[1][2].env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api-fake");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("bounds the CLI at 55s by default; a caller override (SSE route) reaches exec — including the repair retry", async () => {
    execMock.mockResolvedValue({
      stdout: envelope(JSON.stringify(validOut)),
      exitCode: 0,
    });
    await makeService().generate("t-1", "e-1", "flow");
    expect(execMock.mock.calls[0][2].timeoutMs).toBe(55_000);

    // Invalid first draft forces the repair retry; both CLI calls get the override.
    execMock
      .mockReset()
      .mockResolvedValueOnce({
        stdout: envelope(JSON.stringify(invalidOut)),
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: envelope(JSON.stringify(validOut)),
        exitCode: 0,
      });
    await makeService().generate("t-1", "e-1", "flow", undefined, {
      timeoutMs: 300_000,
    });
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[0][2].timeoutMs).toBe(300_000);
    expect(execMock.mock.calls[1][2].timeoutMs).toBe(300_000);
  });

  it("passes a MINIMAL env to the subprocess — API process secrets never leak in", async () => {
    process.env.ENCRYPTION_KEY_TEST_SENTINEL = "must-not-leak";
    try {
      execMock.mockResolvedValue({
        stdout: envelope(JSON.stringify(validOut)),
        exitCode: 0,
      });
      await makeService().generate("t-1", "e-1", "flow");
      const env = execMock.mock.calls[0][2].env as Record<string, string>;
      expect(Object.keys(env).sort()).toEqual(
        ["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH"].sort(),
      );
    } finally {
      delete process.env.ENCRYPTION_KEY_TEST_SENTINEL;
    }
  });

  it("still prefers an API-model provider when one is configured alongside claude-code", async () => {
    listProviders.mockResolvedValue([
      { provider: "claude-code", isValid: true },
      { provider: "anthropic", isValid: true },
    ]);
    generateText.mockResolvedValue({ text: JSON.stringify(validOut) });

    await makeService().generate("t-1", "e-1", "flow");

    expect(getDecryptedKey).toHaveBeenCalledWith("t-1", "e-1", "anthropic");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("honors an explicit provider:'claude-code' even when anthropic is configured", async () => {
    listProviders.mockResolvedValue([
      { provider: "claude-code", isValid: true },
      { provider: "anthropic", isValid: true },
    ]);
    execMock.mockResolvedValue({
      stdout: envelope(JSON.stringify(validOut)),
      exitCode: 0,
    });

    await makeService().generate("t-1", "e-1", "flow", "claude-code");

    expect(getDecryptedKey).toHaveBeenCalledWith("t-1", "e-1", "claude-code");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("maps a CLI auth failure to a 400 pointing at the Code Agent credential", async () => {
    execMock.mockResolvedValue({
      stdout: envelope("Invalid API key · Please run /login", true),
      exitCode: 1,
    });
    await expect(
      makeService().generate("t-1", "e-1", "flow"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("maps a usage-limit failure to 429", async () => {
    execMock.mockResolvedValue({
      stdout: envelope("You've hit your usage limit for today.", true),
      exitCode: 1,
    });
    await expect(
      makeService().generate("t-1", "e-1", "flow"),
    ).rejects.toSatisfy(
      (e) => (e as { getStatus(): number }).getStatus() === 429,
    );
  });

  it("tolerates markdown fences around the CLI's JSON (parse still succeeds)", async () => {
    execMock.mockResolvedValue({
      stdout: envelope("```json\n" + JSON.stringify(validOut) + "\n```"),
      exitCode: 0,
    });
    const res = await makeService().generate("t-1", "e-1", "flow");
    expect(res.graph.startNodeId).toBe("start");
  });

  it("repairs once through the CLI too (invalid graph → error fed back → valid)", async () => {
    execMock
      .mockResolvedValueOnce({
        stdout: envelope(JSON.stringify(invalidOut)),
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: envelope(JSON.stringify(validOut)),
        exitCode: 0,
      });

    const res = await makeService().generate("t-1", "e-1", "flow");

    expect(res.graph.nodes).toHaveLength(2);
    expect(execMock).toHaveBeenCalledTimes(2);
    const repairPrompt = execMock.mock.calls[1][1][1] as string;
    expect(repairPrompt).toContain("ghost");
  });

  it("the no-provider 400 now tells the user Claude Code is an option", async () => {
    listProviders.mockResolvedValue([]);
    await expect(makeService().generate("t-1", "e-1", "flow")).rejects.toThrow(
      /Claude Code credential/,
    );
  });
});
