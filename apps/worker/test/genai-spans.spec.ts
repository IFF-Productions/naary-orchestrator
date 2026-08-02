import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __closeSentryForTest,
  __initSentryForTest,
} from "@naary/observability";

/**
 * GenAI semantic-convention spans for the AGENT + MCP-TOOL activities (#581), asserted against the
 * EXPORTED payload — a real Sentry client with a capturing transport, so what we check is what
 * actually egresses (post-scrub), not what a mapper returned.
 *
 * Two things are proven here:
 *   1. correct token counts (and model/finish-reason/cost) land on the span for a real agent call;
 *   2. NO prompt or completion text egresses — the privacy hard line. The system prompt, the input,
 *      and the model's completion each carry a distinct sentinel and the WHOLE envelope is scanned.
 *
 * Sentinels are deliberately benign (not secret-shaped), so the scrubber can't make assertion (2)
 * pass for the wrong reason.
 */

const PROMPT_SENTINEL = "alphaSystemPromptSentinel";
const INPUT_SENTINEL = "gammaUserInputSentinel";
const COMPLETION_SENTINEL = "betaModelCompletionSentinel";

const generateText = vi.fn();
vi.mock("ai", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  generateText: (...args: unknown[]) => generateText(...args),
}));

import {
  __agentDeps,
  __mcpDeps,
  callMcpTool,
  runAgent,
} from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "agent" };
const CFG = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  systemPrompt: PROMPT_SENTINEL,
};

// The envelope→attribute reader lives in a shared helper (the RAG embedding spec asserts the same
// `naary.gen_ai.usage.estimated` flag through it — one reader, not two).
import { collectGenAiAttrs } from "./genai-attrs";

let sink: unknown[];

beforeEach(() => {
  sink = [];
  generateText.mockReset();
  __agentDeps.getCredentials = () =>
    ({
      getDecryptedKey: () => Promise.resolve("sk-ant-not-a-real-key"),
    }) as never;
  __agentDeps.getDefaultEnvId = (() => Promise.resolve("e1")) as never;
  __agentDeps.recordUsage = (() => Promise.resolve({ id: "evt_1" })) as never;
  __agentDeps.getBudget = (() => Promise.resolve(null)) as never; // no cap ⇒ no reservation
  // #576: runAgent reads the workspace guardrail policy in-activity — empty ⇒ unguarded path.
  __agentDeps.loadGuardrailPolicy = (() => Promise.resolve({})) as never;
  __agentDeps.recordAuditEvent = (() => Promise.resolve()) as never;
  __initSentryForTest(sink);
});

afterEach(async () => {
  await __closeSentryForTest();
  vi.clearAllMocks();
});

describe("runAgent → GenAI-convention span", () => {
  it("exports the convention attributes with the provider's real token counts", async () => {
    generateText.mockResolvedValue({
      text: COMPLETION_SENTINEL,
      finishReason: "stop",
      response: { modelId: "claude-opus-4-8-20260101" },
      totalUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    });

    const result = await runAgent(
      CFG,
      { msg: INPUT_SENTINEL },
      { ...META, environmentId: "e1" },
    );
    // The activity's own contract is untouched by the instrumentation.
    expect(result.output).toEqual({ text: COMPLETION_SENTINEL });

    await __closeSentryForTest(); // flush the capturing transport
    const attrs = collectGenAiAttrs(sink);

    expect(attrs["gen_ai.operation.name"]).toBe("chat");
    expect(attrs["gen_ai.provider.name"]).toBe("anthropic");
    expect(attrs["gen_ai.system"]).toBe("anthropic"); // deprecated alias, still emitted
    expect(attrs["gen_ai.request.model"]).toBe("claude-opus-4-8");
    expect(attrs["gen_ai.response.model"]).toBe("claude-opus-4-8-20260101");
    // THE token assertion: exactly what the provider reported and the ledger recorded.
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(1000);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(500);
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(attrs["naary.gen_ai.usage.cost_usd"]).toBeCloseTo(0.0175, 9);
    // Real counts ⇒ NOT the rule-6 fail-safe estimate.
    expect(attrs["naary.gen_ai.usage.estimated"]).toBe(false);
  });

  it("flags the rule-6 fail-safe estimate so it can't be mistaken for a metered count", async () => {
    // The ai@6 undefined-usage bug: no usage reported ⇒ the activity estimates rather than record 0.
    generateText.mockResolvedValue({
      text: COMPLETION_SENTINEL,
      finishReason: "stop",
    });

    await runAgent(
      CFG,
      { msg: INPUT_SENTINEL },
      { ...META, environmentId: "e1" },
    );

    await __closeSentryForTest();
    const attrs = collectGenAiAttrs(sink);
    expect(attrs["naary.gen_ai.usage.estimated"]).toBe(true);
    // Never zero for a real call (a zero is a silently-free call).
    expect(attrs["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    expect(attrs["gen_ai.usage.output_tokens"]).toBeGreaterThan(0);
  });

  it("NEVER exports prompt, input, or completion text (privacy hard line, whole-envelope scan)", async () => {
    generateText.mockResolvedValue({
      text: COMPLETION_SENTINEL,
      finishReason: "stop",
      totalUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    });

    await runAgent(
      CFG,
      { msg: INPUT_SENTINEL },
      { ...META, environmentId: "e1" },
    );

    await __closeSentryForTest();
    // Sanity: the envelope is non-empty and DID carry our spans — otherwise "no sentinel" is vacuous.
    const exported = JSON.stringify(sink);
    expect(exported).toContain("gen_ai.usage.input_tokens");
    expect(exported).not.toContain(PROMPT_SENTINEL);
    expect(exported).not.toContain(INPUT_SENTINEL);
    expect(exported).not.toContain(COMPLETION_SENTINEL);
  });
});

describe("callMcpTool → GenAI `execute_tool` span", () => {
  it("exports the tool-call attributes and no arguments or result content", async () => {
    const ARG_SENTINEL = "deltaToolArgumentSentinel";
    const RESULT_SENTINEL = "epsilonToolResultSentinel";
    __mcpDeps.resolveMcpTarget = (() =>
      Promise.resolve({
        serverUrl: "https://mcp.example.com",
        headers: {},
      })) as never;
    __mcpDeps.callMcpTool = (() =>
      Promise.resolve({
        isError: false,
        content: { out: RESULT_SENTINEL },
      })) as never;

    const r = await callMcpTool(
      {
        connectionId: "c1",
        tool: "search_issues",
        arguments: { q: ARG_SENTINEL },
      },
      undefined,
      META,
    );
    expect(r.content).toEqual({ out: RESULT_SENTINEL });

    await __closeSentryForTest();
    const attrs = collectGenAiAttrs(sink);
    expect(attrs["gen_ai.operation.name"]).toBe("execute_tool");
    expect(attrs["gen_ai.tool.name"]).toBe("search_issues");
    expect(attrs["gen_ai.tool.type"]).toBe("function");

    const exported = JSON.stringify(sink);
    expect(exported).not.toContain(ARG_SENTINEL);
    expect(exported).not.toContain(RESULT_SENTINEL);
  });
});
