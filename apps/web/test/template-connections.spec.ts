import type { GraphDef } from "@naary/dsl";
import {
  apiEnrichGraph,
  dbReportGraph,
  feedDigestGraph,
  githubIssueTriageGraph,
  githubReviewGraph,
  jiraTicketGraph,
  moderationGraph,
  sampleGraph,
  supportReplyGraph,
  webhookSampleGraph,
} from "@naary/dsl";
import { describe, expect, it } from "vitest";
import type { ConnectionRow, TemplateDetail } from "../src/lib/api";
import {
  checkConnectionRequirements,
  deriveConnectionRequirements,
  deriveTemplateView,
  resolveCategory,
  unmetCount,
} from "../src/screens/app/templates/model";

/**
 * #574 — the two Templates-screen derivations:
 *  1. the category now comes from the API (with a graph-derived fallback), and
 *  2. the post-import setup checklist: which connections the template's REAL graph needs,
 *     and whether the workspace already has them.
 *
 * Pure logic only (no jsdom) — mirrors graph-model.spec.ts / permissions-logic.spec.ts.
 */

function conn(
  p: Partial<ConnectionRow> & Pick<ConnectionRow, "type">,
): ConnectionRow {
  return {
    id: `c-${p.type}`,
    label: `${p.type} connection`,
    serverUrl: "https://example.test",
    authMode: "api_token",
    scopes: [],
    status: "connected",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...p,
  };
}

function graph(nodes: GraphDef["nodes"]): GraphDef {
  return { startNodeId: nodes[0].id, nodes, edges: [] };
}

const ids = (g: GraphDef) => deriveConnectionRequirements(g).map((r) => r.id);

describe("deriveConnectionRequirements", () => {
  it("maps each connection-consuming node type to its acceptable connection types", () => {
    const reqs = deriveConnectionRequirements(
      graph([
        { id: "mail", type: "sendEmail", config: { connectionId: "smtp" } },
        {
          id: "q",
          type: "sqlQuery",
          config: { connectionId: "app-db", sql: "select 1" },
        },
        { id: "sign", type: "jwt", config: { connectionId: "signing" } },
      ]),
    );
    const byId = new Map(reqs.map((r) => [r.id, r]));
    expect(byId.get("smtp")?.types).toEqual(["smtp"]);
    // Any SQL engine satisfies a sqlQuery node.
    expect(byId.get("database")?.types).toEqual(["postgres", "mssql", "mysql"]);
    expect(byId.get("signing")?.types).toEqual(["signing"]);
    // The CTA routes at the Integrations tab that actually hosts the form.
    expect(byId.get("smtp")?.tab).toBe("providers");
  });

  it("resolves an integration node by PROVIDER, not the canvas's generic app set", () => {
    const reqs = deriveConnectionRequirements(
      graph([
        {
          id: "gh",
          type: "integration",
          config: {
            provider: "github",
            action: "create_issue",
            connectionId: "github",
          },
        },
        {
          id: "jira",
          type: "integration",
          config: {
            provider: "jira",
            action: "create_issue",
            connectionId: "jira",
          },
        },
      ]),
    );
    expect(reqs.map((r) => [r.id, r.label, r.types])).toEqual([
      ["integration:github", "GitHub", ["github"]],
      // Label comes from the DSL integration catalog, not a local string table.
      ["integration:jira", "Jira", ["atlassian"]],
    ]);
  });

  it("uses a `custom` connection for a provider with no dedicated connection type", () => {
    const [req] = deriveConnectionRequirements(
      graph([
        {
          id: "slack",
          type: "integration",
          config: {
            provider: "slack",
            action: "post_message",
            connectionId: "slack",
          },
        },
      ]),
    );
    expect(req.label).toBe("Slack");
    // Slack/Notion/GitLab etc. are connected as `custom`; a GitHub connection must NOT
    // read as satisfying one — a false "satisfied" is the misleading direction.
    expect(req.types).toEqual(["custom"]);
    expect(
      checkConnectionRequirements([req], [conn({ type: "github" })])[0].status,
    ).toBe("missing");
  });

  it("treats an OPTIONAL connectionId as a requirement only when the template pins one", () => {
    // apiEnrichGraph's shape: a public REST call needs no connection.
    expect(
      ids(
        graph([
          {
            id: "fetch",
            type: "httpRequest",
            config: { method: "GET", url: "https://api.example.com/x" },
          },
        ]),
      ),
    ).toEqual([]);
    // …but an authenticated one does.
    expect(
      ids(
        graph([
          {
            id: "fetch",
            type: "httpRequest",
            config: {
              method: "GET",
              url: "https://api.example.com/x",
              connectionId: "api",
            },
          },
        ]),
      ),
    ).toEqual(["http-auth"]);
    // Blank/whitespace is not a pinned connection.
    expect(
      ids(
        graph([
          {
            id: "fetch",
            type: "httpRequest",
            config: {
              method: "GET",
              url: "https://api.example.com/x",
              connectionId: "  ",
            },
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("counts an agent's MCP tools as an MCP requirement and dedupes same-type nodes", () => {
    const reqs = deriveConnectionRequirements(
      graph([
        {
          id: "a",
          type: "agent",
          config: { tools: [{ connectionId: "mcp-1", tool: "search" }] },
        },
        {
          id: "t",
          type: "mcpTool",
          config: { connectionId: "mcp-1", tool: "search" },
        },
        { id: "m1", type: "sendEmail", config: { connectionId: "smtp" } },
        { id: "m2", type: "sendEmail", config: { connectionId: "smtp" } },
      ]),
    );
    // One MCP row (agent + mcpTool) and ONE email row for two sendEmail nodes.
    expect(reqs.map((r) => r.id)).toEqual(["mcp", "smtp"]);
    expect(reqs[0].nodeIds).toEqual(["a", "t"]);
    expect(reqs[1].nodeIds).toEqual(["m1", "m2"]);
    // The plural reason reflects the real node count.
    expect(reqs[1].reason).toContain("2 nodes");
  });

  it("finds nothing to connect for a pure agent+approval graph", () => {
    expect(
      ids(
        graph([
          { id: "s", type: "start" },
          { id: "a", type: "agent", config: { provider: "anthropic" } },
          { id: "ap", type: "humanApproval" },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("the REAL shipped seed graphs (packages/dsl)", () => {
  // The derivations above use hand-built graphs; this pins what the ACTUAL templates the
  // API serves demand, so editing packages/dsl/src/templates.ts can't silently change the
  // checklist. Keys mirror apps/api/src/templates/templates.controller.ts.
  const cases: [string, GraphDef, string[]][] = [
    ["default", sampleGraph, []],
    ["wf-default", webhookSampleGraph, []],
    ["moderation", moderationGraph, []],
    // Unpinned httpRequest → nothing to connect.
    ["api-enrich", apiEnrichGraph, []],
    ["github-review", githubReviewGraph, ["integration:github"]],
    // mcpTool nodes, NOT integration nodes — the non-obvious pair.
    ["github-issue-triage", githubIssueTriageGraph, ["mcp"]],
    ["jira-ticket", jiraTicketGraph, ["mcp"]],
    ["feed-digest", feedDigestGraph, ["smtp"]],
    ["support-reply", supportReplyGraph, ["smtp"]],
    ["db-report", dbReportGraph, ["database", "smtp"]],
  ];

  it.each(cases)("%s requires %j", (_key, g, expected) => {
    expect(ids(g)).toEqual(expected);
  });

  it("the GitHub PR review template is NOT satisfied by an SMTP-only workspace", () => {
    // The AC's scenario end to end, on the real graph.
    const checked = checkConnectionRequirements(
      deriveConnectionRequirements(githubReviewGraph),
      [conn({ type: "smtp", label: "Company mail" })],
    );
    expect(checked.map((c) => [c.label, c.status])).toEqual([
      ["GitHub", "missing"],
    ]);
    expect(unmetCount(checked)).toBe(1);
  });
});

describe("checkConnectionRequirements", () => {
  const smtpNeed = deriveConnectionRequirements(
    graph([{ id: "m", type: "sendEmail", config: { connectionId: "smtp" } }]),
  );
  const githubNeed = deriveConnectionRequirements(
    graph([
      {
        id: "gh",
        type: "integration",
        config: {
          provider: "github",
          action: "create_issue",
          connectionId: "github",
        },
      },
    ]),
  );

  it("satisfies a requirement from a healthy connection of an acceptable type", () => {
    const [row] = checkConnectionRequirements(smtpNeed, [
      conn({ type: "smtp", label: "Postmark" }),
    ]);
    expect(row.status).toBe("satisfied");
    expect(row.connectionLabel).toBe("Postmark");
    expect(unmetCount([row])).toBe(0);
  });

  it("matches by TYPE, never by the template's placeholder connectionId", () => {
    // The seed graphs carry edit-me placeholders ("smtp"/"app-db"/"github"); id matching
    // would report every requirement missing on every import.
    const [row] = checkConnectionRequirements(smtpNeed, [
      conn({ type: "smtp", id: "cn_9f3", label: "Company mail" }),
    ]);
    expect(row.status).toBe("satisfied");
  });

  it("reports missing when the workspace has no connection of an acceptable type", () => {
    const [row] = checkConnectionRequirements(smtpNeed, [
      conn({ type: "postgres" }),
    ]);
    expect(row.status).toBe("missing");
    expect(row.connectionLabel).toBeUndefined();
    expect(unmetCount([row])).toBe(1);
  });

  it("a broken connection does NOT satisfy, but reports distinctly from missing", () => {
    // An expired GitHub credential IS the broken run — but the fix is repairing the one
    // that exists, not creating a second.
    const [row] = checkConnectionRequirements(githubNeed, [
      conn({ type: "github", label: "acme-org", status: "needs_reauth" }),
    ]);
    expect(row.status).toBe("unhealthy");
    expect(row.connectionLabel).toBe("acme-org");
    // The real connection status rides along, so the UI never guesses the cause.
    expect(row.connectionStatus).toBe("needs_reauth");
    expect(unmetCount([row])).toBe(1);
  });

  it("carries an `error` connection's own status rather than calling it needs_reauth", () => {
    const [row] = checkConnectionRequirements(githubNeed, [
      conn({ type: "github", label: "acme-org", status: "error" }),
    ]);
    expect(row.status).toBe("unhealthy");
    expect(row.connectionStatus).toBe("error");
  });

  it("prefers a healthy connection when a broken one of the same type also exists", () => {
    const [row] = checkConnectionRequirements(githubNeed, [
      conn({ type: "github", id: "c1", label: "old", status: "error" }),
      conn({ type: "github", id: "c2", label: "current" }),
    ]);
    expect(row.status).toBe("satisfied");
    expect(row.connectionLabel).toBe("current");
  });

  it("does not let an unrelated app connection satisfy a GitHub integration", () => {
    // The whole value of the checklist is naming the RIGHT provider.
    const [row] = checkConnectionRequirements(githubNeed, [
      conn({ type: "custom", label: "Some MCP server" }),
    ]);
    expect(row.status).toBe("missing");
  });

  it("accepts any SQL engine for a database requirement", () => {
    const need = deriveConnectionRequirements(
      graph([
        {
          id: "q",
          type: "sqlQuery",
          config: { connectionId: "app-db", sql: "select 1" },
        },
      ]),
    );
    for (const type of ["postgres", "mysql", "mssql"] as const) {
      expect(
        checkConnectionRequirements(need, [conn({ type })])[0].status,
      ).toBe("satisfied");
    }
  });
});

describe("resolveCategory (server taxonomy, graph fallback)", () => {
  const emailGraph = graph([
    { id: "m", type: "sendEmail", config: { connectionId: "smtp" } },
  ]);

  it("uses the API's category id and its local presentation", () => {
    const c = resolveCategory("github", emailGraph);
    expect(c.id).toBe("github");
    expect(c.name).toBe("GitHub");
    // …even though the graph itself would have been inferred as email.
    expect(resolveCategory(undefined, emailGraph).id).toBe("email");
  });

  it("falls back to the graph-derived category when the API sends none/blank", () => {
    expect(resolveCategory(undefined, emailGraph).id).toBe("email");
    expect(resolveCategory("  ", emailGraph).id).toBe("email");
  });

  it("keeps a server id this bundle has no styling for, humanized", () => {
    // Newer API, older SPA: still the SERVER's taxonomy, never a crash on a missing def.
    const c = resolveCategory("code-review", emailGraph);
    expect(c.id).toBe("code-review");
    expect(c.name).toBe("Code review");
    expect(c.icon).toBeTruthy();
  });
});

describe("deriveTemplateView", () => {
  const detail: TemplateDetail = {
    key: "db-report",
    name: "Scheduled database report",
    description: "…",
    nodeCount: 2,
    category: "database",
    tags: ["sql", "reporting"],
    graph: graph([
      {
        id: "q",
        type: "sqlQuery",
        config: { connectionId: "app-db", sql: "select 1" },
      },
      { id: "m", type: "sendEmail", config: { connectionId: "smtp" } },
    ]),
  };

  it("carries the API's category + tags and the graph's requirements onto the view", () => {
    const v = deriveTemplateView(detail);
    expect(v.category.id).toBe("database");
    expect(v.tags).toEqual(["sql", "reporting"]);
    expect(v.requirements.map((r) => r.id)).toEqual(["database", "smtp"]);
  });

  it("tolerates an API response with no category/tags at all", () => {
    const { category: _c, tags: _t, ...legacy } = detail;
    const v = deriveTemplateView(legacy);
    expect(v.tags).toEqual([]);
    // Derived from the graph: sqlQuery wins the precedence, so "database" either way.
    expect(v.category.id).toBe("database");
  });
});
