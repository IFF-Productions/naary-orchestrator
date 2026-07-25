/**
 * n8n importer corpus test (#579).
 *
 * The load-bearing assertion is the first block: **every fixture must produce a graph that passes
 * BOTH save gates.** An importer that yields unsaveable graphs is a bug, not a partial success —
 * `validateGraph` (structural: ids, connectivity, merge fan-in, splitOut brackets, integration
 * provider/action) is the strict one, and it is what an n8n `IF → … → Merge` or a free-text node
 * name would otherwise trip.
 *
 * The second commitment tested here is that **nothing is silently dropped**: every node in the
 * export gets exactly one report entry, and anything not faithfully imported carries a note.
 *
 * The fixtures in `test/fixtures/n8n/` are real-shaped exports (`nodes` + name-keyed `connections` +
 * `settings`/`meta`/`versionId`), deliberately covering: the AC's webhook → transform → IF → HTTP →
 * respond path, a schedule/code/email chain, an AI agent with `ai_languageModel`/`ai_memory`/`ai_tool`
 * sub-nodes, a switch fanning into a merge (plus a sticky note and a disabled node), n8n loop
 * constructs we do NOT support, and legacy v1 node shapes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_TYPES } from "../src/node-catalog";
import { validateGraph } from "../src/branch";
import { validateGraphConfigs } from "../src/registry";
import { convertN8nExpression } from "../src/n8n-expressions";
import {
  N8N_APP_TO_PROVIDER,
  N8N_NODE_MAP,
  N8N_SUB_NODE_TYPES,
} from "../src/n8n-map";
import { getIntegrationProvider } from "../src/integrations";
import { N8nImportError, parseN8nWorkflow } from "../src/n8n-import";

const FIXTURES = join(__dirname, "fixtures", "n8n");
const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .sort();
const load = (f: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, f), "utf8"));

describe("n8n corpus — every import is SAVEABLE", () => {
  it("has at least 5 representative fixtures checked in", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)("%s passes validateGraph + validateGraphConfigs", (file) => {
    const out = parseN8nWorkflow(load(file));

    const structural = validateGraph(out.graph);
    expect(structural.error ?? null).toBeNull();
    expect(structural.valid).toBe(true);

    const configErrors = validateGraphConfigs(out.graph);
    expect(configErrors).toEqual([]);
  });

  it.each(files)(
    "%s produces only known node types + resolvable edges",
    (file) => {
      const { graph } = parseN8nWorkflow(load(file));
      const ids = new Set(graph.nodes.map((n) => n.id));
      for (const n of graph.nodes) {
        expect(NODE_TYPES).toContain(n.type);
        // Ids are addressed by `{{ id.path }}`; a '.', '[' or ']' would silently break every
        // reference to the node (the path grammar has no quoting).
        expect(n.id).not.toMatch(/[.[\]]/);
        expect(n.id.startsWith("__")).toBe(false);
      }
      for (const e of graph.edges) {
        expect(ids.has(e.from)).toBe(true);
        expect(ids.has(e.to)).toBe(true);
      }
      expect(ids.has(graph.startNodeId)).toBe(true);
    },
  );

  it.each(files)(
    "%s reports EVERY node in the export — nothing dropped",
    (file) => {
      const raw = load(file) as { nodes: Array<{ name: string }> };
      const out = parseN8nWorkflow(raw);

      expect(out.nodes).toHaveLength(raw.nodes.length);
      expect(out.nodes.map((r) => r.n8nName).sort()).toEqual(
        raw.nodes.map((n) => n.name).sort(),
      );
      // Every report entry either points at a node in the graph, or is explicitly `skipped`.
      const ids = new Set(out.graph.nodes.map((n) => n.id));
      for (const r of out.nodes) {
        if (r.nodeId === null) {
          expect(r.status).toBe("skipped");
        } else {
          expect(ids.has(r.nodeId)).toBe(true);
        }
        // Anything that isn't a faithful import must say why.
        if (r.status !== "imported") {
          expect(r.notes.length).toBeGreaterThan(0);
        }
      }
      // The counts are a summary of the same list, not a second source of truth.
      const total = Object.values(out.counts).reduce((a, b) => a + b, 0);
      expect(total).toBe(raw.nodes.length);
    },
  );

  it.each(files)("%s only uses node types that really exist in n8n", (file) => {
    // The AC asks for a corpus of REAL sample workflows, so a fixture must not lean on an invented
    // type to exercise the unmapped path — the value of "unmapped" coverage is that it reflects what
    // an actual export contains. Every type here is either in our mapping table, in the sub-node
    // set, a provider we map, or one of the genuinely-unsupported real n8n types listed below.
    const REAL_BUT_UNSUPPORTED = new Set([
      "n8n-nodes-base.awsS3",
      "n8n-nodes-base.telegram",
    ]);
    const raw = load(file) as { nodes: Array<{ name: string; type: string }> };
    for (const n of raw.nodes) {
      const known =
        Object.hasOwn(N8N_NODE_MAP, n.type) ||
        N8N_SUB_NODE_TYPES.has(n.type) ||
        Object.hasOwn(N8N_APP_TO_PROVIDER, n.type) ||
        REAL_BUT_UNSUPPORTED.has(n.type);
      expect(known, `${file}: ${n.name} has type ${n.type}`).toBe(true);
    }
  });

  it.each(files)("%s never imports a credential", (file) => {
    const out = parseN8nWorkflow(load(file));
    const json = JSON.stringify(out.graph);
    // No credential id, account name, or the `credentials` key itself may reach the graph.
    expect(json).not.toContain('"credentials"');
    for (const cred of out.credentials) {
      expect(json).not.toContain(cred.n8nType);
    }
    // Specific account labels present in the fixtures.
    for (const label of [
      "Orders webhook header auth",
      "Metrics API key",
      "Company SMTP",
      "OpenAi account",
      "Slack account",
      "Airtable token",
      "Telegram bot",
    ]) {
      expect(json).not.toContain(label);
    }
  });
});

describe("01 — webhook → transform → IF → HTTP → respond (the AC's path)", () => {
  const out = parseN8nWorkflow(load("01-webhook-set-if-http-respond.json"));
  const byName = (n: string) => out.nodes.find((r) => r.n8nName === n)!;
  const node = (id: string) => out.graph.nodes.find((n) => n.id === id)!;

  it("maps the whole chain to real node types with the webhook as the entry", () => {
    expect(out.name).toBe("Order webhook triage");
    expect(out.graph.startNodeId).toBe(byName("Webhook").nodeId);
    expect(node(byName("Webhook").nodeId!).type).toBe("webhookTrigger");
    expect(node(byName("Normalise order").nodeId!).type).toBe("set");
    expect(node(byName("High value?").nodeId!).type).toBe("if");
    expect(node(byName("Escalate to CRM").nodeId!).type).toBe("httpRequest");
    expect(node(byName("Respond queued").nodeId!).type).toBe(
      "respondToWebhook",
    );
    expect(out.counts.unmapped).toBe(0);
  });

  it("translates $json into the upstream node's id", () => {
    const set = node(byName("Normalise order").nodeId!);
    const webhookId = byName("Webhook").nodeId;
    expect(set.config?.fields).toEqual({
      orderId: `{{ ${webhookId}.body.id }}`,
      total: `{{ ${webhookId}.body.amount }}`,
      region: "eu-west",
    });
  });

  it("turns the IF's two n8n outputs into true/false EDGE conditions", () => {
    const ifId = byName("High value?").nodeId!;
    const fromIf = out.graph.edges.filter((e) => e.from === ifId);
    expect(fromIf).toHaveLength(2);
    expect(fromIf.map((e) => e.condition)).toEqual([
      { path: `${ifId}.result`, op: "eq", value: true },
      { path: `${ifId}.result`, op: "eq", value: false },
    ]);
    // The condition itself: `$json.total >= 500` against the upstream Set node.
    expect(node(ifId).config?.conditions).toEqual([
      {
        path: `${byName("Normalise order").nodeId}.total`,
        op: "gte",
        value: 500,
      },
    ]);
  });

  it("carries headers/query/body and warns that credential auth was not imported", () => {
    const http = node(byName("Escalate to CRM").nodeId!);
    const setId = byName("Normalise order").nodeId;
    expect(http.config?.method).toBe("POST");
    expect(http.config?.headers).toEqual({
      "X-Order-Id": `{{ ${setId}.orderId }}`,
      "X-Source": "n8n",
    });
    expect(http.config?.body).toEqual({
      order: `{{ ${setId}.orderId }}`,
      amount: `{{ ${setId}.total }}`,
    });
    expect(byName("Escalate to CRM").notes.join(" ")).toMatch(
      /credentials are never imported/,
    );
  });

  it("flags the active flag and the unimported credential type", () => {
    expect(out.warnings.join(" ")).toMatch(/never activated automatically/);
    expect(out.credentials).toEqual([
      {
        n8nType: "httpHeaderAuth",
        usedBy: ["Escalate to CRM", "Webhook"],
        suggestedConnectionType: "custom",
      },
    ]);
  });

  it("keeps the n8n node name as the display name (ids are slugs)", () => {
    const ifNode = node(byName("High value?").nodeId!);
    expect(ifNode.name).toBe("High value?");
    expect(ifNode.id).toBe("high-value");
  });
});

describe("02 — schedule → http → code → email", () => {
  const out = parseN8nWorkflow(load("02-schedule-http-code-email.json"));
  const byName = (n: string) => out.nodes.find((r) => r.n8nName === n)!;
  const node = (id: string) => out.graph.nodes.find((n) => n.id === id)!;

  it("derives a cron expression from n8n's schedule rule", () => {
    expect(node(byName("Every morning").nodeId!).config).toEqual({
      cron: "30 6 * * *",
    });
  });

  it("WARNS that saving a schedule-triggered import creates a live cron", () => {
    // Saving keys off the entry node's type and calls syncCronSchedule — a real side effect the
    // user must know about before they hit save.
    expect(out.warnings.join(" ")).toMatch(/live cron schedule/);
  });

  it("maps continueOnFail to onError: continue", () => {
    expect(node(byName("Fetch summary").nodeId!).onError).toBe("continue");
  });

  it("imports the code body verbatim but flags n8n's item API", () => {
    const code = node(byName("Summarise rows").nodeId!);
    expect(String(code.config?.code)).toContain("rows.reduce");
    expect(byName("Summarise rows").notes.join(" ")).toMatch(/n8n's item API/);
    // A node note in n8n is kept as an annotation rather than thrown away.
    expect(code.config?.__n8nNote).toBe("Totals the per-endpoint counts.");
  });

  it("maps emailSend to sendEmail WITHOUT a connection, and says so", () => {
    const email = node(byName("Email the digest").nodeId!);
    expect(email.type).toBe("sendEmail");
    expect(email.config?.connectionId).toBeUndefined();
    expect(email.config?.to).toBe("ops@example.com");
    expect(email.config?.subject).toBe(
      `Daily metrics — {{ ${byName("Summarise rows").nodeId}.total }} events`,
    );
    expect(byName("Email the digest").notes.join(" ")).toMatch(
      /needs an SMTP connection/,
    );
    expect(
      out.credentials.find((c) => c.n8nType === "smtp")
        ?.suggestedConnectionType,
    ).toBe("smtp");
  });
});

describe("03 — AI agent with sub-nodes", () => {
  const out = parseN8nWorkflow(load("03-ai-agent-with-subnodes.json"));
  const byName = (n: string) => out.nodes.find((r) => r.n8nName === n)!;
  const node = (id: string) => out.graph.nodes.find((n) => n.id === id)!;

  it("does NOT put model/memory/tool sub-nodes in the execution path", () => {
    for (const sub of [
      "OpenAI Chat Model",
      "Window Buffer Memory",
      "Ticket lookup",
    ]) {
      expect(byName(sub).status).toBe("skipped");
      expect(byName(sub).nodeId).toBeNull();
    }
    // 6 n8n nodes, 3 of them sub-nodes → 3 graph nodes.
    expect(out.graph.nodes).toHaveLength(3);
    // And no ai_* wiring became an edge.
    expect(out.graph.edges).toHaveLength(2);
  });

  it("folds the LLM sub-node's provider + model into the agent", () => {
    const agent = node(byName("Support Agent").nodeId!);
    expect(agent.type).toBe("agent");
    expect(agent.config?.provider).toBe("openai");
    expect(agent.config?.model).toBe("gpt-4o-mini");
    expect(agent.config?.systemPrompt).toContain("concise support agent");
    expect(byName("Support Agent").notes.join(" ")).toMatch(
      /add your own provider key/,
    );
  });

  it("maps the Slack app node to our slack integration with no action guessed", () => {
    const slack = node(byName("Log to Slack").nodeId!);
    expect(slack.type).toBe("integration");
    expect(slack.config?.provider).toBe("slack");
    // Guessing the action would be wrong; the report says to pick one.
    expect(slack.config?.action).toBeUndefined();
    expect(slack.config?.connectionId).toBeUndefined();
    expect(byName("Log to Slack").status).toBe("approximated");
    expect(byName("Log to Slack").notes.join(" ")).toMatch(/Pick the action/);
  });

  it("uses the chat trigger as the entry node", () => {
    expect(out.graph.startNodeId).toBe(
      byName("When chat message received").nodeId,
    );
  });
});

describe("04 — switch → branches → merge, plus a sticky note and a disabled node", () => {
  const out = parseN8nWorkflow(load("04-switch-branches-merge.json"));
  const byName = (n: string) => out.nodes.find((r) => r.n8nName === n)!;
  const node = (id: string) => out.graph.nodes.find((n) => n.id === id)!;

  it("names the switch rules and gates the first two edges on them", () => {
    const sw = node(byName("Route by priority").nodeId!);
    expect(sw.type).toBe("switch");
    expect(sw.config?.rules).toEqual([
      {
        name: "urgent",
        condition: {
          path: `${byName("Ticket created").nodeId}.body.priority`,
          op: "eq",
          value: "urgent",
        },
      },
      {
        name: "normal",
        condition: {
          path: `${byName("Ticket created").nodeId}.body.priority`,
          op: "eq",
          value: "normal",
        },
      },
    ]);
    const swId = sw.id;
    const out0 = out.graph.edges.find(
      (e) => e.from === swId && e.to === byName("Page on-call").nodeId,
    );
    expect(out0?.condition).toEqual({
      path: `${swId}.matched`,
      op: "eq",
      value: "urgent",
    });
  });

  it("GATES the fallback output instead of leaving it unconditional", () => {
    // The fixture sets `options.fallbackOutput: "extra"`, so n8n's third output is the fallback.
    // Leaving that edge unconditional would fire the "Ignore" branch on EVERY run, whichever rule
    // matched — the bug this translation exists to prevent.
    const sw = node(byName("Route by priority").nodeId!);
    expect(sw.config?.fallback).toBe("fallback");
    const toIgnore = out.graph.edges.find(
      (e) => e.from === sw.id && e.to === byName("Ignore").nodeId,
    );
    expect(toIgnore?.condition).toEqual({
      path: `${sw.id}.matched`,
      op: "eq",
      value: "fallback",
    });
    // No note complaining about an ungated edge, because there isn't one.
    expect(byName("Route by priority").notes.join(" ")).not.toMatch(
      /UNCONDITIONAL/,
    );
  });

  it("still flags an output past the rules when the node declares NO fallback", () => {
    const noFallback = parseN8nWorkflow({
      nodes: [
        { name: "Hook", type: "n8n-nodes-base.webhook", parameters: {} },
        {
          name: "Route",
          type: "n8n-nodes-base.switch",
          parameters: {
            rules: { values: [{ outputKey: "a", conditions: {} }] },
          },
        },
        { name: "A", type: "n8n-nodes-base.noOp", parameters: {} },
        { name: "Extra", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Hook: { main: [[{ node: "Route", type: "main", index: 0 }]] },
        Route: {
          main: [
            [{ node: "A", type: "main", index: 0 }],
            [{ node: "Extra", type: "main", index: 0 }],
          ],
        },
      },
    });
    const route = noFallback.nodes.find((r) => r.n8nName === "Route")!;
    expect(route.notes.join(" ")).toMatch(/UNCONDITIONAL/);
    expect(validateGraph(noFallback.graph).valid).toBe(true);
  });

  it("strips the branch conditions on edges INTO the merge, and says what was lost", () => {
    const mergeId = byName("Merge outcomes").nodeId!;
    const into = out.graph.edges.filter((e) => e.to === mergeId);
    // Three branches plus the switch's own `urgent` output fanning straight into the join.
    expect(into).toHaveLength(4);
    for (const e of into) expect(e.condition).toBeUndefined();
    // This is a real semantic change, so the merge is downgraded from `imported`.
    expect(byName("Merge outcomes").status).toBe("approximated");
    expect(byName("Merge outcomes").notes.join(" ")).toMatch(
      /waits for EVERY inbound branch/,
    );
  });

  it("skips the sticky note as an annotation rather than a node", () => {
    expect(byName("Sticky Note").status).toBe("skipped");
    expect(byName("Sticky Note").nodeId).toBeNull();
    expect(byName("Sticky Note").notes.join(" ")).toMatch(/annotation/);
  });

  it("BRIDGES a disabled node so the flow through it survives", () => {
    const disabled = byName("Audit (disabled)");
    expect(disabled.status).toBe("skipped");
    expect(disabled.nodeId).toBeNull();
    // Merge → (disabled Audit) → Render summary becomes Merge → Render summary directly.
    const mergeId = byName("Merge outcomes").nodeId!;
    const renderId = byName("Render summary").nodeId!;
    expect(
      out.graph.edges.some((e) => e.from === mergeId && e.to === renderId),
    ).toBe(true);
  });
});

describe("05 — n8n loop constructs and app nodes we cannot express", () => {
  const out = parseN8nWorkflow(load("05-loops-and-unknown-nodes.json"));
  const byName = (n: string) => out.nodes.find((r) => r.n8nName === n)!;
  const node = (id: string) => out.graph.nodes.find((n) => n.id === id)!;

  it("keeps unmapped nodes as noOp PLACEHOLDERS carrying the original config", () => {
    for (const name of [
      "Split Out records",
      "Loop Over Items",
      "Notify sub-workflow",
      "Archive to S3",
    ]) {
      const r = byName(name);
      expect(r.status).toBe("unmapped");
      const n = node(r.nodeId!);
      expect(n.type).toBe("noOp");
      // The original n8n type + parameters are recoverable by hand — nothing is lost.
      const kept = n.config?.__n8n as {
        type: string;
        parameters: Record<string, unknown>;
      };
      expect(kept.type).toBe(
        (
          load("05-loops-and-unknown-nodes.json") as {
            nodes: Array<{ name: string; type: string }>;
          }
        ).nodes.find((x) => x.name === name)!.type,
      );
      expect(Object.keys(kept.parameters).length).toBeGreaterThan(0);
    }
  });

  it("explains WHY a loop is unmapped rather than emitting an unclosable bracket", () => {
    // Emitting splitOut without a matching loopEnd would fail validateGraph outright; emitting the
    // pair would fail because the body (an S3 write) is not allowed inside a region.
    expect(byName("Loop Over Items").notes.join(" ")).toMatch(
      /splitOut…loopEnd region may only contain pure nodes/,
    );
    expect(byName("Split Out records").notes.join(" ")).toMatch(
      /draw the region by hand/,
    );
    expect(byName("Notify sub-workflow").notes.join(" ")).toMatch(
      /needs one of OUR workflow keys/,
    );
  });

  it("maps a known app node (Airtable) to the integration node", () => {
    const air = node(byName("Load customers").nodeId!);
    expect(air.type).toBe("integration");
    expect(air.config?.provider).toBe("airtable");
    expect(getIntegrationProvider("airtable")).toBeTruthy();
  });

  it("flags $now as unconvertible instead of inventing a value", () => {
    const bad = out.unconvertedExpressions.filter((u) =>
      u.expression.includes("$now"),
    );
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0].reason).toMatch(/dateTime node/);
  });

  it("still produces a saveable graph despite the cycle back into the loop", () => {
    // Cycles are legal here; what matters is that the placeholder path validates.
    expect(validateGraph(out.graph).valid).toBe(true);
  });
});

describe("06 — legacy v1 node shapes and an error-trigger entry", () => {
  const out = parseN8nWorkflow(load("06-error-workflow-legacy-nodes.json"));
  const byName = (n: string) => out.nodes.find((r) => r.n8nName === n)!;
  const node = (id: string) => out.graph.nodes.find((n) => n.id === id)!;

  it("uses the error trigger as the entry", () => {
    expect(out.graph.startNodeId).toBe(byName("Error Trigger").nodeId);
    expect(node(out.graph.startNodeId).type).toBe("errorTrigger");
  });

  it("reads the legacy v1 Set `values` shape", () => {
    const set = node(byName("Build context").nodeId!);
    const fields = set.config?.fields as Record<string, unknown>;
    // $node["Error Trigger"].json.workflow.name → the slugged id
    expect(fields.workflowName).toBe(
      `{{ ${byName("Error Trigger").nodeId}.workflow.name }}`,
    );
    // Unconvertible tokens survive VERBATIM (visible + reported), never silently blanked.
    expect(String(fields.retryHint)).toContain("$now");
    expect(String(fields.attempts)).toContain("$runIndex");
    const reasons = out.unconvertedExpressions.map((u) => u.reason).join(" ");
    expect(reasons).toMatch(/dateTime node/);
    expect(reasons).toMatch(/per-run loop index/);
  });

  it("reads the legacy v1 IF `conditions.string` shape", () => {
    expect(node(byName("Transient?").nodeId!).config?.conditions).toEqual([
      {
        // NOT `wait-5-min.summary`: our `wait` node's output is not the data flowing through it, so
        // `$json` resolves PAST it to the node that actually produced `summary`. Binding to the
        // literal predecessor would compile fine and resolve to nothing at run time.
        path: `${byName("Build context").nodeId}.summary`,
        op: "contains",
        value: "timeout",
      },
    ]);
  });

  it("converts a wait amount+unit into seconds", () => {
    expect(node(byName("Wait 5 min").nodeId!).config).toEqual({
      mode: "duration",
      durationSeconds: 300,
    });
  });

  it("maps the legacy Function node to code, approximated", () => {
    expect(byName("Extract message").status).toBe("approximated");
    expect(node(byName("Extract message").nodeId!).type).toBe("code");
  });

  it("leaves an app node we have no provider for as a placeholder", () => {
    const tg = byName("Telegram alert");
    expect(tg.status).toBe("unmapped");
    expect(node(tg.nodeId!).type).toBe("noOp");
    expect((node(tg.nodeId!).config?.__n8n as { type: string }).type).toBe(
      "n8n-nodes-base.telegram",
    );
  });
});

describe("the importer stays OUT of the worker's deterministic bundle", () => {
  it("is not reachable from the @naary/dsl barrel", async () => {
    // Workflow code imports the barrel for real values (computeItemsRegions, resolveHmac, …), so
    // anything re-exported there lands in the Temporal workflow bundle. ~1300 lines of one-shot
    // authoring-time translation must not (Tier-1 rule 2 — the same reasoning that keeps zod behind
    // ./registry). The API imports `@naary/dsl/dist/n8n-import` directly instead.
    const barrel: Record<string, unknown> = await import("../src/index");
    for (const name of [
      "parseN8nWorkflow",
      "N8nImportError",
      "N8N_NODE_MAP",
      "translateConfig",
      "convertN8nExpression",
    ]) {
      expect(
        Object.hasOwn(barrel, name),
        `${name} must not be in the barrel`,
      ).toBe(false);
    }
  });
});

describe("the mapping table itself cannot drift from the node catalog", () => {
  it("every mapped nodeType is a real NodeType", () => {
    for (const [n8nType, m] of Object.entries(N8N_NODE_MAP)) {
      if (m.nodeType === null) {
        // A null mapping must explain itself — that note IS the user-facing report entry.
        expect(m.note, n8nType).toBeTruthy();
        continue;
      }
      expect(NODE_TYPES, n8nType).toContain(m.nodeType);
    }
  });

  it("every app mapping names a provider that exists in the integration catalog", () => {
    for (const [n8nType, provider] of Object.entries(N8N_APP_TO_PROVIDER)) {
      expect(getIntegrationProvider(provider), n8nType).toBeTruthy();
    }
  });

  it("a sub-node type is never also in the main mapping table", () => {
    for (const t of N8N_SUB_NODE_TYPES) {
      expect(Object.hasOwn(N8N_NODE_MAP, t), t).toBe(false);
    }
  });

  it("anything not `imported` carries a note", () => {
    for (const [n8nType, m] of Object.entries(N8N_NODE_MAP)) {
      if (m.status !== "imported") expect(m.note, n8nType).toBeTruthy();
    }
  });
});

describe("expression translation", () => {
  const ids = new Map([["My Node", "my-node"]]);

  it.each([
    ["={{ $json.a.b }}", "{{ up.a.b }}"],
    ["={{ $json }}", "{{ up }}"],
    ['={{ $json["email"] }}', "{{ up.email }}"],
    ['={{ $node["My Node"].json.x }}', "{{ my-node.x }}"],
    ["={{ $('My Node').item.json.x.y }}", "{{ my-node.x.y }}"],
    ["={{ $('My Node').first().json.x }}", "{{ my-node.x }}"],
    ["={{ $vars.REGION }}", "{{ $vars.REGION }}"],
    ["=prefix {{ $json.id }} suffix", "prefix {{ up.id }} suffix"],
    ["plain literal", "plain literal"],
  ])("converts %j", (input, expected) => {
    const out = convertN8nExpression(input, "up", ids);
    expect(out.value).toBe(expected);
    expect(out.unconverted).toEqual([]);
  });

  it.each([
    ["={{ $json.total * 1.2 }}", /JavaScript expression/],
    ["={{ $now.toISO() }}", /dateTime node/],
    ["={{ $runIndex }}", /per-run loop index/],
    ["={{ $credentials.apiKey }}", /credentials are never available/],
    ["={{ $env.HOME }}", /\$vars\.NAME/],
    ['={{ $node["Missing"].json.x }}', /not in this workflow/],
  ])("flags %j as unconverted and keeps it verbatim", (input, reason) => {
    const out = convertN8nExpression(input, "up", ids);
    expect(out.unconverted).toHaveLength(1);
    expect(out.unconverted[0].reason).toMatch(reason);
    // Verbatim: the user can see what to fix.
    expect(out.value).toBe(input.slice(1));
  });

  it("cannot bind $json when the node has no single predecessor (a fan-in)", () => {
    const out = convertN8nExpression("={{ $json.x }}", null, ids);
    expect(out.unconverted[0].reason).toMatch(/no single upstream node/);
  });

  it("keeps the good half of a value that mixes convertible and not", () => {
    const out = convertN8nExpression(
      "={{ $json.id }} at {{ $now }}",
      "up",
      ids,
    );
    expect(out.value).toBe("{{ up.id }} at {{ $now }}");
    expect(out.unconverted).toHaveLength(1);
  });

  it("never lets a __proto__ key from the export reach a built object", () => {
    const out = parseN8nWorkflow({
      name: "evil",
      nodes: [
        {
          name: "Set",
          type: "n8n-nodes-base.set",
          parameters: {
            assignments: {
              assignments: [
                { name: "ok", value: "1" },
                { name: "__proto__", value: { polluted: true } },
              ],
            },
          },
        },
      ],
      connections: {},
    });
    const fields = out.graph.nodes[0].config?.fields as Record<string, unknown>;
    expect(Object.hasOwn(fields, "ok")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("degrading rather than failing", () => {
  it("throws only when the input is not an n8n workflow at all", () => {
    expect(() => parseN8nWorkflow({})).toThrow(N8nImportError);
    expect(() => parseN8nWorkflow({ nodes: [] })).toThrow(N8nImportError);
    expect(() => parseN8nWorkflow("nope")).toThrow(N8nImportError);
  });

  it("a single unknown node still yields a saveable one-node graph", () => {
    const out = parseN8nWorkflow({
      nodes: [
        {
          name: "Mystery",
          type: "n8n-nodes-base.somethingNew",
          parameters: { a: 1 },
        },
      ],
      connections: {},
    });
    expect(validateGraph(out.graph).valid).toBe(true);
    expect(validateGraphConfigs(out.graph)).toEqual([]);
    expect(out.nodes[0].status).toBe("unmapped");
    expect(out.graph.startNodeId).toBe(out.graph.nodes[0].id);
  });

  it("wires a disconnected trigger so the graph is not rejected as disconnected", () => {
    const out = parseN8nWorkflow({
      nodes: [
        { name: "Webhook", type: "n8n-nodes-base.webhook", parameters: {} },
        { name: "Orphan", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {},
    });
    expect(validateGraph(out.graph).valid).toBe(true);
    expect(out.warnings.join(" ")).toMatch(/had no outgoing connection/);
  });

  it("de-duplicates ids derived from colliding node names", () => {
    const out = parseN8nWorkflow({
      nodes: [
        { name: "Do it!", type: "n8n-nodes-base.noOp", parameters: {} },
        { name: "Do it?", type: "n8n-nodes-base.noOp", parameters: {} },
        { name: "do  it", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        "Do it!": { main: [[{ node: "Do it?", type: "main", index: 0 }]] },
      },
    });
    const ids = out.graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["do-it", "do-it-2", "do-it-3"]);
    expect(validateGraph(out.graph).valid).toBe(true);
  });

  it("bridges a disabled node that FANS OUT without dropping a sibling edge", () => {
    const out = parseN8nWorkflow({
      nodes: [
        { name: "Hook", type: "n8n-nodes-base.webhook", parameters: {} },
        {
          name: "Off",
          type: "n8n-nodes-base.noOp",
          parameters: {},
          disabled: true,
        },
        { name: "Left", type: "n8n-nodes-base.noOp", parameters: {} },
        { name: "Right", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Hook: { main: [[{ node: "Off", type: "main", index: 0 }]] },
        Off: {
          main: [
            [
              { node: "Left", type: "main", index: 0 },
              { node: "Right", type: "main", index: 0 },
            ],
          ],
        },
      },
    });
    const hook = out.nodes.find((r) => r.n8nName === "Hook")!.nodeId;
    const targets = out.graph.edges
      .filter((e) => e.from === hook)
      .map((e) => e.to)
      .sort();
    expect(targets).toEqual(["left", "right"]);
    expect(validateGraph(out.graph).valid).toBe(true);
  });

  it("bridges a CHAIN of disabled nodes whose branches reconverge — no edge lost", () => {
    // The case that actually stresses resolveTargets's shared visited-set: Off fans out to two
    // further BRIDGES, one of which reaches a target the other also reaches, plus one it doesn't.
    // The union must be complete — a per-branch short-circuit must not cost the `Only` edge.
    const dis = (name: string) => ({
      name,
      type: "n8n-nodes-base.noOp",
      parameters: {},
      disabled: true,
    });
    const out = parseN8nWorkflow({
      nodes: [
        { name: "Hook", type: "n8n-nodes-base.webhook", parameters: {} },
        dis("Off"),
        dis("Mid1"),
        dis("Mid2"),
        { name: "Shared", type: "n8n-nodes-base.noOp", parameters: {} },
        { name: "Only", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Hook: { main: [[{ node: "Off", type: "main", index: 0 }]] },
        Off: {
          main: [
            [
              { node: "Mid1", type: "main", index: 0 },
              { node: "Mid2", type: "main", index: 0 },
            ],
          ],
        },
        Mid1: { main: [[{ node: "Shared", type: "main", index: 0 }]] },
        Mid2: {
          main: [
            [
              { node: "Shared", type: "main", index: 0 },
              { node: "Only", type: "main", index: 0 },
            ],
          ],
        },
      },
    });
    const hook = out.nodes.find((r) => r.n8nName === "Hook")!.nodeId;
    const targets = out.graph.edges
      .filter((e) => e.from === hook)
      .map((e) => e.to)
      .sort();
    expect(targets).toEqual(["only", "shared"]);
    expect(validateGraph(out.graph).valid).toBe(true);
  });

  it("emits ONE edge when a bridge diamond reconverges on the same target", () => {
    const out = parseN8nWorkflow({
      nodes: [
        { name: "Hook", type: "n8n-nodes-base.webhook", parameters: {} },
        {
          name: "Off",
          type: "n8n-nodes-base.noOp",
          parameters: {},
          disabled: true,
        },
        { name: "End", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Hook: { main: [[{ node: "Off", type: "main", index: 0 }]] },
        Off: {
          main: [
            [
              { node: "End", type: "main", index: 0 },
              { node: "End", type: "main", index: 0 },
            ],
          ],
        },
      },
    });
    const hook = out.nodes.find((r) => r.n8nName === "Hook")!.nodeId;
    expect(out.graph.edges.filter((e) => e.from === hook)).toHaveLength(1);
  });

  it("warns when the export has more than one trigger", () => {
    const out = parseN8nWorkflow({
      nodes: [
        { name: "Hook", type: "n8n-nodes-base.webhook", parameters: {} },
        {
          name: "Cronjob",
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {},
        },
        { name: "Step", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Hook: { main: [[{ node: "Step", type: "main", index: 0 }]] },
        Cronjob: { main: [[{ node: "Step", type: "main", index: 0 }]] },
      },
    });
    expect(out.warnings.join(" ")).toMatch(/more than one trigger/);
    expect(validateGraph(out.graph).valid).toBe(true);
  });
});
