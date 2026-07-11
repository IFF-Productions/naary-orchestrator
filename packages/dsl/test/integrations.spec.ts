import { describe, expect, it } from "vitest";
import {
  INTEGRATION_PROVIDERS,
  buildIntegrationRequest,
  getIntegrationAction,
  resolveIntegrationFields,
  validateIntegrationConfig,
} from "../src";
import type { IntegrationNodeConfig } from "../src/types";

/**
 * The catalog is the single source of truth (design docs/design/INTEGRATION-NODES.md §7).
 * These tests prove we build the RIGHT request from the catalog — method, path, body. They do
 * NOT prove GitHub/Jira accept it (API drift / scopes); that's a documented manual smoke test.
 */

describe("integration catalog — request construction", () => {
  it("GitHub create_issue → POST /repos/{owner}/{repo}/issues with a JSON body", () => {
    const req = buildIntegrationRequest("github", "create_issue", {
      owner: "octocat",
      repo: "hello",
      title: "It broke",
      body: "steps…",
      labels: ["bug"],
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/repos/octocat/hello/issues");
    expect(req.body).toEqual({
      title: "It broke",
      body: "steps…",
      labels: ["bug"],
    });
  });

  it("GitHub comment_issue → path number substituted, comment in body", () => {
    const req = buildIntegrationRequest("github", "comment_issue", {
      owner: "octocat",
      repo: "hello",
      issueNumber: 42,
      body: "triaged",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/repos/octocat/hello/issues/42/comments");
    expect(req.body).toEqual({ body: "triaged" });
  });

  it("GitHub get_issue → GET, no body", () => {
    const req = buildIntegrationRequest("github", "get_issue", {
      owner: "octocat",
      repo: "hello",
      issueNumber: 7,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/repos/octocat/hello/issues/7");
    expect(req.body).toBeUndefined();
  });

  it("Jira create_issue → nested fields.* body via bodyPath", () => {
    const req = buildIntegrationRequest("jira", "create_issue", {
      projectKey: "PROJ",
      summary: "Login is down",
      issueType: "Bug",
      description: "500 on /login",
      priority: "High",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/rest/api/2/issue");
    expect(req.body).toEqual({
      fields: {
        project: { key: "PROJ" },
        summary: "Login is down",
        issuetype: { name: "Bug" },
        description: "500 on /login",
        priority: { name: "High" },
      },
    });
  });

  it("Jira transition_issue → nested transition.id in body, key in path", () => {
    const req = buildIntegrationRequest("jira", "transition_issue", {
      issueKey: "PROJ-12",
      transitionId: "31",
    });
    expect(req.path).toBe("/rest/api/2/issue/PROJ-12/transitions");
    expect(req.body).toEqual({ transition: { id: "31" } });
  });

  it("Slack post_message → POST /chat.postMessage, threadTs maps to thread_ts", () => {
    const req = buildIntegrationRequest("slack", "post_message", {
      channel: "#test",
      text: "hi",
      threadTs: "1700000000.000100",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/chat.postMessage");
    expect(req.body).toEqual({
      channel: "#test",
      text: "hi",
      thread_ts: "1700000000.000100",
    });
  });

  it("omits missing optional body fields (a blank optional stays out of the payload)", () => {
    const req = buildIntegrationRequest("github", "create_issue", {
      owner: "o",
      repo: "r",
      title: "t",
      // body + labels omitted
    });
    expect(req.body).toEqual({ title: "t" });
  });
});

describe("integration field resolution (static + bindings)", () => {
  it("bindings override static fields from ctx", () => {
    const config: IntegrationNodeConfig = {
      provider: "github",
      action: "comment_issue",
      connectionId: "gh",
      fields: { owner: "octocat", repo: "hello" },
      fieldBindings: {
        issueNumber: { from: "trigger", path: "issue.number" },
        body: { from: "triage", path: "output.summary" },
      },
    };
    const ctx = {
      trigger: { issue: { number: 99 } },
      triage: { output: { summary: "looks like a dup" } },
    };
    expect(resolveIntegrationFields(config, ctx)).toEqual({
      owner: "octocat",
      repo: "hello",
      issueNumber: 99,
      body: "looks like a dup",
    });
  });
});

describe("integration save-gate validation", () => {
  const base = {
    provider: "github",
    action: "create_issue",
    connectionId: "gh",
  };

  it("passes when required fields are supplied (static or bound)", () => {
    expect(
      validateIntegrationConfig({
        ...base,
        fields: { owner: "o", repo: "r" },
        fieldBindings: { title: { from: "a", path: "b" } },
      }),
    ).toBeNull();
  });

  it("rejects a missing required field", () => {
    expect(
      validateIntegrationConfig({ ...base, fields: { owner: "o", repo: "r" } }),
    ).toMatch(/missing required field 'title'/);
  });

  it("rejects a present-but-EMPTY static required field (matches build-time omission)", () => {
    // "" / [] count as missing — else the gate passes but buildIntegrationRequest drops it.
    expect(
      validateIntegrationConfig({
        ...base,
        fields: { owner: "o", repo: "r", title: "" },
      }),
    ).toMatch(/missing required field 'title'/);
    expect(
      validateIntegrationConfig({
        provider: "github",
        action: "add_labels",
        connectionId: "gh",
        fields: { owner: "o", repo: "r", issueNumber: 1, labels: [] },
      }),
    ).toMatch(/missing required field 'labels'/);
  });

  it("rejects a missing path field", () => {
    expect(
      validateIntegrationConfig({
        provider: "github",
        action: "comment_issue",
        connectionId: "gh",
        fields: { owner: "o", repo: "r", body: "hi" },
      }),
    ).toMatch(/missing (required field|path field) 'issueNumber'/);
  });

  it("rejects unknown provider / action", () => {
    expect(validateIntegrationConfig({ ...base, provider: "nope" })).toMatch(
      /unknown integration provider/,
    );
    expect(validateIntegrationConfig({ ...base, action: "nope" })).toMatch(
      /unknown action/,
    );
  });
});

describe("integration catalog — self-consistency (can't drift)", () => {
  for (const provider of INTEGRATION_PROVIDERS) {
    describe(provider.key, () => {
      it("has a base URL xor connection-based base", () => {
        expect(!!provider.baseUrl !== !!provider.baseUrlFromConnection).toBe(
          true,
        );
      });
      for (const action of provider.actions) {
        describe(action.key, () => {
          it("every {placeholder} is a declared path field", () => {
            const placeholders = [
              ...action.pathTemplate.matchAll(/\{([^}]+)\}/g),
            ].map((m) => m[1]);
            for (const ph of placeholders) {
              const f = action.fields.find(
                (x) => x.key === ph && x.in === "path",
              );
              expect(f, `${action.key} placeholder {${ph}}`).toBeDefined();
            }
          });
          it("every field has a non-empty label", () => {
            for (const f of action.fields)
              expect(f.label.length).toBeGreaterThan(0);
          });
          it("is resolvable via getIntegrationAction", () => {
            expect(getIntegrationAction(provider.key, action.key)).toBe(action);
          });
        });
      }
    });
  }
});
