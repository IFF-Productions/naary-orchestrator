// Agent guardrails (#576) — IN-ACTIVITY enforcement in runAgent: tool deny/forced-approval
// refusal, input/output content rules, and PII redaction.
//
// The PII block at the bottom is the #576 AC3 test. It asserts what redaction can actually
// guarantee, and says plainly what it cannot — see the comment on that describe.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGuardrailPolicy } from "@naary/dsl";

const generateText = vi.fn();
vi.mock("ai", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  generateText: (...args: unknown[]) => generateText(...args),
}));

// Capture every structured log line the activity emits, so the AC3 test can assert that NO log
// record carries raw PII (a claim you cannot make by reading the code alone).
const logRecords: unknown[] = [];
vi.mock("@naary/logging", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const capture =
    (level: string) =>
    (...args: unknown[]) => {
      logRecords.push({ level, args });
    };
  const logger = {
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
    debug: capture("debug"),
    child: () => logger,
  };
  return { ...real, createLogger: () => logger };
});

import { __agentDeps, runAgent } from "../src/temporal/activities";

const META = {
  tenantId: "t1",
  environmentId: "e1",
  executionId: "exec-1",
  nodeId: "agent",
};
const CFG = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  systemPrompt: "classify the ticket",
};

let policy: AgentGuardrailPolicy = {};
const recordUsage = vi.fn();
const auditEvents: unknown[] = [];

beforeEach(() => {
  policy = {};
  logRecords.length = 0;
  auditEvents.length = 0;
  generateText.mockReset().mockResolvedValue({
    text: "ok",
    totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  recordUsage.mockReset().mockResolvedValue({ id: "evt_1" });
  __agentDeps.getCredentials = () =>
    ({ getDecryptedKey: () => Promise.resolve("sk-ant-fake") }) as never;
  __agentDeps.getDefaultEnvId = (() => Promise.resolve("e1")) as never;
  __agentDeps.recordUsage = recordUsage as never;
  __agentDeps.getBudget = (() => Promise.resolve(null)) as never;
  __agentDeps.reserveBudget = (() =>
    Promise.resolve({ ok: true, id: "res_1" })) as never;
  __agentDeps.releaseReservation = (() => Promise.resolve()) as never;
  __agentDeps.sendNotification = (() => Promise.resolve()) as never;
  __agentDeps.loadGuardrailPolicy = (() => Promise.resolve(policy)) as never;
  __agentDeps.recordAuditEvent = ((input: unknown) => {
    auditEvents.push(input);
    return Promise.resolve();
  }) as never;
});

afterEach(() => vi.clearAllMocks());

/** The `system` / `prompt` (or cached `messages`) the model was actually handed. */
function sentToModel(): string {
  const args = generateText.mock.calls[0]?.[0] as
    Record<string, unknown> | undefined;
  if (!args) return "";
  return JSON.stringify({
    system: args.system,
    prompt: args.prompt,
    messages: args.messages,
  });
}

/** Let the fire-and-forget audit writes settle (they are never awaited by the activity). */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("tool policy — in-activity enforcement (#576 AC1, runtime half)", () => {
  const withTool = {
    ...CFG,
    tools: [{ connectionId: "c1", tool: "delete_file" }],
  };

  it("a DENIED in-loop tool fails non-retryably and never reaches the model", async () => {
    policy = { tools: { deny: ["delete_*"] } };
    await expect(runAgent(withTool, {}, META)).rejects.toMatchObject({
      type: "GUARDRAIL_TOOL_DENIED",
      nonRetryable: true,
    });
    // The model was never called, no credential was spent, nothing was billed.
    expect(generateText).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    await flush();
    expect(auditEvents).toEqual([
      expect.objectContaining({
        tenantId: "t1",
        actor: "guardrail",
        action: "Blocked denied agent tool c1:delete_file",
        statusCode: 403,
        path: "/executions/exec-1/nodes/agent",
        environmentId: "e1",
      }),
    ]);
  });

  it("an ALLOWLIST that omits the tool denies it (fail closed)", async () => {
    policy = { tools: { allow: ["read_*"] } };
    await expect(runAgent(withTool, {}, META)).rejects.toMatchObject({
      type: "GUARDRAIL_TOOL_DENIED",
    });
  });

  it("a FORCED-APPROVAL tool inside the agent loop is REFUSED, not silently run", async () => {
    // The activity boundary makes a durable pause impossible here; running it unapproved would be
    // the exact hole the policy exists to close, so the honest outcome is a refusal that names the
    // fix. (The pause itself is exercised for standalone tool nodes in the interpreter e2e.)
    policy = { tools: { requireApproval: ["delete_*"] } };
    await expect(runAgent(withTool, {}, META)).rejects.toMatchObject({
      type: "GUARDRAIL_TOOL_NEEDS_APPROVAL",
      nonRetryable: true,
    });
    expect(generateText).not.toHaveBeenCalled();
    await flush();
    expect(auditEvents[0]).toMatchObject({
      action: "Blocked forced-approval agent tool c1:delete_file (in-loop)",
      statusCode: 403,
    });
  });

  it("an ALLOWED tool proceeds normally", async () => {
    policy = { tools: { allow: ["delete_*"] } };
    const r = await runAgent(withTool, {}, META);
    expect(r.status).toBe("ok");
    expect(generateText).toHaveBeenCalledOnce();
  });
});

describe("content rules", () => {
  it("a `fail` INPUT rule blocks before the model call, naming LABELS only", async () => {
    policy = {
      input: [{ label: "codename", kind: "keyword", pattern: "Bluebird" }],
    };
    await expect(
      runAgent(CFG, { note: "ship Project Bluebird" }, META),
    ).rejects.toMatchObject({
      type: "GUARDRAIL_CONTENT_BLOCKED",
      nonRetryable: true,
      message:
        "Agent input blocked by guardrail content rule(s): input:codename",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    await flush();
    // Neither the audit row nor the error message contains the matched TEXT.
    expect(JSON.stringify(auditEvents)).not.toContain("Bluebird");
  });

  it("a `strip` INPUT rule rewrites the prompt and lets the call proceed", async () => {
    policy = {
      input: [
        {
          label: "acct",
          kind: "regex",
          pattern: "ACCT-\\d{6}",
          action: "strip",
        },
      ],
    };
    const r = await runAgent(CFG, { note: "refund ACCT-123456 now" }, META);
    expect(sentToModel()).not.toContain("ACCT-123456");
    expect(sentToModel()).toContain("[BLOCKED]");
    expect(r.guardrails).toEqual({ violations: ["input:acct"] });
  });

  it("input rules also cover the SYSTEM prompt", async () => {
    policy = {
      input: [
        { label: "sys", kind: "keyword", pattern: "classify", action: "strip" },
      ],
    };
    await runAgent(CFG, { a: 1 }, META);
    expect(sentToModel()).not.toContain("classify");
  });

  it("a `fail` OUTPUT rule blocks the output BUT still records the spend (rule 6)", async () => {
    policy = {
      output: [{ label: "leak", kind: "keyword", pattern: "internal-only" }],
    };
    generateText.mockResolvedValue({
      text: "here is the internal-only memo",
      totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    await expect(runAgent(CFG, {}, META)).rejects.toMatchObject({
      type: "GUARDRAIL_CONTENT_BLOCKED",
      message: "Agent output blocked by guardrail content rule(s): output:leak",
    });
    // The provider call HAPPENED, so a zero would be a silently-free call.
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage.mock.calls[0][0].usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    });
    // #1060: the blocked path is a SECOND recordUsage call site in this file, so it gets its own
    // assertion — the provenance has to travel with the numbers down both branches, not just the
    // happy one. Here the provider reported real counts, so the row reads measured.
    expect(recordUsage.mock.calls[0][0].estimated).toBe(false);
    await flush();
    expect(auditEvents[0]).toMatchObject({
      action: "Blocked agent output by content rule(s) output:leak",
      statusCode: 403,
    });
  });

  it("a `strip` OUTPUT rule rewrites the node output leaf-wise", async () => {
    policy = {
      output: [
        { label: "leak", kind: "keyword", pattern: "sk-live", action: "strip" },
      ],
    };
    generateText.mockResolvedValue({
      output: { note: "the key is sk-live-abc", count: 3 },
      text: "",
      totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const r = await runAgent(
      { ...CFG, outputSchema: { type: "object" } },
      {},
      META,
    );
    // The structure survives (leaf-wise rewrite, never stringify→reparse) and the match is gone.
    expect(r.output).toEqual({ note: "the key is [BLOCKED]-abc", count: 3 });
    expect(r.guardrails).toEqual({ violations: ["output:leak"] });
  });

  it("an empty policy leaves the prompt byte-identical to the pre-#576 path", async () => {
    policy = {};
    await runAgent(CFG, { msg: "hello" }, META);
    const args = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(args.system).toBe("classify the ticket");
    expect(args.prompt).toBe(JSON.stringify({ msg: "hello" }));
  });
});

/**
 * #576 AC3 — "redaction demonstrably keeps raw PII out of workflow args, history, logs, and the
 * usage ledger".
 *
 * WHAT THIS PROVES, and the ONE BOUNDARY IT CANNOT:
 *  - PROVEN here: raw PII does not reach the model, the activity's RETURN value (which is what the
 *    interpreter writes into ctx and therefore into Temporal history), the usage-ledger write, or
 *    any structured log line; and the redaction MAP never leaves the activity.
 *  - NOT achievable by in-activity redaction, and deliberately not asserted: the agent node's
 *    INPUT is already a workflow argument by the time the activity runs, so PII a caller put in
 *    the trigger payload is in history before redaction can see it. The codebase states the same
 *    limit for the textToSpeech node's resolved text. Redaction governs what leaves the boundary
 *    (provider, ledger, logs, node output), not what the trigger already recorded.
 */
describe("PII redaction (#576 AC3)", () => {
  const PII_INPUT = {
    reporter: "ada@example.com",
    phone: "+1 (415) 555-0132",
    card: "4111 1111 1111 1111",
    ssn: "123-45-6789",
    host: "10.0.0.7",
  };
  const RAW = Object.values(PII_INPUT);

  beforeEach(() => {
    policy = { redact: { enabled: true } };
  });

  it("no raw PII reaches the provider; placeholders do", async () => {
    await runAgent(CFG, PII_INPUT, META);
    const sent = sentToModel();
    for (const raw of RAW) expect(sent).not.toContain(raw);
    expect(sent).toContain("[PII_EMAIL_1]");
    expect(sent).toContain("[PII_CREDITCARD_1]");
    expect(sent).toContain("[PII_SSN_1]");
    expect(sent).toContain("[PII_IPV4_1]");
    expect(sent).toContain("[PII_PHONE_1]");
  });

  it("no raw PII and no redaction map in the activity's RETURN value (⇒ none in ctx/history)", async () => {
    generateText.mockResolvedValue({
      text: "handled [PII_EMAIL_1]",
      totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const result = await runAgent(CFG, PII_INPUT, META);
    const serialized = JSON.stringify(result);
    for (const raw of RAW) expect(serialized).not.toContain(raw);
    // The map is placeholder → raw PII; it must not be reachable from the result at all.
    expect(serialized).not.toContain('PII_EMAIL_1":"');
    expect(result.guardrails).toEqual({ redacted: 5 }); // a COUNT is the only detail exported
    expect((result as unknown as Record<string, unknown>).map).toBeUndefined();
  });

  it("no raw PII in the usage-ledger write (the ledger is tokens + cost only)", async () => {
    await runAgent(CFG, PII_INPUT, META);
    expect(recordUsage).toHaveBeenCalledOnce();
    const ledger = JSON.stringify(recordUsage.mock.calls[0][0]);
    for (const raw of RAW) expect(ledger).not.toContain(raw);
  });

  it("no raw PII in ANY structured log line the activity emitted", async () => {
    await runAgent({ ...CFG, debug: true } as never, PII_INPUT, {
      ...META,
      debug: true,
    });
    expect(logRecords.length).toBeGreaterThan(0); // the assertion below must not be vacuous
    const logs = JSON.stringify(logRecords);
    for (const raw of RAW) expect(logs).not.toContain(raw);
  });

  it("redaction is a no-op when the policy does not enable it (opt-in)", async () => {
    policy = {};
    await runAgent(CFG, PII_INPUT, META);
    expect(sentToModel()).toContain("ada@example.com");
  });

  it("honours a `kinds` subset", async () => {
    policy = { redact: { enabled: true, kinds: ["email"] } };
    await runAgent(CFG, PII_INPUT, META);
    const sent = sentToModel();
    expect(sent).not.toContain("ada@example.com");
    expect(sent).toContain("10.0.0.7");
  });

  it("also redacts the SYSTEM prompt, including on the prompt-CACHING path", async () => {
    const r = await runAgent(
      {
        ...CFG,
        cacheSystemPrompt: true,
        systemPrompt: "escalate to ada@example.com",
      },
      { x: 1 },
      META,
    );
    const sent = sentToModel();
    expect(sent).not.toContain("ada@example.com");
    expect(sent).toContain("[PII_EMAIL_1]");
    // Caching still engaged (the messages form was used, not system/prompt).
    const args = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(Array.isArray(args.messages)).toBe(true);
    expect(r.status).toBe("ok");
  });
});
