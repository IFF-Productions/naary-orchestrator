import { ApplicationFailure } from "@temporalio/activity";
import { MissingCredentialError } from "@naary/secrets";
import { MODEL_PRICING } from "@naary/usage";
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
// The sandbox dispatch — #680 removed the in-worker subprocess entirely, so EVERY run (read and
// write) goes through this seam. There is no `exec` seam left to stub.
const runWrite = vi.fn();

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
  runWrite.mockReset().mockResolvedValue({
    stdout: envelope(),
    stderr: "",
    exitCode: 0,
    diff: "",
  });
  __codeAgentDeps.getCredentials = (() => ({ getDecryptedKey })) as never;
  __codeAgentDeps.getDefaultEnvId = (() => Promise.resolve("e1")) as never;
  __codeAgentDeps.recordUsage = recordUsage as never;
  __codeAgentDeps.runWrite = runWrite as never;
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

  it("resolves claude/cursor/copilot; an unknown tool throws cleanly", () => {
    expect(resolveDriver("claude").tool).toBe("claude");
    expect(resolveDriver("cursor").tool).toBe("cursor");
    expect(resolveDriver("copilot").tool).toBe("copilot");
    expect(resolveDriver("gemini").tool).toBe("gemini");
    expect(resolveDriver(undefined).tool).toBe("claude"); // default
    expect(() => resolveDriver("nope")).toThrow(/unknown coding-CLI tool/);
  });
});

describe("cursorDriver (cursor-agent)", () => {
  const d = resolveDriver("cursor");

  it("authenticates via CURSOR_API_KEY", () => {
    expect(d.authEnv("cur_abc ")).toEqual({ CURSOR_API_KEY: "cur_abc" });
  });

  it("READ mode: headless json, no --force (cursor only PROPOSES edits)", () => {
    const args = d.buildArgs({ prompt: "review this", model: "sonnet-4" });
    expect(args).toEqual([
      "-p",
      "review this",
      "--output-format",
      "json",
      "--model",
      "sonnet-4",
    ]);
    expect(args).not.toContain("--force");
  });

  it("WRITE mode: adds --force; folds systemPrompt into the prompt", () => {
    const args = d.buildArgs({
      prompt: "do it",
      systemPrompt: "house rules",
      write: true,
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("house rules\n\ndo it");
    expect(args).toContain("--force");
  });

  it("parses the single json result object", () => {
    const env = d.parse(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "the plan",
        session_id: "s-1",
      }),
      0,
    );
    expect(env).toMatchObject({
      result: "the plan",
      sessionId: "s-1",
      isError: false,
    });
  });

  it("parses a PRETTY-PRINTED (multi-line) json object (#568 review — not a false no_envelope)", () => {
    const pretty = JSON.stringify(
      { type: "result", is_error: false, result: "multi\nline" },
      null,
      2,
    );
    expect(pretty).toContain("\n"); // genuinely multi-line
    const env = d.parse(pretty, 0);
    expect(env).toMatchObject({ result: "multi\nline", isError: false });
    expect(env.failureSubtype).toBeUndefined(); // NOT a spurious no_envelope
  });

  it("flags is_error / a non-zero exit / a missing envelope", () => {
    expect(
      d.parse('{"type":"result","is_error":true,"result":"x"}', 0),
    ).toMatchObject({ isError: true });
    expect(d.parse('{"type":"result","result":"x"}', 1).isError).toBe(true);
    expect(d.parse("boom (not json)", 1)).toMatchObject({
      isError: true,
      failureSubtype: "no_envelope",
    });
  });
});

describe("copilotDriver (copilot)", () => {
  const d = resolveDriver("copilot");

  it("authenticates via the dedicated COPILOT_GITHUB_TOKEN", () => {
    expect(d.authEnv("ght_x ")).toEqual({ COPILOT_GITHUB_TOKEN: "ght_x" });
  });

  it("READ mode: read allowed, write + shell denied (no-Bash parity)", () => {
    const args = d.buildArgs({ prompt: "explain" });
    expect(args.slice(0, 4)).toEqual([
      "-p",
      "explain",
      "--output-format",
      "json",
    ]);
    // read allowed; write + shell denied
    expect(argPairs(args, "--allow-tool")).toEqual(["read"]);
    expect(argPairs(args, "--deny-tool")).toEqual(["write", "shell"]);
  });

  it("WRITE mode: allows write, still denies shell", () => {
    const args = d.buildArgs({ prompt: "fix", write: true });
    expect(argPairs(args, "--allow-tool")).toEqual(["read", "write"]);
    expect(argPairs(args, "--deny-tool")).toEqual(["shell"]);
  });

  it("parses the terminal JSONL object defensively (result across field names)", () => {
    const jsonl = [
      JSON.stringify({ type: "start" }),
      JSON.stringify({ type: "assistant", content: "thinking" }),
      JSON.stringify({ type: "result", response: "the answer" }),
    ].join("\n");
    expect(d.parse(jsonl, 0)).toMatchObject({
      result: "the answer",
      isError: false,
    });
  });

  it("flags an error object / non-zero exit / missing envelope", () => {
    expect(d.parse('{"error":"boom"}', 0).isError).toBe(true);
    expect(d.parse('{"result":"x"}', 3).isError).toBe(true);
    expect(d.parse("", 1)).toMatchObject({
      isError: true,
      failureSubtype: "no_envelope",
    });
  });
});

/**
 * geminiDriver (`gemini`). Every assertion here corresponds to behaviour verified IN-CONTAINER
 * against the pinned CLI version (deploy/sandbox/gemini.Dockerfile) — this CLI has three habits no
 * other driver has, and each one is a way to get isolation or diagnosability silently wrong.
 */
describe("geminiDriver (gemini)", () => {
  const d = resolveDriver("gemini");

  it("authenticates via GEMINI_API_KEY (its own slot, not the `google` model key)", () => {
    expect(d.authEnv(" gk_abc ")).toEqual({ GEMINI_API_KEY: "gk_abc" });
    expect(d.credentialProvider).toBe("gemini-cli");
  });

  it("READ mode: --approval-mode plan AND --skip-trust (the clamp FAILS OPEN without it)", () => {
    const args = d.buildArgs({
      prompt: "review this",
      model: "gemini-2.5-pro",
    });
    expect(args.slice(0, 4)).toEqual(["-p", "review this", "-o", "json"]);
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("plan");
    // THE load-bearing flag. In an untrusted directory — which every fresh sandbox mount is —
    // the CLI prints "Approval mode overridden to 'default' because the current folder is not
    // trusted" and aborts (exit 55). The override is the dangerous half: it DOWNGRADES the
    // read-only clamp. Verified in-container that --skip-trust removes it. Never drop this.
    expect(args).toContain("--skip-trust");
    expect(args).toEqual(expect.arrayContaining(["-m", "gemini-2.5-pro"]));
  });

  it("WRITE mode: auto_edit, never yolo (yolo would auto-approve shell too)", () => {
    const args = d.buildArgs({ prompt: "fix it", write: true });
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("auto_edit");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("-y");
    expect(args).toContain("--skip-trust");
  });

  it("folds the system prompt into the prompt (the CLI has no append-system flag)", () => {
    const args = d.buildArgs({ prompt: "task", systemPrompt: "house rules" });
    expect(args[1]).toBe("house rules\n\ntask");
  });

  it("parses the PRETTY-PRINTED success envelope from stdout", () => {
    // Its JSON spans many lines, so a per-line JSONL parse sees nothing — the whole-buffer
    // fast path is what catches it.
    const out = JSON.stringify({ response: "all good", stats: {} }, null, 2);
    expect(d.parse(out, 0)).toMatchObject({
      result: "all good",
      isError: false,
    });
  });

  it("reads the failure envelope from STDERR — stdout is empty on a failed run", () => {
    // Verified: an invalid-key run wrote zero bytes to stdout and the envelope to stderr. Without
    // reading stderr this is an undiagnosable `no_envelope`, on the run that most needs a reason.
    const errEnvelope = JSON.stringify({
      session_id: "s-1",
      error: { type: "Error", message: "API key not valid", code: 400 },
    });
    const env = d.parse("", 144, errEnvelope);
    expect(env.isError).toBe(true);
    // The API's own status code drives the Sentry fingerprint (#551), not a bare exit code.
    expect(env.failureSubtype).toBe("error_400");
    expect(env.sessionId).toBe("s-1");
  });

  it("still reports a reason when both streams are empty, and never a false success", () => {
    expect(d.parse("", 1)).toMatchObject({
      isError: true,
      failureSubtype: "no_envelope",
    });
    // A zero exit with an error object is STILL a failure (mirrors claude's is_error handling).
    expect(d.parse(JSON.stringify({ error: { code: 429 } }), 0).isError).toBe(
      true,
    );
  });

  it("prices against a Google model, not a Claude one", () => {
    // The ledger throws UnknownModelPricingError AFTER the CLI has run and cost money, so a
    // driver whose default model has no row for its provider is a billing landmine.
    expect(d.defaultPricingModel).toBe("gemini-2.5-pro");
    expect(
      MODEL_PRICING[d.credentialProvider]?.[d.defaultPricingModel],
    ).toBeDefined();
  });

  it("cannot enforce an output schema (the activity refuses one rather than guessing)", () => {
    expect(d.capabilities.structuredOutput).toBe(false);
  });
});

/** Every driver must price against a model its own provider actually has a row for. */
describe("driver pricing defaults", () => {
  it.each(["claude", "cursor", "copilot", "gemini"])(
    "%s has a priced default model",
    (tool) => {
      const d = resolveDriver(tool);
      expect(
        MODEL_PRICING[d.credentialProvider]?.[d.defaultPricingModel],
        `${tool} → ${d.credentialProvider}/${d.defaultPricingModel}`,
      ).toBeDefined();
    },
  );
});

/** Collect the value after each occurrence of `flag` in an argv (order preserved). */
function argPairs(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}

describe("callCodeAgent activity", () => {
  it("fetches the DEDICATED claude-code credential (not the anthropic key) + passes an API key as ANTHROPIC_API_KEY", async () => {
    await callCodeAgent(CFG, {}, META);
    // Separate credential slot from the model-provider `anthropic` key.
    expect(getDecryptedKey).toHaveBeenCalledWith("t1", "e1", "claude-code");
    const wp = runWrite.mock.calls[0][0];
    // The runner is told WHICH TOOL to run — never an image name (it holds the Docker socket).
    expect(wp.tool).toBe("claude");
    // sk-ant-xxx is an API-key-shaped token → ANTHROPIC_API_KEY (not the OAuth var).
    expect(wp.keyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(wp.authKey).toBe("sk-ant-xxx");
    // the key is NOT in the returned output
    const out = await callCodeAgent(CFG, {}, META);
    expect(JSON.stringify(out)).not.toContain("sk-ant-xxx");
  });

  it("routes a subscription setup-token (sk-ant-oat…) to CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY", async () => {
    const oatToken = "sk-ant-oat-fake"; // obviously-fake; only the sk-ant-oat prefix matters here
    getDecryptedKey.mockResolvedValue(oatToken);
    await callCodeAgent(CFG, {}, META);
    const wp = runWrite.mock.calls[0][0];
    // Exactly ONE auth var is forwarded, and it's the right one for this token kind — the runner
    // sets only `keyEnvVar` in the container, so there's no CLI precedence ambiguity.
    expect(wp.keyEnvVar).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(wp.authKey).toBe(oatToken);
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
    runWrite.mockResolvedValue({
      stdout: envelope({ usage: undefined, total_cost_usd: undefined }),
      exitCode: 0,
      diff: "",
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
    runWrite.mockResolvedValue({
      stdout: envelope({ is_error: true, subtype: "error_max_turns" }),
      exitCode: 0,
      diff: "",
    });
    const err = await callCodeAgent(CFG, {}, META).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("CODE_AGENT_FAILED:error_max_turns");
    expect(err.message).toContain("error_max_turns");
    expect(recordUsage).toHaveBeenCalledOnce(); // billed even on failure
  });

  it("a failure with no CLI subtype still fails (reason falls back), never reasonless", async () => {
    runWrite.mockResolvedValue({ stdout: "not json", exitCode: 1, diff: "" }); // died pre-envelope
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
    expect(runWrite).not.toHaveBeenCalled();
  });

  it("throws a GENERIC retryable failure — the raw subprocess error never leaks", async () => {
    runWrite.mockRejectedValue(
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
    // Dispatched to the runner with the WRITE argv + the resolved credential.
    expect(runWrite).toHaveBeenCalledOnce();
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

  // --- READ mode is ALWAYS sandboxed (#594/#680) -------------------------------------------
  // The CODE_AGENT_SANDBOX_READ opt-in is gone along with the in-worker exec it guarded. These
  // tests are the regression fence: there must be no config under which a read run happens
  // anywhere but the sandbox.
  it("READ mode dispatches to the sandbox with read-only argv and no PR — no flag involved", async () => {
    const out = await callCodeAgent(
      { ...CFG, repo: "acme/widgets", connectionId: "conn-gh" },
      {},
      META,
    );
    expect(runWrite).toHaveBeenCalledOnce();
    const wp = runWrite.mock.calls[0][0];
    expect(wp.mode).toBe("read");
    expect(wp.openPr).toBe(false); // read never opens a PR
    expect(wp.agentArgs).toContain("plan"); // read-only argv
    expect(out.output.diff).toBeUndefined(); // a read run makes no edits
  });

  it("READ mode with NO repo still goes to the sandbox (the runner's ephemeral workspace)", async () => {
    // This is the case that used to be the un-isolated in-worker exec — a plain "ask the agent"
    // node. It must NOT have become a config error, and it must NOT run locally.
    const out = await callCodeAgent(CFG, {}, META); // CFG has no mode/repo → read, no repo
    expect(runWrite).toHaveBeenCalledOnce();
    const wp = runWrite.mock.calls[0][0];
    expect(wp.mode).toBe("read");
    expect(wp.repo).toBeUndefined();
    expect(wp.connectionId).toBeUndefined();
    expect(out.output.result).toContain("no issues");
  });

  it("even with the removed flag set to 'true', behaviour is identical (it is not read any more)", async () => {
    const prev = process.env.CODE_AGENT_SANDBOX_READ;
    process.env.CODE_AGENT_SANDBOX_READ = "true";
    try {
      await callCodeAgent(CFG, {}, META);
      expect(runWrite).toHaveBeenCalledOnce();
    } finally {
      // Restore, don't blanket-delete: a dev shell exporting the flag would otherwise have it
      // stripped for every later test in this file (order-dependent failures).
      if (prev === undefined) delete process.env.CODE_AGENT_SANDBOX_READ;
      else process.env.CODE_AGENT_SANDBOX_READ = prev;
    }
  });

  it("a read node WITH a repo but no connection is a non-retryable config failure", async () => {
    await expect(
      callCodeAgent({ ...CFG, repo: "acme/widgets" }, {}, META),
    ).rejects.toMatchObject({
      type: "CODE_AGENT_READ_CONFIG",
      nonRetryable: true,
    });
    expect(runWrite).not.toHaveBeenCalled();
  });

  it("surfaces a small trace INLINE on the node output", async () => {
    runWrite.mockResolvedValue({ stdout: streamLog(), exitCode: 0, diff: "" });
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
    runWrite.mockResolvedValue({ stdout: lines, exitCode: 0, diff: "" });
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

/**
 * STRUCTURED OUTPUT — the codeAgent node's `outputSchema` (parity with the agent node's).
 *
 * Enforced by the CLI, not by prompting: `claude --json-schema <schema>` constrains the model and
 * puts the PARSED answer on the final result message as `structured_output`. Verified live against
 * the version the image pins, in the `stream-json` mode this driver actually runs — the earlier
 * `--output-format json` probe could not be assumed to carry over.
 */
describe("callCodeAgent — structured output", () => {
  const SCHEMA = {
    type: "object",
    properties: { severity: { type: "string" } },
    required: ["severity"],
  };

  it("passes the schema to the CLI and returns the parsed object", async () => {
    runWrite.mockResolvedValue({
      stdout: envelope({
        result: '{"severity":"high"}',
        structured_output: { severity: "high" },
      }),
      exitCode: 0,
      diff: "",
    });

    const res = await callCodeAgent(
      { ...CFG, outputSchema: SCHEMA },
      undefined,
      META,
    );

    const args = runWrite.mock.calls[0][0].agentArgs as string[];
    const i = args.indexOf("--json-schema");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(args[i + 1])).toEqual(SCHEMA);
    expect(res.output.structured).toEqual({ severity: "high" });
    // The text result is UNCHANGED, so an existing `.result` binding keeps working.
    expect(res.output.result).toBe('{"severity":"high"}');
  });

  it("sends no --json-schema when the node declares none", async () => {
    runWrite.mockResolvedValue({
      stdout: envelope({ result: "a plan" }),
      exitCode: 0,
      diff: "",
    });

    const res = await callCodeAgent(CFG, undefined, META);

    expect(runWrite.mock.calls[0][0].agentArgs).not.toContain("--json-schema");
    expect(res.output.structured).toBeUndefined();
  });

  /**
   * REFUSES rather than approximating. A driver that can't constrain the model would hand back
   * prose in a field the graph reads as typed data — a run that looks successful and is wrong.
   * Non-retryable: no retry fixes a capability.
   */
  /** The refusal must come BEFORE any I/O, so a tenant with no credential still gets the real,
   *  actionable cause instead of "missing credential" (raised in review). */
  it("refuses before touching the credential store", async () => {
    getDecryptedKey.mockRejectedValue(new Error("should not be reached"));

    await expect(
      callCodeAgent(
        { tool: "cursor", prompt: "classify", outputSchema: SCHEMA },
        undefined,
        META,
      ),
    ).rejects.toMatchObject({ type: "CODE_AGENT_NO_STRUCTURED_OUTPUT" });
    expect(getDecryptedKey).not.toHaveBeenCalled();
  });

  it("refuses a schema on a driver that cannot enforce one", async () => {
    await expect(
      callCodeAgent(
        { tool: "cursor", prompt: "classify", outputSchema: SCHEMA },
        undefined,
        META,
      ),
    ).rejects.toMatchObject({ nonRetryable: true });
    // Never dispatched — the refusal is BEFORE the CLI runs, so no tokens are spent.
    expect(runWrite).not.toHaveBeenCalled();
  });

  it("names the fix in the refusal", async () => {
    const err = await callCodeAgent(
      { tool: "copilot", prompt: "classify", outputSchema: SCHEMA },
      undefined,
      META,
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/cannot enforce an output schema/);
    expect(err?.message).toMatch(/switch this node's tool to 'claude'/);
  });

  /** A CLI that returned the wrong SHAPE must not reach ctx as structured data. */
  it("ignores a non-object structured_output", async () => {
    for (const bad of ["a string", 42, ["a"], null]) {
      runWrite.mockResolvedValue({
        stdout: envelope({ result: "x", structured_output: bad }),
        exitCode: 0,
        diff: "",
      });
      const res = await callCodeAgent(
        { ...CFG, outputSchema: SCHEMA },
        undefined,
        META,
      );
      expect(res.output.structured, JSON.stringify(bad)).toBeUndefined();
    }
  });
});
