import { describe, expect, it } from "vitest";
import type { GraphDef } from "../src/types";
import {
  collectUnresolved,
  lintBindings,
  lintTemplates,
  resolveTemplateString,
  resolveTemplates,
} from "../src/template";

const ctx = {
  start: { subject: "Invoice #42", amount: 100 },
  agent: { output: { category: "billing", id: "abc", tags: ["a", "b"] } },
};

describe("resolveTemplateString", () => {
  it("returns the string unchanged when there are no tokens", () => {
    expect(resolveTemplateString("plain text", ctx)).toBe("plain text");
  });

  it("whole-string token returns the TYPED value (not stringified)", () => {
    expect(resolveTemplateString("{{ start.amount }}", ctx)).toBe(100);
    expect(resolveTemplateString("{{ agent.output }}", ctx)).toEqual({
      category: "billing",
      id: "abc",
      tags: ["a", "b"],
    });
  });

  it("embedded token coerces to string; objects → JSON", () => {
    expect(resolveTemplateString("Re: {{ start.subject }}", ctx)).toBe(
      "Re: Invoice #42",
    );
    expect(resolveTemplateString("cat={{ agent.output.category }}!", ctx)).toBe(
      "cat=billing!",
    );
    expect(resolveTemplateString("x {{ agent.output }} y", ctx)).toBe(
      'x {"category":"billing","id":"abc","tags":["a","b"]} y',
    );
  });

  it("multiple embedded tokens", () => {
    expect(
      resolveTemplateString("{{ start.subject }} — {{ agent.output.id }}", ctx),
    ).toBe("Invoice #42 — abc");
  });

  it("missing path → undefined (whole) / empty (embedded), never throws", () => {
    expect(resolveTemplateString("{{ nope.x }}", ctx)).toBeUndefined();
    expect(resolveTemplateString("a{{ nope.x }}b", ctx)).toBe("ab");
    // whole-string missing → undefined; embedded missing → ""
    expect(
      resolveTemplateString("{{ agent.output.missing }}", ctx),
    ).toBeUndefined();
    expect(resolveTemplateString("v={{ agent.output.missing }}", ctx)).toBe(
      "v=",
    );
  });

  it("tolerates whitespace inside the braces", () => {
    expect(resolveTemplateString("{{   start.amount   }}", ctx)).toBe(100);
  });

  it("escapes a literal {{ with a backslash", () => {
    expect(resolveTemplateString("\\{{ not a token }}", ctx)).toBe(
      "{{ not a token }}",
    );
    expect(resolveTemplateString("\\{{ x }} and {{ start.amount }}", ctx)).toBe(
      "{{ x }} and 100",
    );
  });

  it("nested array path", () => {
    // getByPath walks dotted keys; array index as a key works for objects only —
    // whole-array reference returns the typed array.
    expect(resolveTemplateString("{{ agent.output.tags }}", ctx)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("resolveTemplates (deep config walk)", () => {
  it("resolves tokens in nested strings, arrays, and objects; leaves the rest", () => {
    const config = {
      url: "https://api/x/{{ agent.output.id }}",
      method: "POST",
      count: 3,
      headers: { "X-Cat": "{{ agent.output.category }}" },
      list: ["{{ start.subject }}", "literal"],
      body: "{{ agent.output }}", // whole-string → typed object
    };
    expect(resolveTemplates(config, ctx)).toEqual({
      url: "https://api/x/abc",
      method: "POST",
      count: 3,
      headers: { "X-Cat": "billing" },
      list: ["Invoice #42", "literal"],
      body: { category: "billing", id: "abc", tags: ["a", "b"] },
    });
  });

  it("is a no-op (structurally) for a config with no tokens", () => {
    const config = { a: "x", b: 1, c: { d: ["e"] } };
    expect(resolveTemplates(config, ctx)).toEqual(config);
  });
});

describe("lintTemplates", () => {
  const g = (nodes: GraphDef["nodes"]): GraphDef => ({
    startNodeId: "start",
    nodes,
    edges: [],
  });

  it("flags a token referencing an unknown node id", () => {
    const graph = g([
      { id: "start", type: "start" },
      { id: "agent", type: "agent" },
      {
        id: "http",
        type: "httpRequest",
        config: {
          url: "https://x/{{ aget.output.id }}", // typo: "aget"
          headers: { A: "{{ agent.output.category }}" }, // valid
        },
      },
    ]);
    const w = lintTemplates(graph);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      nodeId: "http",
      field: "url",
      ref: "aget.output.id",
    });
    expect(w[0].message).toContain("aget");
  });

  it("no warnings when all referenced nodes exist (or no tokens)", () => {
    const graph = g([
      { id: "start", type: "start" },
      { id: "agent", type: "agent" },
      {
        id: "http",
        type: "httpRequest",
        config: { url: "https://x/{{ agent.output.id }}", method: "GET" },
      },
    ]);
    expect(lintTemplates(graph)).toEqual([]);
  });

  it("ignores escaped \\{{ literals", () => {
    const graph = g([
      { id: "n", type: "set", config: { fields: { t: "\\{{ nope }}" } } },
    ]);
    expect(lintTemplates(graph)).toEqual([]);
  });
});

describe("lintBindings", () => {
  const g = (nodes: GraphDef["nodes"]): GraphDef => ({
    startNodeId: "trigger",
    nodes,
    edges: [],
  });

  it("names the missing source of an integration fieldBinding whose `from` isn't a node", () => {
    const graph = g([
      { id: "trigger", type: "webhookTrigger" },
      { id: "review", type: "agent" },
      {
        id: "comment",
        type: "integration",
        config: {
          provider: "github",
          action: "comment_issue",
          fieldBindings: {
            owner: { from: "trigger", path: "repository.owner.login" }, // valid
            body: { from: "reviewer", path: "output.review" }, // typo: no "reviewer" node
          },
        },
      },
    ]);
    const w = lintBindings(graph);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      nodeId: "comment",
      field: "fieldBindings.body",
      ref: "reviewer.output.review",
    });
    expect(w[0].message).toContain('"reviewer"');
  });

  it("no warnings when every binding source is a real node", () => {
    const graph = g([
      { id: "trigger", type: "webhookTrigger" },
      {
        id: "lookup",
        type: "sqlQuery",
        config: {
          connectionId: "db",
          sql: "SELECT 1 WHERE id = $1",
          paramBindings: { 1: { from: "trigger", path: "userId" } },
        },
      },
    ]);
    expect(lintBindings(graph)).toEqual([]);
  });

  it("does NOT flag a plain string field named `from` (e.g. an email sender)", () => {
    const graph = g([
      { id: "trigger", type: "webhookTrigger" },
      {
        id: "mail",
        type: "sendEmail",
        // `from` here is a literal address string, NOT a {from,path} binding.
        config: { from: "noreply@acme.com", to: "u@acme.com", subject: "hi" },
      },
    ]);
    expect(lintBindings(graph)).toEqual([]);
  });
});

describe("collectUnresolved (runtime: which source produced no output)", () => {
  const ids = new Set(["trigger", "diff", "review", "comment"]);

  it("flags a binding whose source ran but produced no output (sourceExists=true)", () => {
    const node = {
      id: "comment",
      config: {
        fieldBindings: {
          owner: { from: "trigger", path: "repo.owner" }, // resolves
          body: { from: "review", path: "output.review" }, // review has no output.review
        },
      },
    };
    // `review` exists in ctx but its output is empty — the source ran, yielded nothing.
    const ctx = {
      trigger: { repo: { owner: "octocat" } },
      review: { output: {} },
    };
    const out = collectUnresolved(node, ctx, ids);
    expect(out).toEqual([
      {
        nodeId: "comment",
        field: "fieldBindings.body",
        from: "review",
        ref: "review.output.review",
        sourceExists: true,
      },
    ]);
  });

  it("flags a `{{ }}` token whose source isn't a node (sourceExists=false)", () => {
    const node = {
      id: "review",
      config: { systemPrompt: "Review this:\n{{ dif.body }}" }, // typo: "dif"
    };
    const out = collectUnresolved(node, { diff: { body: "x" } }, ids);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      nodeId: "review",
      field: "systemPrompt",
      from: "dif",
      sourceExists: false,
    });
  });

  it("reports nothing when every reference resolves (even to empty string / null)", () => {
    const node = {
      id: "comment",
      config: {
        title: "{{ diff.body }}",
        fieldBindings: { body: { from: "review", path: "output.review" } },
      },
    };
    // Present-but-empty values are NOT missing — only strictly-undefined sources are flagged.
    const ctx = { diff: { body: "" }, review: { output: { review: null } } };
    expect(collectUnresolved(node, ctx, ids)).toEqual([]);
  });
});
