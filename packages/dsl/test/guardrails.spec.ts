// Agent guardrails (#576) — the PURE policy layer.
import { describe, expect, it } from "vitest";
import {
  applyContentRules,
  applyContentRulesToValue,
  BLOCKED_PLACEHOLDER,
  containsPii,
  distinctToolRefs,
  evaluateToolPolicy,
  graphHasToolNodes,
  graphToolRefs,
  isEmptyGuardrailPolicy,
  matchToolPattern,
  MAX_CONTENT_SCAN_CHARS,
  PII_KINDS,
  redactPii,
  validateGraphToolPolicy,
  violationLabels,
  type AgentGuardrailPolicy,
  type GraphDef,
} from "../src";

const graph = (
  nodes: { id: string; type: string; config?: Record<string, unknown> }[],
) =>
  ({
    startNodeId: nodes[0]?.id ?? "n",
    nodes,
    edges: [],
  }) as unknown as GraphDef;

describe("matchToolPattern — anchored glob, never a regex", () => {
  it("a colon-less pattern matches the TOOL segment on any connection", () => {
    expect(matchToolPattern("delete_file", "conn-1:delete_file")).toBe(true);
    expect(matchToolPattern("delete_*", "conn-1:delete_file")).toBe(true);
    expect(matchToolPattern("delete_*", "conn-2:delete_repo")).toBe(true);
    expect(matchToolPattern("delete_*", "conn-1:read_file")).toBe(false);
  });

  it("a pattern WITH a colon is scoped to the full ref", () => {
    expect(matchToolPattern("conn-1:delete_*", "conn-1:delete_file")).toBe(
      true,
    );
    expect(matchToolPattern("conn-1:delete_*", "conn-2:delete_file")).toBe(
      false,
    );
    expect(matchToolPattern("github:create_issue", "github:create_issue")).toBe(
      true,
    );
  });

  it("is ANCHORED (no accidental substring match)", () => {
    expect(matchToolPattern("read", "conn:read_file")).toBe(false);
    expect(matchToolPattern("*read*", "conn:read_file")).toBe(true);
  });

  it("treats regex metacharacters as LITERALS — an operator glob can never inject a regex", () => {
    // `.` must not match any char; `(a+)+` must be a literal name, not a backtracking bomb.
    expect(matchToolPattern("a.c", "conn:abc")).toBe(false);
    expect(matchToolPattern("a.c", "conn:a.c")).toBe(true);
    const start = Date.now();
    expect(matchToolPattern("(a+)+$", `conn:${"a".repeat(2000)}`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("evaluateToolPolicy — deny is final, allow is a fail-closed allowlist", () => {
  it("no policy ⇒ allow", () => {
    expect(evaluateToolPolicy("c:t", undefined)).toBe("allow");
    expect(evaluateToolPolicy("c:t", {})).toBe("allow");
  });

  it("deny wins over allow AND over requireApproval (a denied tool is never approvable)", () => {
    const p: AgentGuardrailPolicy = {
      tools: {
        allow: ["danger"],
        deny: ["danger"],
        requireApproval: ["danger"],
      },
    };
    expect(evaluateToolPolicy("c:danger", p)).toBe("deny");
  });

  it("a non-empty allow list denies everything it does not name", () => {
    const p: AgentGuardrailPolicy = { tools: { allow: ["read_*"] } };
    expect(evaluateToolPolicy("c:read_file", p)).toBe("allow");
    expect(evaluateToolPolicy("c:write_file", p)).toBe("deny");
  });

  it("an EMPTY allow list is not an allowlist (allows everything, subject to deny)", () => {
    const p: AgentGuardrailPolicy = { tools: { allow: [], deny: ["x"] } };
    expect(evaluateToolPolicy("c:anything", p)).toBe("allow");
    expect(evaluateToolPolicy("c:x", p)).toBe("deny");
  });

  it("requireApproval ⇒ approval", () => {
    const p: AgentGuardrailPolicy = {
      tools: { requireApproval: ["github:create_issue"] },
    };
    expect(evaluateToolPolicy("github:create_issue", p)).toBe("approval");
    expect(evaluateToolPolicy("github:list_issues", p)).toBe("allow");
  });
});

describe("graphToolRefs / distinctToolRefs", () => {
  const g = graph([
    {
      id: "a",
      type: "agent",
      config: {
        tools: [
          { connectionId: "c1", tool: "read_file" },
          { connectionId: "c1", tool: "delete_file", name: "nuke" },
          { connectionId: "c1" }, // malformed → skipped
        ],
      },
    },
    {
      id: "m",
      type: "mcpTool",
      config: { connectionId: "c1", tool: "read_file" },
    },
    {
      id: "i",
      type: "integration",
      config: {
        provider: "github",
        action: "create_issue",
        connectionId: "gh",
      },
    },
    { id: "s", type: "set", config: {} },
  ]);

  it("collects agent in-loop tools, mcpTool nodes and integration actions", () => {
    expect(graphToolRefs(g)).toEqual([
      {
        nodeId: "a",
        nodeType: "agent",
        ref: "c1:read_file",
        exposedName: "read_file",
      },
      {
        nodeId: "a",
        nodeType: "agent",
        ref: "c1:delete_file",
        exposedName: "nuke",
      },
      { nodeId: "m", nodeType: "mcpTool", ref: "c1:read_file" },
      { nodeId: "i", nodeType: "integration", ref: "github:create_issue" },
    ]);
  });

  it("distinctToolRefs de-dupes in FIRST-SEEN order (the interpreter's activity arg must replay)", () => {
    expect(distinctToolRefs(graphToolRefs(g))).toEqual([
      "c1:read_file",
      "c1:delete_file",
      "github:create_issue",
    ]);
  });

  it("graphHasToolNodes lets a tool-free graph skip the policy lookup entirely", () => {
    expect(graphHasToolNodes(g)).toBe(true);
    expect(
      graphHasToolNodes(graph([{ id: "s", type: "set", config: {} }])),
    ).toBe(false);
  });
});

describe("validateGraphToolPolicy — the save gate (#576 AC1, save half)", () => {
  const denyPolicy: AgentGuardrailPolicy = { tools: { deny: ["delete_*"] } };

  it("rejects a DENIED tool on an agent node, naming the node and the ref", () => {
    const errs = validateGraphToolPolicy(
      graph([
        {
          id: "a",
          type: "agent",
          config: { tools: [{ connectionId: "c1", tool: "delete_file" }] },
        },
      ]),
      denyPolicy,
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({
      nodeId: "a",
      nodeType: "agent",
      ref: "c1:delete_file",
      reason: "denied",
    });
    expect(errs[0].message).toContain("blocked by this workspace");
  });

  it("rejects a DENIED tool on a standalone mcpTool node too", () => {
    const errs = validateGraphToolPolicy(
      graph([
        {
          id: "m",
          type: "mcpTool",
          config: { connectionId: "c1", tool: "delete_file" },
        },
      ]),
      denyPolicy,
    );
    expect(errs.map((e) => e.reason)).toEqual(["denied"]);
  });

  it("rejects a FORCED-APPROVAL tool inside an agent's in-loop tools[] and says what to do instead", () => {
    const errs = validateGraphToolPolicy(
      graph([
        {
          id: "a",
          type: "agent",
          config: { tools: [{ connectionId: "c1", tool: "wire_money" }] },
        },
      ]),
      { tools: { requireApproval: ["wire_money"] } },
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].reason).toBe("approval-in-agent-loop");
    expect(errs[0].message).toContain("standalone Tool/Integration node");
  });

  it("ALLOWS a forced-approval tool as a standalone node (that is where the pause is possible)", () => {
    expect(
      validateGraphToolPolicy(
        graph([
          {
            id: "m",
            type: "mcpTool",
            config: { connectionId: "c1", tool: "wire_money" },
          },
          {
            id: "i",
            type: "integration",
            config: { provider: "github", action: "create_issue" },
          },
        ]),
        {
          tools: {
            requireApproval: ["wire_money", "github:create_issue"],
          },
        },
      ),
    ).toEqual([]);
  });

  it("passes everything when no tool policy is configured", () => {
    expect(
      validateGraphToolPolicy(
        graph([
          {
            id: "a",
            type: "agent",
            config: { tools: [{ connectionId: "c", tool: "delete_all" }] },
          },
        ]),
        {},
      ),
    ).toEqual([]);
  });
});

describe("applyContentRules", () => {
  it("keyword rules are case-insensitive by default and default to `fail`", () => {
    const r = applyContentRules("Our codename is Project BLUEBIRD.", [
      { label: "codename", kind: "keyword", pattern: "project bluebird" },
    ]);
    expect(r.blocked).toBe(true);
    expect(r.violations).toEqual([
      { label: "codename", action: "fail", matches: 1 },
    ]);
    expect(r.text).toBe("Our codename is Project BLUEBIRD."); // fail does not rewrite
  });

  it("`strip` rewrites the match and does not block", () => {
    const r = applyContentRules("call me at secret-line", [
      {
        label: "line",
        kind: "keyword",
        pattern: "secret-line",
        action: "strip",
      },
    ]);
    expect(r.blocked).toBe(false);
    expect(r.text).toBe(`call me at ${BLOCKED_PLACEHOLDER}`);
  });

  it("a keyword pattern's regex metacharacters are literals", () => {
    expect(
      applyContentRules("a.c", [
        { label: "l", kind: "keyword", pattern: "a.c" },
      ]).blocked,
    ).toBe(true);
    expect(
      applyContentRules("abc", [
        { label: "l", kind: "keyword", pattern: "a.c" },
      ]).blocked,
    ).toBe(false);
  });

  it("regex rules are case-SENSITIVE by default and can opt in", () => {
    const rule = { label: "l", kind: "regex" as const, pattern: "SECRET" };
    expect(applyContentRules("secret", [rule]).blocked).toBe(false);
    expect(
      applyContentRules("secret", [{ ...rule, ignoreCase: true }]).blocked,
    ).toBe(true);
  });

  it("an UNSAFE regex (nested quantifier) never matches — it does not open the gate, and it is fast", () => {
    const start = Date.now();
    const r = applyContentRules(`${"a".repeat(40)}!`, [
      { label: "redos", kind: "regex", pattern: "(a+)+$" },
    ]);
    expect(r.blocked).toBe(false);
    expect(r.violations).toEqual([]);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("an INVALID regex never matches (and never throws)", () => {
    expect(
      applyContentRules("x", [{ label: "l", kind: "regex", pattern: "([" }])
        .violations,
    ).toEqual([]);
  });

  it("a regex rule is scanned over at most MAX_CONTENT_SCAN_CHARS, and `strip` never rewrites the untouched tail", () => {
    const text = `${"x".repeat(MAX_CONTENT_SCAN_CHARS - 3)}BADyBAD`;
    const r = applyContentRules(text, [
      { label: "bad", kind: "regex", pattern: "BAD", action: "strip" },
    ]);
    // The first BAD is inside the scan window and was stripped; the tail is preserved verbatim.
    expect(r.violations[0]).toMatchObject({ label: "bad", matches: 1 });
    expect(r.text).toContain(BLOCKED_PLACEHOLDER);
    expect(r.text.endsWith("yBAD")).toBe(true);
    expect(r.text.length).toBe(
      text.length - "BAD".length + BLOCKED_PLACEHOLDER.length,
    );
  });

  it("no rules ⇒ the input is returned unchanged", () => {
    expect(applyContentRules("hello", undefined)).toEqual({
      text: "hello",
      violations: [],
      blocked: false,
    });
  });
});

describe("applyContentRulesToValue — leaf-wise, so a strip can never corrupt JSON", () => {
  it("rewrites string leaves in place and keeps the structure", () => {
    const r = applyContentRulesToValue(
      { a: "hit", b: [{ c: "hit" }], n: 5, z: null },
      [{ label: "l", kind: "keyword", pattern: "hit", action: "strip" }],
    );
    expect(r.value).toEqual({
      a: BLOCKED_PLACEHOLDER,
      b: [{ c: BLOCKED_PLACEHOLDER }],
      n: 5,
      z: null,
    });
    expect(r.blocked).toBe(false);
    expect(r.violations).toHaveLength(2);
  });

  it("a `fail` rule on any leaf blocks", () => {
    expect(
      applyContentRulesToValue({ deep: { x: "boom" } }, [
        { label: "l", kind: "keyword", pattern: "boom" },
      ]).blocked,
    ).toBe(true);
  });

  it("survives a cycle", () => {
    const cyclic: Record<string, unknown> = { s: "ok" };
    cyclic.self = cyclic;
    expect(() =>
      applyContentRulesToValue(cyclic, [
        { label: "l", kind: "keyword", pattern: "zzz" },
      ]),
    ).not.toThrow();
  });
});

describe("violationLabels — the only violation detail safe to export", () => {
  it("prefixes with the side and de-dupes", () => {
    expect(
      violationLabels("output", [
        { label: "a", action: "fail", matches: 1 },
        { label: "a", action: "fail", matches: 2 },
        { label: "b", action: "strip", matches: 1 },
      ]),
    ).toEqual(["output:a", "output:b"]);
  });
});

describe("redactPii", () => {
  it("redacts each supported kind with a labelled placeholder", () => {
    const r = redactPii(
      "mail ada@example.com, card 4111 1111 1111 1111, ssn 123-45-6789, ip 10.0.0.7, tel +1 (415) 555-0132",
    );
    expect(r.text).not.toContain("ada@example.com");
    expect(r.text).not.toContain("4111 1111 1111 1111");
    expect(r.text).not.toContain("123-45-6789");
    expect(r.text).not.toContain("10.0.0.7");
    expect(r.text).not.toContain("555-0132");
    expect(r.text).toContain("[PII_EMAIL_1]");
    expect(r.text).toContain("[PII_CREDITCARD_1]");
    expect(r.text).toContain("[PII_SSN_1]");
    expect(r.text).toContain("[PII_IPV4_1]");
    expect(r.text).toContain("[PII_PHONE_1]");
    expect(r.count).toBe(5);
  });

  it("gives one value ONE stable placeholder across occurrences (coherence for the model)", () => {
    const r = redactPii("ada@example.com wrote; reply to ada@example.com");
    expect(r.text).toBe("[PII_EMAIL_1] wrote; reply to [PII_EMAIL_1]");
    expect(r.count).toBe(1);
    expect(r.map["[PII_EMAIL_1]"]).toBe("ada@example.com");
  });

  it("numbers distinct values per kind, and is deterministic", () => {
    const text = "a@x.com and b@y.com";
    const first = redactPii(text);
    expect(first.text).toBe("[PII_EMAIL_1] and [PII_EMAIL_2]");
    expect(redactPii(text).text).toBe(first.text);
  });

  it("uses Luhn so an ordinary long digit run is NOT called a card", () => {
    // 16 digits, Luhn-INVALID (and too long for the phone matcher's 8–15 digit range).
    expect(redactPii("order 1234567812345678").count).toBe(0);
    expect(redactPii("card 4111111111111111").count).toBe(1);
  });

  it("validates IPv4 octets", () => {
    expect(redactPii("999.1.1.1", ["ipv4"]).count).toBe(0);
    expect(redactPii("192.168.1.20", ["ipv4"]).count).toBe(1);
  });

  it("a later kind can never re-redact an earlier kind's placeholder", () => {
    // The card placeholder contains digits+underscores; the phone matcher must not eat it.
    const r = redactPii("card 4111111111111111");
    expect(r.count).toBe(1);
    expect(r.text).toBe("card [PII_CREDITCARD_1]");
    // And a second pass over the already-redacted text finds nothing.
    expect(containsPii(r.text)).toBe(false);
  });

  it("respects a `kinds` subset", () => {
    const r = redactPii("ada@example.com 10.0.0.7", ["email"]);
    expect(r.text).toBe("[PII_EMAIL_1] 10.0.0.7");
  });

  it("leaves clean text byte-identical", () => {
    const clean = "Summarize the quarterly report in three bullets.";
    expect(redactPii(clean)).toEqual({ text: clean, map: {}, count: 0 });
    expect(containsPii(clean)).toBe(false);
  });

  it("PII_KINDS order puts card/ssn before phone (the mislabelling guard)", () => {
    expect(PII_KINDS.indexOf("creditCard")).toBeLessThan(
      PII_KINDS.indexOf("phone"),
    );
    expect(PII_KINDS.indexOf("ssn")).toBeLessThan(PII_KINDS.indexOf("phone"));
  });
});

describe("isEmptyGuardrailPolicy — the skip-everything fast path", () => {
  it.each<[string, AgentGuardrailPolicy | undefined]>([
    ["undefined", undefined],
    ["{}", {}],
    [
      "empty tool lists",
      { tools: { allow: [], deny: [], requireApproval: [] } },
    ],
    ["redact off", { redact: { enabled: false, kinds: ["email"] } }],
    ["empty rule arrays", { input: [], output: [] }],
  ])("is empty for %s", (_name, p) => {
    expect(isEmptyGuardrailPolicy(p)).toBe(true);
  });

  it.each<[string, AgentGuardrailPolicy]>([
    ["a deny entry", { tools: { deny: ["x"] } }],
    ["an approval entry", { tools: { requireApproval: ["x"] } }],
    [
      "an input rule",
      { input: [{ label: "l", kind: "keyword", pattern: "x" }] },
    ],
    ["redact on", { redact: { enabled: true } }],
  ])("is NOT empty for %s", (_name, p) => {
    expect(isEmptyGuardrailPolicy(p)).toBe(false);
  });
});
