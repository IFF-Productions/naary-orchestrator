// Agent guardrails (#576) — the zod WRITE GATE for TenantSettings.agentGuardrails.
import { describe, expect, it } from "vitest";
import {
  agentGuardrailPolicySchema,
  InvalidGuardrailPolicyError,
  parseAgentGuardrailPolicy,
} from "../src/registry";

describe("agentGuardrailPolicySchema", () => {
  it("accepts a full, realistic policy", () => {
    const policy = {
      tools: {
        allow: ["read_*"],
        deny: ["delete_*", "conn-1:drop_table"],
        requireApproval: ["github:create_issue"],
      },
      input: [
        { label: "codename", kind: "keyword", pattern: "Project Bluebird" },
        {
          label: "acct",
          kind: "regex",
          pattern: "ACCT-\\d{6}",
          action: "strip",
          ignoreCase: true,
        },
      ],
      output: [
        { label: "internal", kind: "keyword", pattern: "internal-only" },
      ],
      redact: { enabled: true, kinds: ["email", "phone"] },
    };
    expect(agentGuardrailPolicySchema.parse(policy)).toEqual(policy);
  });

  it("accepts {} (no guardrails)", () => {
    expect(agentGuardrailPolicySchema.parse({})).toEqual({});
  });

  it("is STRICT — a typo'd key is rejected rather than silently unenforced", () => {
    expect(
      agentGuardrailPolicySchema.safeParse({ tools: { denny: ["x"] } }).success,
    ).toBe(false);
    expect(
      agentGuardrailPolicySchema.safeParse({ redaction: { enabled: true } })
        .success,
    ).toBe(false);
  });

  it("rejects a catastrophic-backtracking regex rule AT SAVE TIME", () => {
    const res = agentGuardrailPolicySchema.safeParse({
      input: [{ label: "bomb", kind: "regex", pattern: "(a+)+$" }],
    });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain("nested quantifier");
  });

  it("rejects an invalid regex rule", () => {
    const res = agentGuardrailPolicySchema.safeParse({
      output: [{ label: "bad", kind: "regex", pattern: "([" }],
    });
    expect(res.success).toBe(false);
  });

  it("allows an unsafe-LOOKING pattern when the rule is a KEYWORD (it is a literal there)", () => {
    expect(
      agentGuardrailPolicySchema.safeParse({
        input: [{ label: "lit", kind: "keyword", pattern: "(a+)+$" }],
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown PII kind and an unknown rule action", () => {
    expect(
      agentGuardrailPolicySchema.safeParse({
        redact: { enabled: true, kinds: ["passport"] },
      }).success,
    ).toBe(false);
    expect(
      agentGuardrailPolicySchema.safeParse({
        input: [
          { label: "l", kind: "keyword", pattern: "x", action: "explode" },
        ],
      }).success,
    ).toBe(false);
  });

  it("bounds the pattern length", () => {
    expect(
      agentGuardrailPolicySchema.safeParse({
        input: [{ label: "l", kind: "keyword", pattern: "x".repeat(251) }],
      }).success,
    ).toBe(false);
  });
});

describe("parseAgentGuardrailPolicy — fails CLOSED and loudly", () => {
  it("null/undefined ⇒ the empty policy", () => {
    expect(parseAgentGuardrailPolicy(null)).toEqual({});
    expect(parseAgentGuardrailPolicy(undefined)).toEqual({});
  });

  it("THROWS on a malformed stored row rather than degrading to 'no guardrails'", () => {
    expect(() => parseAgentGuardrailPolicy({ tools: "nope" })).toThrow(
      InvalidGuardrailPolicyError,
    );
    try {
      parseAgentGuardrailPolicy({ tools: "nope" });
    } catch (e) {
      expect((e as InvalidGuardrailPolicyError).issues[0].path).toBe("tools");
    }
  });

  it("round-trips a valid policy", () => {
    const p = { tools: { deny: ["x"] } };
    expect(parseAgentGuardrailPolicy(p)).toEqual(p);
  });
});
