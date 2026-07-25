import { afterEach, describe, expect, it, vi } from "vitest";

// genai.ts binds `metricDistribution` at import time, so a vi.spyOn on the module namespace would
// never be seen — record through a module mock that still calls the real implementation.
const hoisted = vi.hoisted(() => ({ metricCalls: [] as unknown[][] }));
vi.mock("../src/metrics", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    metricDistribution: (...args: unknown[]) => {
      hoisted.metricCalls.push(args);
      return (actual.metricDistribution as (...a: unknown[]) => void)(...args);
    },
  };
});

import { __closeSentryForTest, __initSentryForTest } from "../src/index";
import {
  GEN_AI_SEMCONV_VERSION,
  genAiProviderName,
  genAiRequestAttrs,
  genAiResponseAttrs,
  genAiSpanName,
  genAiToolAttrs,
  withGenAiSpan,
  withGenAiToolSpan,
} from "../src/genai";

/**
 * GenAI semantic-convention mapping (#581). Two layers:
 *   1. the PURE mappers — exact attribute names/values, which is what a convention bump changes;
 *   2. the EXPORTED envelope — with a real Sentry client + a capturing transport, so the privacy
 *      assertion is made against what actually egresses, not against what a mapper returned.
 * Only (2) can prove "no prompt/completion text in any exported span attribute or event": a pure
 * mapper never had the text in the first place.
 */

/**
 * Recursively merge every `gen_ai.*` / `naary.gen_ai.*` attribute found anywhere in the payload.
 * A root span's attributes land in `contexts.trace.data` as plain values, while a CHILD span's land
 * in `spans[].data` in OTel's typed `{ type, value }` form — unwrap that so both read the same.
 */
function unwrapAttr(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 2 && keys.includes("type") && keys.includes("value")) {
      return (v as { value: unknown }).value;
    }
  }
  return v;
}

function collectGenAiAttrs(value: unknown, out: Record<string, unknown> = {}) {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const v of value) collectGenAiAttrs(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith("gen_ai.") || k.startsWith("naary.gen_ai.")) {
      out[k] = unwrapAttr(v);
    } else collectGenAiAttrs(v, out);
  }
  return out;
}

describe("genAiProviderName (convention well-known values)", () => {
  it("maps google to the conventions' Gemini-API value and passes others through", () => {
    expect(genAiProviderName("anthropic")).toBe("anthropic");
    expect(genAiProviderName("openai")).toBe("openai");
    expect(genAiProviderName("google")).toBe("gcp.gemini");
    // An unrecognized provider still gets a dimension rather than a dropped attribute.
    expect(genAiProviderName("mistral")).toBe("mistral");
  });
});

describe("genAiRequestAttrs", () => {
  it("emits the operation/provider/model triple, plus the deprecated gen_ai.system alias", () => {
    expect(
      genAiRequestAttrs({
        operation: "chat",
        provider: "google",
        model: "gemini-3-pro",
        maxOutputTokens: 512,
        temperature: 0.2,
      }),
    ).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "gcp.gemini",
      "gen_ai.system": "gcp.gemini", // deprecated since ~1.36, still emitted — see genai.ts header
      "gen_ai.request.model": "gemini-3-pro",
      "gen_ai.request.max_tokens": 512,
      "gen_ai.request.temperature": 0.2,
    });
  });

  it("omits optional request knobs when unset (never emits a placeholder)", () => {
    const attrs = genAiRequestAttrs({
      operation: "chat",
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect(Object.keys(attrs)).not.toContain("gen_ai.request.temperature");
    expect(Object.keys(attrs)).not.toContain("gen_ai.request.max_tokens");
  });
});

describe("genAiResponseAttrs", () => {
  it("carries the token counts, finish reasons (list), cost and the estimate flag", () => {
    expect(
      genAiResponseAttrs({
        responseModel: "claude-opus-4-8-20260101",
        inputTokens: 1234,
        outputTokens: 56,
        cachedInputTokens: 789,
        finishReasons: ["stop"],
        costUsd: 0.0042,
        estimated: false,
      }),
    ).toEqual({
      "gen_ai.response.model": "claude-opus-4-8-20260101",
      "gen_ai.usage.input_tokens": 1234,
      "gen_ai.usage.output_tokens": 56,
      "gen_ai.usage.cached_input_tokens": 789,
      "gen_ai.response.finish_reasons": ["stop"],
      "naary.gen_ai.usage.cost_usd": 0.0042,
      "naary.gen_ai.usage.estimated": false,
    });
  });

  it("omits an absent count rather than emitting 0 (a zero reads as a free call)", () => {
    const attrs = genAiResponseAttrs({ outputTokens: 7 });
    expect(attrs).toEqual({ "gen_ai.usage.output_tokens": 7 });
    expect(Object.keys(attrs)).not.toContain("gen_ai.usage.input_tokens");
  });

  it("keeps 0 when it is the real reported count", () => {
    expect(genAiResponseAttrs({ inputTokens: 0 })).toEqual({
      "gen_ai.usage.input_tokens": 0,
    });
  });
});

describe("genAiToolAttrs / span names", () => {
  it("uses execute_tool + the convention's `function` tool type (no invented value)", () => {
    expect(
      genAiToolAttrs({ toolName: "search_issues", toolCallId: "call_1" }),
    ).toEqual({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search_issues",
      "gen_ai.tool.type": "function",
      "gen_ai.tool.call.id": "call_1",
    });
  });

  it("names spans `{operation} {target}` per the conventions", () => {
    expect(genAiSpanName("chat", "claude-opus-4-8")).toBe(
      "chat claude-opus-4-8",
    );
    expect(genAiSpanName("execute_tool", "search_issues")).toBe(
      "execute_tool search_issues",
    );
  });

  it("pins the convention version it targets", () => {
    expect(GEN_AI_SEMCONV_VERSION).toBe("1.41.0");
  });
});

describe("withGenAiSpan / withGenAiToolSpan (passthrough when Sentry is off)", () => {
  it("returns the value and still runs when there is no client", async () => {
    let recorded = false;
    const v = await withGenAiSpan(
      { operation: "chat", provider: "anthropic", model: "m" },
      async (record) => {
        record({ inputTokens: 1, outputTokens: 2 });
        recorded = true;
        return 42;
      },
    );
    expect(v).toBe(42);
    expect(recorded).toBe(true);
    expect(await withGenAiToolSpan({ toolName: "t" }, async () => "ok")).toBe(
      "ok",
    );
  });
});

describe("gen_ai.client.token.usage metric (the OTLP/Datadog path)", () => {
  it("dual-emits both token types with low-cardinality convention dimensions", async () => {
    // Our OTLP exporter (#462) is METRICS-only, so this is the path by which token counts reach a
    // Datadog/OTLP backend natively. metrics.ts fans out to Sentry AND OTLP; the recording wrapper
    // above still calls through to the real implementation.
    hoisted.metricCalls.length = 0;
    await withGenAiSpan(
      { operation: "chat", provider: "google", model: "gemini-3-pro" },
      async (record) => {
        record({ inputTokens: 300, outputTokens: 40 });
      },
    );

    const calls = hoisted.metricCalls.filter(
      (c) => c[0] === "gen_ai.client.token.usage",
    );
    expect(calls).toHaveLength(2);
    const byType = new Map(
      calls.map((c) => [
        (c[2] as Record<string, unknown>)["gen_ai.token.type"],
        c,
      ]),
    );
    expect(byType.get("input")?.[1]).toBe(300);
    expect(byType.get("output")?.[1]).toBe(40);
    for (const [, call] of byType) {
      expect(call[2]).toMatchObject({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "gcp.gemini",
        "gen_ai.request.model": "gemini-3-pro",
      });
      // Metric labels stay low-cardinality — never tenant/execution/node ids (metrics.ts rule).
      expect(Object.keys(call[2] as object)).not.toContain("tenantId");
      expect(Object.keys(call[2] as object)).not.toContain("executionId");
      expect(call[3]).toBe("{token}"); // unit per the conventions
      // Provider-reported ⇒ estimated:false, so a dashboard can trust these counts.
      expect(call[2]).toMatchObject({
        "naary.gen_ai.usage.estimated": false,
      });
    }
  });

  it("marks a rule-6 fail-safe ESTIMATE in the metric dimensions, not only on the span", async () => {
    // The OTLP sink is metrics-only, so without this dimension an estimate is
    // indistinguishable from provider-reported usage and would skew cost dashboards
    // (Copilot review, #581).
    hoisted.metricCalls.length = 0;
    await withGenAiSpan(
      { operation: "chat", provider: "google", model: "gemini-3-pro" },
      async (record) => {
        record({ inputTokens: 120, outputTokens: 30, estimated: true });
      },
    );
    const calls = hoisted.metricCalls.filter(
      (c) => c[0] === "gen_ai.client.token.usage",
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[2]).toMatchObject({
        "naary.gen_ai.usage.estimated": true,
      });
    }
  });
});

describe("exported spans (real client + capturing transport)", () => {
  afterEach(async () => {
    await __closeSentryForTest();
  });

  it("exports the GenAI attributes with the right token counts, and NO prompt/completion text", async () => {
    const sink: unknown[] = [];
    __initSentryForTest(sink);

    // Benign sentinels: deliberately NOT secret-shaped, so a redaction by the scrubber can't make
    // this assertion pass for the wrong reason. If either string ever reaches the exporter, the
    // privacy line in genai.ts has been broken.
    const PROMPT = "alphaPromptSentinelPhrase";
    const COMPLETION = "betaCompletionSentinelPhrase";

    const out = await withGenAiSpan(
      {
        operation: "chat",
        provider: "anthropic",
        model: "claude-opus-4-8",
        maxOutputTokens: 1024,
      },
      async (record) => {
        // The real activity has the prompt AND the completion in scope right here — the point of
        // this test is that nothing available in this closure can put either on the span.
        const completion = `${PROMPT} -> ${COMPLETION}`;
        await withGenAiToolSpan({ toolName: "search_issues" }, async () => 1);
        record({
          responseModel: "claude-opus-4-8-20260101",
          inputTokens: 11,
          outputTokens: 5,
          finishReasons: ["stop"],
          costUsd: 0.001,
          estimated: false,
        });
        return completion;
      },
    );
    expect(out).toContain(COMPLETION); // the value still flows to the caller unchanged

    await __closeSentryForTest(); // flushes the capturing transport

    expect(sink.length).toBeGreaterThan(0);
    const attrs = collectGenAiAttrs(sink);
    expect(attrs["gen_ai.operation.name"]).toBeDefined();
    expect(attrs["gen_ai.provider.name"]).toBe("anthropic");
    expect(attrs["gen_ai.request.model"]).toBe("claude-opus-4-8");
    expect(attrs["gen_ai.response.model"]).toBe("claude-opus-4-8-20260101");
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(11);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(5);
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(attrs["naary.gen_ai.usage.cost_usd"]).toBe(0.001);
    // The nested tool span exported too (its own execute_tool attributes).
    expect(attrs["gen_ai.tool.name"]).toBe("search_issues");
    expect(attrs["gen_ai.tool.type"]).toBe("function");

    // THE privacy assertion: scan the ENTIRE captured envelope — every span, attribute, event,
    // breadcrumb — for either sentinel.
    const exported = JSON.stringify(sink);
    expect(exported).not.toContain(PROMPT);
    expect(exported).not.toContain(COMPLETION);
  });
});
