import { ApplicationFailure } from "@temporalio/activity";
import { MissingCredentialError } from "@naary/secrets";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDriver } from "../src/temporal/code-agent-drivers";
import { __codeAgentDeps, callCodeAgent } from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "wf-1", nodeId: "n1" };
const CFG = { tool: "claude" as const, prompt: "review the auth module" };

const getDecryptedKey = vi.fn();
const recordUsage = vi.fn();
const exec = vi.fn();

/** A well-formed `claude -p --output-format json` envelope. */
const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    result: "Looks fine — no issues found.",
    is_error: false,
    session_id: "sess-abc",
    total_cost_usd: 0.0123,
    total_usage: { input_tokens: 1200, output_tokens: 340 },
    ...over,
  });

beforeEach(() => {
  getDecryptedKey.mockReset().mockResolvedValue("sk-ant-xxx");
  recordUsage.mockReset().mockResolvedValue(undefined);
  exec.mockReset().mockResolvedValue({ stdout: envelope(), exitCode: 0 });
  __codeAgentDeps.getCredentials = (() => ({ getDecryptedKey })) as never;
  __codeAgentDeps.recordUsage = recordUsage as never;
  __codeAgentDeps.exec = exec as never;
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
    // caps threaded through
    expect(args).toEqual(expect.arrayContaining(["--max-turns", "5"]));
    expect(args).toEqual(expect.arrayContaining(["--max-budget-usd", "2"]));
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

  it("resolves only claude today; cursor/copilot throw", () => {
    expect(() => resolveDriver("cursor")).toThrow(/isn't available/);
  });
});

describe("callCodeAgent activity", () => {
  it("fetches the DEDICATED claude-code credential (not the anthropic key) + passes an API key as ANTHROPIC_API_KEY", async () => {
    await callCodeAgent(CFG, {}, META);
    // Separate credential slot from the model-provider `anthropic` key.
    expect(getDecryptedKey).toHaveBeenCalledWith("t1", "claude-code");
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
      stdout: envelope({ total_usage: undefined, total_cost_usd: undefined }),
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

  it("a CLI-reported failure (is_error) bills the attempt, then throws CODE_AGENT_FAILED", async () => {
    exec.mockResolvedValue({
      stdout: envelope({ is_error: true }),
      exitCode: 0,
    });
    await expect(callCodeAgent(CFG, {}, META)).rejects.toMatchObject({
      type: "CODE_AGENT_FAILED",
      nonRetryable: true,
    });
    expect(recordUsage).toHaveBeenCalledOnce(); // billed even on failure
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
});
