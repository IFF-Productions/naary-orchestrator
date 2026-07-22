import { ApplicationFailure } from "@temporalio/activity";
import { MissingCredentialError } from "@naary/secrets";
import {
  __setObjectStore,
  isClaimCheck,
  MemoryObjectStore,
} from "@naary/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TRACE_FIELD_CHARS,
  MAX_TRACE_STEPS,
  resolveDriver,
} from "../src/temporal/code-agent-drivers";
import { __codeAgentDeps, callCodeAgent } from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "wf-1", nodeId: "n1" };
const CFG = { tool: "claude" as const, prompt: "review the auth module" };

const getDecryptedKey = vi.fn();
const recordUsage = vi.fn();
const exec = vi.fn();

/** A well-formed final `type:"result"` message — the last line of a `stream-json` stream (and,
 *  when it's the whole stdout, a complete minimal stream on its own). `usage` mirrors the real
 *  stream-json shape (the older `json` mode used `total_usage`; the parser accepts either). */
const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Looks fine — no issues found.",
    is_error: false,
    session_id: "sess-abc",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 1200, output_tokens: 340 },
    ...over,
  });

/** A multi-line `stream-json` NDJSON stream: system init, assistant text + tool_use, a
 *  tool_result, then the final result — the real shape `claude -p --output-format stream-json
 *  --verbose` emits (confirmed against the CLI). */
const streamLog = (over: Record<string, unknown> = {}) =>
  [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc" }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Let me look at the auth module." }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "src/auth.ts" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "…file contents…",
            is_error: false,
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "Grep",
            input: { pattern: "login" },
          },
        ],
      },
    }),
    "", // blank line — must be tolerated
    "not-json-garbage", // partial/garbage line — must be tolerated
    envelope(over),
  ].join("\n");

beforeEach(() => {
  getDecryptedKey.mockReset().mockResolvedValue("sk-ant-xxx");
  recordUsage.mockReset().mockResolvedValue(undefined);
  exec.mockReset().mockResolvedValue({ stdout: envelope(), exitCode: 0 });
  __codeAgentDeps.getCredentials = (() => ({ getDecryptedKey })) as never;
  __codeAgentDeps.getDefaultEnvId = (() => Promise.resolve("e1")) as never;
  __codeAgentDeps.recordUsage = recordUsage as never;
  __codeAgentDeps.exec = exec as never;
});

afterEach(() => {
  // Reset the claim-check object store the offload test injects, back to the lazy default.
  __setObjectStore(undefined);
});

describe("claude driver (pure)", () => {
  const d = resolveDriver("claude");

  it("builds a READ-ONLY argv: plan mode + clamped Read/Grep/Glob, no Bash/write", () => {
    const args = d.buildArgs({ prompt: "hi", maxTurns: 5, maxBudgetUsd: 2 });
    expect(args).toContain("-p");
    expect(args).toContain("hi");
    // read-only posture
    const i = args.indexOf("--permission-mode");
    expect(args[i + 1]).toBe("plan");
    const t = args.indexOf("--allowedTools");
    expect(args[t + 1]).toBe("Read,Grep,Glob");
    expect(args.join(" ")).not.toContain("Bash");
    // streaming trace: stream-json REQUIRES --verbose in -p mode
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    // caps threaded through
    expect(args).toEqual(expect.arrayContaining(["--max-turns", "5"]));
    expect(args).toEqual(expect.arrayContaining(["--max-budget-usd", "2"]));
  });

  it("builds a WRITE argv: acceptEdits + Edit/Write added, still no Bash", () => {
    const args = d.buildArgs({ prompt: "fix it", write: true });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      "Read,Grep,Glob,Edit,Write",
    );
    expect(args.join(" ")).not.toContain("Bash");
  });

  it("parses the JSON envelope → normalized result/usage/session", () => {
    const env = d.parse(envelope(), 0);
    expect(env.isError).toBe(false);
    expect(env.result).toContain("no issues");
    expect(env.sessionId).toBe("sess-abc");
    expect(env.usage?.costUsd).toBe(0.0123);
    expect(env.usage?.inputTokens).toBe(1200);
  });

  it("flags is_error (even on exit 0) and unparseable output as errors", () => {
    expect(d.parse(envelope({ is_error: true }), 0).isError).toBe(true);
    expect(d.parse(envelope(), 1).isError).toBe(true); // non-zero exit
    expect(d.parse("not json", 0).isError).toBe(true);
  });

  it("parses a multi-line stream-json stream → compact trace + final result (tolerating blank/garbage lines)", () => {
    const env = d.parse(streamLog(), 0);
    // Final envelope fields still read from the `type:"result"` line.
    expect(env.isError).toBe(false);
    expect(env.result).toContain("no issues");
    expect(env.sessionId).toBe("sess-abc");
    expect(env.usage?.inputTokens).toBe(1200);
    // Trace: assistant reasoning, the two tool calls (NAME + input summary), then the result.
    const trace = env.trace ?? [];
    const assistant = trace.find((s) => s.kind === "assistant");
    expect(assistant?.text).toContain("auth module");
    const tools = trace.filter((s) => s.kind === "tool");
    expect(tools.map((t) => t.tool)).toEqual(["Read", "Grep"]);
    expect(tools[0].toolInput).toContain("src/auth.ts");
    expect(tools[1].toolInput).toContain("login");
    const result = trace.find((s) => s.kind === "result");
    expect(result?.text).toContain("no issues");
    // No tool_result BODY leaks into the trace (kept compact / blob-free).
    expect(JSON.stringify(trace)).not.toContain("file contents");
  });

  it("flags is_error on the stream's final result (even on exit 0)", () => {
    const env = d.parse(streamLog({ is_error: true }), 0);
    expect(env.isError).toBe(true);
    expect(env.trace?.find((s) => s.kind === "result")?.isError).toBe(true);
  });

  it("with NO result line (process died) keeps no_envelope failure — but surfaces the partial trace", () => {
    const partial = streamLog()
      .split("\n")
      .filter((l) => !l.includes('"type":"result"'))
      .join("\n");
    const env = d.parse(partial, 0);
    expect(env.result).toBe("");
    expect(env.isError).toBe(true);
    // The partial trace is still captured (useful to debug the crash).
    expect((env.trace ?? []).some((s) => s.kind === "tool")).toBe(true);
  });

  it("caps the trace at MAX_TRACE_STEPS and truncates over-long fields", () => {
    const longText = "x".repeat(MAX_TRACE_FIELD_CHARS + 500);
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      // One over-long assistant field to prove per-field truncation.
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: longText }] },
      }),
      // Far more than the cap to prove the step cap + truncation marker.
      ...Array.from({ length: MAX_TRACE_STEPS + 50 }, () =>
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "step" }] },
        }),
      ),
      envelope(),
    ].join("\n");
    const env = d.parse(lines, 0);
    const trace = env.trace ?? [];
    // Bounded: never more than the cap + the synthetic truncation marker.
    expect(trace.length).toBeLessThanOrEqual(MAX_TRACE_STEPS + 1);
    expect(trace.some((s) => s.kind === "truncated")).toBe(true);
    // Every field is within the per-field bound.
    const over = trace.find(
      (s) => (s.text?.length ?? 0) > MAX_TRACE_FIELD_CHARS + 40,
    );
    expect(over).toBeUndefined();
  });

  it("resolves only claude today; cursor/copilot throw", () => {
    expect(() => resolveDriver("cursor")).toThrow(/isn't available/);
  });
});

describe("callCodeAgent activity", () => {
  it("fetches the DEDICATED claude-code credential (not the anthropic key) + passes an API key as ANTHROPIC_API_KEY", async () => {
    await callCodeAgent(CFG, {}, META);
    // Separate credential slot from the model-provider `anthropic` key.
    expect(getDecryptedKey).toHaveBeenCalledWith("t1", "e1", "claude-code");
    const [binary, , opts] = exec.mock.calls[0];
    expect(binary).toBe("claude");
    // sk-ant-xxx is an API-key-shaped token → ANTHROPIC_API_KEY (not the OAuth var).
    expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // the key is NOT in the returned output
    const out = await callCodeAgent(CFG, {}, META);
    expect(JSON.stringify(out)).not.toContain("sk-ant-xxx");
  });

  it("routes a subscription setup-token (sk-ant-oat…) to CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY", async () => {
    const oatToken = "sk-ant-oat-fake"; // obviously-fake; only the sk-ant-oat prefix matters here
    getDecryptedKey.mockResolvedValue(oatToken);
    await callCodeAgent(CFG, {}, META);
    const [, , opts] = exec.mock.calls[0];
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(oatToken);
    // Exactly one auth var — the API-key var must NOT also be set (avoids CLI precedence ambiguity).
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("records usage from the CLI envelope + returns its cost (never zero)", async () => {
    const out = await callCodeAgent(CFG, {}, META);
    expect(recordUsage).toHaveBeenCalledOnce();
    const usageArg = recordUsage.mock.calls[0][0];
    expect(usageArg.usage.inputTokens).toBe(1200);
    expect(out.costUsd).toBe(0.0123);
    expect(out.output.result).toContain("no issues");
    expect(out.output.tool).toBe("claude");
  });

  it("fail-safe usage: estimates tokens (incl. the prompt, never zero) when the CLI omits usage", async () => {
    exec.mockResolvedValue({
      stdout: envelope({ usage: undefined, total_cost_usd: undefined }),
      exitCode: 0,
    });
    // A long prompt so the estimate MUST reflect it (regression: prompt was omitted).
    const bigPrompt = "audit the payment flow. ".repeat(40);
    await callCodeAgent({ ...CFG, prompt: bigPrompt }, {}, META);
    const usageArg = recordUsage.mock.calls[0][0];
    expect(usageArg.usage.outputTokens).toBeGreaterThan(0);
    // The prompt (~char/4) must be counted — else usage-less runs under-bill.
    expect(usageArg.usage.inputTokens).toBeGreaterThanOrEqual(
      Math.floor(bigPrompt.length / 4),
    );
  });

  it("a CLI-reported failure carries the reason into the type + message (#551), bills the attempt", async () => {
    // The CLI's `subtype` is threaded into the error type (so Sentry groups by reason, not one
    // undiagnosable CODE_AGENT_FAILED bucket) and the message (so the run detail says why).
    exec.mockResolvedValue({
      stdout: envelope({ is_error: true, subtype: "error_max_turns" }),
      exitCode: 0,
    });
    const err = await callCodeAgent(CFG, {}, META).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("CODE_AGENT_FAILED:error_max_turns");
    expect(err.message).toContain("error_max_turns");
    expect(recordUsage).toHaveBeenCalledOnce(); // billed even on failure
  });

  it("a failure with no CLI subtype still fails (reason falls back), never reasonless", async () => {
    exec.mockResolvedValue({ stdout: "not json", exitCode: 1 }); // process died pre-envelope
    const err = await callCodeAgent(CFG, {}, META).catch((e) => e);
    expect(err.type).toBe("CODE_AGENT_FAILED:no_envelope");
    expect(err.nonRetryable).toBe(true);
  });

  it("maps a missing credential to a non-retryable AUTH failure", async () => {
    getDecryptedKey.mockRejectedValue(
      new MissingCredentialError("t1", "claude-code"),
    );
    await expect(callCodeAgent(CFG, {}, META)).rejects.toMatchObject({
      type: "AUTH",
      nonRetryable: true,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("throws a GENERIC retryable failure — the raw subprocess error never leaks", async () => {
    exec.mockRejectedValue(
      new Error(`spawn boom key=sk-leak prompt=${CFG.prompt}`),
    );
    const err = await callCodeAgent(CFG, {}, META).catch((e) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err.nonRetryable).toBe(false);
    // Assert on `err.message` DIRECTLY (it's non-enumerable, so JSON.stringify alone would
    // miss it) — Temporal history serializes the message, so it must carry no raw material.
    expect(err.message).toBe("The coding CLI run failed (transient).");
    expect(err.message).not.toContain("sk-leak");
    expect(err.message).not.toContain(CFG.prompt);
    expect(JSON.stringify(err)).not.toContain("sk-leak");
  });

  it("WRITE mode dispatches to the sandbox-runner (runWrite) and surfaces the diff", async () => {
    const runWrite = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: envelope(),
      diff: "diff --git a/x b/x",
    });
    __codeAgentDeps.runWrite = runWrite as never;
    const out = await callCodeAgent(
      {
        ...CFG,
        mode: "write",
        repo: "acme/widgets",
        connectionId: "conn-gh",
      },
      {},
      META,
    );
    // Dispatched to the runner with the WRITE argv + the resolved credential, NOT the in-worker exec.
    expect(runWrite).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
    const wp = runWrite.mock.calls[0][0];
    expect(wp.repo).toBe("acme/widgets");
    expect(wp.keyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(wp.agentArgs).toContain("acceptEdits");
    // The (small) diff is surfaced inline on the node output.
    expect(out.output.diff).toBe("diff --git a/x b/x");
    expect(out.output.result).toContain("no issues");
  });

  it("WRITE mode without repo/connectionId is a non-retryable config failure", async () => {
    await expect(
      callCodeAgent({ ...CFG, mode: "write" }, {}, META),
    ).rejects.toMatchObject({
      type: "CODE_AGENT_WRITE_CONFIG",
      nonRetryable: true,
    });
  });

  it("surfaces a small trace INLINE on the node output", async () => {
    exec.mockResolvedValue({ stdout: streamLog(), exitCode: 0 });
    const out = await callCodeAgent(CFG, {}, META);
    expect(Array.isArray(out.output.trace)).toBe(true);
    const tools = (
      out.output.trace as { kind: string; tool?: string }[]
    ).filter((s) => s.kind === "tool");
    expect(tools.map((t) => t.tool)).toEqual(["Read", "Grep"]);
  });

  it("OFFLOADS a large trace as a claim-check ref (keeps Temporal history under the payload cap)", async () => {
    __setObjectStore(new MemoryObjectStore());
    // A trace whose serialization exceeds the 1MB claim-check threshold: MAX_TRACE_STEPS
    // full-width assistant steps (each ~MAX_TRACE_FIELD_CHARS) → well over 1MB.
    const big = "y".repeat(MAX_TRACE_FIELD_CHARS);
    const lines = [
      ...Array.from({ length: MAX_TRACE_STEPS }, () =>
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: big }] },
        }),
      ),
      envelope(),
    ].join("\n");
    exec.mockResolvedValue({ stdout: lines, exitCode: 0 });
    const out = await callCodeAgent(CFG, {}, META);
    // The trace became a claim-check REFERENCE, not an inline blob.
    expect(isClaimCheck(out.output.trace)).toBe(true);
    expect((out.output.trace as { __claimCheck: string }).__claimCheck).toMatch(
      /^mem:\/\//,
    );
    // The heavy trace text is NOT inline in the returned payload (it went to the store).
    expect(JSON.stringify(out.output)).not.toContain(big);
  });
});
