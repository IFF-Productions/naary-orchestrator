import "reflect-metadata";
import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { MissingCredentialError } from "@naary/secrets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphGeneratorService } from "../src/graphs/graph-generator.service";

// Mock only the model network — credentials are injected. Keeps the test hermetic
// (no key, no LLM); like agent.activity.spec, the live model call is deferred. `ai` is ESM-only,
// so `orig()` is left untyped and APICallError is loaded via dynamic import where used.
const generateText = vi.fn();
const streamText = vi.fn();
vi.mock("ai", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  generateText: (...args: unknown[]) => generateText(...args),
  streamText: (...args: unknown[]) => streamText(...args),
}));

/** A streamText stub: a StreamTextResult whose `textStream` yields the given deltas.
 *  Mirrors the real shape (textStream is an async-iterable of string deltas; it rethrows
 *  on error) closely enough for the generator's streaming path. */
function fakeStream(deltas: string[], err?: unknown) {
  return {
    textStream: (async function* () {
      for (const d of deltas) yield d;
      if (err) throw err;
    })(),
  };
}

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
  streamText.mockReset();
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

  // --- editStream (conversational builder Slice 2): metered generate/edit --------------------
  describe("editStream (builder)", () => {
    const previousGraph = {
      startNodeId: "start",
      nodes: [{ id: "start", type: "start" }],
      edges: [],
    } as never;

    it("frames an EDIT (previous graph + instruction) and meters reported usage", async () => {
      generateText.mockResolvedValue({
        text: JSON.stringify(validOut),
        totalUsage: { inputTokens: 100, outputTokens: 200 },
      });

      const res = await makeService().editStream("t-1", "e-1", {
        previous: previousGraph,
        instruction: "add an email step",
      });

      const prompt = generateText.mock.calls[0][0].prompt as string;
      expect(prompt).toContain("You are EDITING an existing workflow");
      expect(prompt).toContain(JSON.stringify(previousGraph)); // the current graph is threaded in
      expect(prompt).toContain("add an email step");
      // A real priced meter from the reported usage.
      expect(res.meter).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-8",
        tokens: { inputTokens: 100, outputTokens: 200, cachedInputTokens: 0 },
      });
      expect(res.graph.nodes).toHaveLength(2);
    });

    it("tells the model to PRESERVE what the change doesn't touch", async () => {
      // "Return the COMPLETE graph" alone reads as "write the whole graph", and a model
      // obliges: same intent, new ids, reworded prompts, a new name — an edit the user
      // can't distinguish from a rewrite, with their hand-tuning on untouched nodes gone.
      generateText.mockResolvedValue({ text: JSON.stringify(validOut) });

      await makeService().editStream("t-1", "e-1", {
        previous: previousGraph,
        instruction: "end cleanly when there are no open incidents",
      });

      const prompt = generateText.mock.calls[0][0].prompt as string;
      expect(prompt).toContain("PRESERVE");
      expect(prompt).toContain("BYTE-FOR-BYTE");
      expect(prompt).toMatch(/Keep the workflow's "name"/);
      expect(prompt).toMatch(/ADD only the nodes\/edges the change needs/);
    });

    it("with no `previous` it's a plain create (no edit framing)", async () => {
      generateText.mockResolvedValue({ text: JSON.stringify(validOut) });

      await makeService().editStream("t-1", "e-1", {
        instruction: "build an onboarding flow",
      });

      const prompt = generateText.mock.calls[0][0].prompt as string;
      expect(prompt).not.toContain("You are EDITING");
      expect(prompt).toContain("build an onboarding flow");
    });

    it("v6 usage-undefined bug → meter.tokens is null (caller estimates, never zero)", async () => {
      generateText.mockResolvedValue({ text: JSON.stringify(validOut) }); // no usage field

      const res = await makeService().editStream("t-1", "e-1", {
        previous: previousGraph,
        instruction: "tweak it",
      });

      expect(res.meter.tokens).toBeNull();
      expect(res.meter.provider).toBe("anthropic");
    });

    it("streams per-element hooks when provided (API-model path)", async () => {
      streamText.mockReturnValue(fakeStream([JSON.stringify(validOut)]));
      const nodes: unknown[] = [];
      const edges: unknown[] = [];

      const res = await makeService().editStream(
        "t-1",
        "e-1",
        { previous: previousGraph, instruction: "add a node" },
        undefined,
        { onNode: (n) => nodes.push(n), onEdge: (e) => edges.push(e) },
      );

      expect(streamText).toHaveBeenCalledOnce();
      expect(nodes.length).toBeGreaterThan(0);
      expect(res.graph.nodes).toHaveLength(2);
      // No totalUsage on the fake stream → tokens null (fail-safe estimate downstream).
      expect(res.meter.tokens).toBeNull();
    });
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
// generateStream: same validated result as generate(), but for API-model providers it
// uses streamText and fires onMeta/onNode/onEdge as each element is parsed out of the
// growing free-form buffer (so the canvas draws live).
// ---------------------------------------------------------------------------
describe("GraphGeneratorService.generateStream (API-model path)", () => {
  const validForStream = {
    name: "Feed to email",
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      { id: "agent", type: "agent", config: { provider: "anthropic" } },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "start", to: "agent" },
      { from: "agent", to: "end" },
    ],
  };

  it("streams the name, each node, then each edge — and returns the validated graph", async () => {
    // Split the JSON into small deltas so elements complete across chunk boundaries.
    const full = JSON.stringify(validForStream);
    const deltas: string[] = [];
    for (let i = 0; i < full.length; i += 11)
      deltas.push(full.slice(i, i + 11));
    streamText.mockReturnValue(fakeStream(deltas));

    const names: string[] = [];
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    const res = await makeService().generateStream(
      "t-1",
      "e-1",
      "email me a digest",
      undefined,
      {
        onMeta: (n) => names.push(n),
        onNode: (n) => nodes.push(n),
        onEdge: (e) => edges.push(e),
      },
    );

    expect(names).toEqual(["Feed to email"]); // once, no repeat
    expect(nodes).toEqual(validForStream.nodes); // exactly once each, in order
    expect(edges).toEqual(validForStream.edges);
    expect(streamText).toHaveBeenCalledOnce();
    expect(generateText).not.toHaveBeenCalled();
    // The returned graph is the authoritative validated one.
    expect(res.name).toBe("Feed to email");
    expect(res.graph.nodes).toHaveLength(3);
  });

  it("maps a mid-stream provider error the same way as the one-shot call", async () => {
    const { APICallError } = await import("ai");
    streamText.mockReturnValue(
      fakeStream(
        ['{"name":"x","startNodeId":"a","nodes":['],
        new APICallError({
          message: "unauthorized",
          url: "https://api.anthropic.com/v1/messages",
          requestBodyValues: {},
          statusCode: 401,
        }),
      ),
    );
    await expect(
      makeService().generateStream("t-1", "e-1", "x", undefined, {
        onNode: () => {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("without hooks, generateStream behaves like generate (no streaming)", async () => {
    generateText.mockResolvedValue({ text: JSON.stringify(validOut) });
    const res = await makeService().generateStream("t-1", "e-1", "x");
    expect(res.graph.nodes).toHaveLength(2);
    expect(streamText).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// claude-code generation source: the builder runs headless `claude -p` so a
// tenant whose ONLY credential is the Claude Code slot (possibly a subscription
// setup-token, not an API key) can still generate — billed to their subscription.
//
// #680: that CLI runs in the SANDBOX-RUNNER now, not as an api subprocess. The api ships no
// coding CLI at all, so the seam under test is the runner dispatch.
// ---------------------------------------------------------------------------
import { __genDeps } from "../src/graphs/graph-generator.service";

const runSandboxMock = vi.fn();
const realRunSandbox = __genDeps.runSandbox;

/** The runner env the api reads. Restored per test so an unconfigured-runner case can be tested. */
function setRunnerEnv(url: string | undefined, token: string | undefined) {
  if (url === undefined) delete process.env.SANDBOX_RUNNER_URL;
  else process.env.SANDBOX_RUNNER_URL = url;
  if (token === undefined) delete process.env.SANDBOX_RUNNER_TOKEN;
  else process.env.SANDBOX_RUNNER_TOKEN = token;
}

/**
 * The `__genDeps.exec closes the child's stdin` suites (and their fixtures/fake-claude.mjs harness)
 * lived here until #680. They guarded a real bug — execFile leaves the child's stdin an OPEN pipe,
 * so `claude -p` blocked ~3s waiting for EOF and could exit 1 — but the api no longer spawns a
 * subprocess at all, so there is nothing left for them to guard.
 *
 * The equivalent invariant now lives in the runner's argv: `docker run` is invoked WITHOUT `-i`, so
 * the container's stdin is /dev/null and the CLI sees EOF immediately. That is pinned by the
 * docker-run argv tests (apps/sandbox-runner/test/docker-run.spec.ts).
 */

/**
 * INVENTED CONNECTION IDS. Reported as "build with AI … auto populated bogus connections".
 *
 * The resource block tells the model to use one of the tenant's EXACT ids and never to invent one.
 * Nothing checked. `validate()` covers structure and node types only, so an invented id sailed
 * through: the node LOOKS configured, passes the save gate, and fails at RUN time with "unknown
 * connection" — long after the author stopped looking at it.
 */
describe("generate — invented connectionIds are blanked", () => {
  const graphWith = (connectionId: string) => ({
    name: "Flow",
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "gh",
        type: "integration",
        config: { provider: "github", action: "create_issue", connectionId },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "start", to: "gh" },
      { from: "gh", to: "end" },
    ],
  });

  it("blanks an id the tenant does not have", async () => {
    listConnections.mockResolvedValue([
      {
        id: "conn_real",
        type: "github",
        label: "GitHub",
        serverUrl: "https://api.github.com",
      },
    ]);
    generateText.mockResolvedValue({
      text: JSON.stringify(graphWith("conn_invented_by_the_model")),
    });

    const res = await makeService().generate("t-1", "e-1", "file an issue");

    const node = res.graph.nodes.find((n) => n.id === "gh");
    // Blanked, NOT dropped: empty is the state the canvas lints, the save gate reports, and the
    // config panel shows as an empty picker — so the author is asked to choose.
    expect((node?.config as { connectionId?: string }).connectionId).toBe("");
    // The rest of the node survives — only the bogus id is removed.
    expect((node?.config as { provider?: string }).provider).toBe("github");
  });

  it("leaves a REAL id alone", async () => {
    listConnections.mockResolvedValue([
      {
        id: "conn_real",
        type: "github",
        label: "GitHub",
        serverUrl: "https://api.github.com",
      },
    ]);
    generateText.mockResolvedValue({
      text: JSON.stringify(graphWith("conn_real")),
    });

    const res = await makeService().generate("t-1", "e-1", "file an issue");

    expect(
      (
        res.graph.nodes.find((n) => n.id === "gh")?.config as {
          connectionId?: string;
        }
      ).connectionId,
    ).toBe("conn_real");
  });

  /** With no connections configured at all, EVERY id is invented by definition. */
  it("blanks everything when the tenant has no connections", async () => {
    listConnections.mockResolvedValue([]);
    generateText.mockResolvedValue({
      text: JSON.stringify(graphWith("conn_anything")),
    });

    const res = await makeService().generate("t-1", "e-1", "file an issue");

    expect(
      (
        res.graph.nodes.find((n) => n.id === "gh")?.config as {
          connectionId?: string;
        }
      ).connectionId,
    ).toBe("");
  });
});

/**
 * The SAME enforcement on the conversational path. An edit turn can invent a connectionId exactly
 * as a create can, and that draft is what the user then saves — so a test that only covered
 * `generate()` would have left half the surface unguarded (raised in review).
 */
describe("editStream — invented connectionIds are blanked too", () => {
  it("blanks an invented id on an edit turn", async () => {
    listConnections.mockResolvedValue([
      {
        id: "conn_real",
        type: "github",
        label: "GitHub",
        serverUrl: "https://api.github.com",
      },
    ]);
    generateText.mockResolvedValue({
      text: JSON.stringify({
        name: "Edited",
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" },
          {
            id: "gh",
            type: "integration",
            config: {
              provider: "github",
              action: "create_issue",
              connectionId: "conn_hallucinated",
            },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "start", to: "gh" },
          { from: "gh", to: "end" },
        ],
      }),
    });

    const res = await makeService().editStream("t-1", "e-1", {
      instruction: "add a github issue step",
    });

    expect(
      (
        res.graph.nodes.find((n) => n.id === "gh")?.config as {
          connectionId?: string;
        }
      ).connectionId,
    ).toBe("");
  });
});

/**
 * SELF-VERIFY + SELF-REPAIR. "maybe we should ask build with agent to verify and fix that for us
 * that way the flow is ready?"
 *
 * The GAP this fills, precisely: `validateGraph` already rejects an unknown provider/action (and the
 * existing repair loop fixes those), but it does NOT check whether an action's REQUIRED FIELDS were
 * supplied. So the classic generator miss — a real action with an empty `owner`/`repo`/`title` —
 * reached the canvas looking configured and failed on the first run. The generator knew how to check
 * this (validateIntegrationConfig); it just never checked its own output.
 */
describe("generate — self-repairs its own catalog mistakes", () => {
  const conns = [
    {
      id: "conn_real",
      type: "github",
      label: "GitHub",
      serverUrl: "https://api.github.com",
    },
  ];
  /** A REAL action, so validateGraph passes — the required fields are what's missing. */
  const graphWithFields = (fields: Record<string, unknown>) => ({
    name: "Flow",
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "gh",
        type: "integration",
        config: {
          provider: "github",
          action: "create_issue",
          connectionId: "conn_real",
          fields,
        },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "start", to: "gh" },
      { from: "gh", to: "end" },
    ],
  });
  const COMPLETE = { owner: "acme", repo: "api", title: "It broke" };

  it("asks the model to fill a missing required field, and keeps the fix", async () => {
    listConnections.mockResolvedValue(conns);
    generateText
      .mockResolvedValueOnce({ text: JSON.stringify(graphWithFields({})) })
      .mockResolvedValueOnce({
        text: JSON.stringify(graphWithFields(COMPLETE)),
      });

    const res = await makeService().generate("t-1", "e-1", "file an issue");

    expect(generateText).toHaveBeenCalledTimes(2);
    // The repair prompt names the NODE and the missing field — not a vague "invalid graph".
    const repairPrompt = generateText.mock.calls[1][0].prompt as string;
    expect(repairPrompt).toContain('node "gh"');
    expect(repairPrompt).toContain("missing required field");
    expect(repairPrompt).toContain("Fix ONLY these");
    // The corrected draft is what the user gets.
    const cfg = res.graph.nodes.find((n) => n.id === "gh")?.config as {
      fields?: Record<string, unknown>;
    };
    expect(cfg.fields).toMatchObject(COMPLETE);
  });

  /** A repair can REGRESS — a model handed an error list may rewrite more than it was asked to. */
  it("keeps the ORIGINAL when the repair doesn't improve matters", async () => {
    listConnections.mockResolvedValue(conns);
    generateText
      .mockResolvedValueOnce({
        text: JSON.stringify(graphWithFields({ owner: "acme" })),
      })
      // Still incomplete — and now it lost the one field it had.
      .mockResolvedValueOnce({ text: JSON.stringify(graphWithFields({})) });

    const res = await makeService().generate("t-1", "e-1", "file an issue");

    const cfg = res.graph.nodes.find((n) => n.id === "gh")?.config as {
      fields?: Record<string, unknown>;
    };
    expect(cfg.fields).toEqual({ owner: "acme" });
  });

  /** A MISSING CONNECTION is the author's to resolve — no prompt can conjure one, so it must not
   *  burn a repair turn. */
  it("does not self-repair a missing connection", async () => {
    listConnections.mockResolvedValue([]);
    generateText.mockResolvedValue({
      text: JSON.stringify({
        name: "Flow",
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" },
          {
            id: "gh",
            type: "integration",
            config: {
              provider: "github",
              action: "create_issue",
              connectionId: "",
              fields: COMPLETE,
            },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "start", to: "gh" },
          { from: "gh", to: "end" },
        ],
      }),
    });

    await makeService().generate("t-1", "e-1", "file an issue");

    // ONE call: no repair attempt for something the model cannot fix.
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  /** A clean draft costs nothing extra. */
  it("makes no second call when the draft is already valid", async () => {
    listConnections.mockResolvedValue(conns);
    generateText.mockResolvedValue({
      text: JSON.stringify(graphWithFields(COMPLETE)),
    });

    await makeService().generate("t-1", "e-1", "file an issue");

    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
