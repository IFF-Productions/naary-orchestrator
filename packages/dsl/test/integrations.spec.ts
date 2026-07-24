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

  it("Notion create_page → json fields (parent/properties) pass through as objects", () => {
    const req = buildIntegrationRequest("notion", "create_page", {
      parent: { database_id: "db-1" },
      properties: { Name: { title: [{ text: { content: "Hi" } }] } },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/pages");
    expect(req.body).toEqual({
      parent: { database_id: "db-1" },
      properties: { Name: { title: [{ text: { content: "Hi" } }] } },
    });
  });

  it("omits an OPTIONAL json field explicitly set to {} (empty = not sent)", () => {
    const req = buildIntegrationRequest("notion", "query_database", {
      databaseId: "db-1",
      filter: {}, // empty optional filter — must not land in the body
    });
    expect(req.path).toBe("/databases/db-1/query");
    expect(req.body).toBeUndefined();
  });

  it("Notion append_block → path id + children json body", () => {
    const req = buildIntegrationRequest("notion", "append_block", {
      blockId: "blk-1",
      children: [{ type: "paragraph" }],
    });
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/blocks/blk-1/children");
    expect(req.body).toEqual({ children: [{ type: "paragraph" }] });
  });

  it("GitLab create_issue → POST /projects/{projectId}/issues with a JSON body", () => {
    const req = buildIntegrationRequest("gitlab", "create_issue", {
      projectId: "mygroup/myrepo",
      title: "It broke",
      description: "steps…",
      labels: "bug,triage",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/projects/mygroup%2Fmyrepo/issues");
    expect(req.body).toEqual({
      title: "It broke",
      description: "steps…",
      labels: "bug,triage",
    });
  });

  it("GitLab comment_issue → path iid substituted, comment in body", () => {
    const req = buildIntegrationRequest("gitlab", "comment_issue", {
      projectId: 42,
      issueIid: 7,
      body: "triaged",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/projects/42/issues/7/notes");
    expect(req.body).toEqual({ body: "triaged" });
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

  it("HubSpot create_contact → POST /crm/v3/objects/contacts with { properties }", () => {
    const req = buildIntegrationRequest("hubspot", "create_contact", {
      properties: { email: "a@b.com", firstname: "Ada" },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/crm/v3/objects/contacts");
    expect(req.body).toEqual({
      properties: { email: "a@b.com", firstname: "Ada" },
    });
  });

  it("HubSpot update_contact → path id substituted, properties in body", () => {
    const req = buildIntegrationRequest("hubspot", "update_contact", {
      contactId: "12345",
      properties: { lastname: "Lovelace" },
    });
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/crm/v3/objects/contacts/12345");
    expect(req.body).toEqual({ properties: { lastname: "Lovelace" } });
  });

  it("HubSpot get_contact → GET path id, no body", () => {
    const req = buildIntegrationRequest("hubspot", "get_contact", {
      contactId: "12345",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/crm/v3/objects/contacts/12345");
    expect(req.body).toBeUndefined();
  });

  it("HubSpot create_deal → POST /crm/v3/objects/deals with { properties }", () => {
    const req = buildIntegrationRequest("hubspot", "create_deal", {
      properties: { dealname: "Acme", amount: "1000" },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/crm/v3/objects/deals");
    expect(req.body).toEqual({
      properties: { dealname: "Acme", amount: "1000" },
    });
  });

  it("SendGrid send_mail → POST /mail/send with personalizations/from/subject/content in body", () => {
    const req = buildIntegrationRequest("sendgrid", "send_mail", {
      personalizations: [{ to: [{ email: "to@example.com" }] }],
      from: { email: "from@example.com", name: "Naary" },
      subject: "Hello",
      content: [{ type: "text/plain", value: "Hi there" }],
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/mail/send");
    expect(req.body).toEqual({
      personalizations: [{ to: [{ email: "to@example.com" }] }],
      from: { email: "from@example.com", name: "Naary" },
      subject: "Hello",
      content: [{ type: "text/plain", value: "Hi there" }],
    });
  });

  it("SendGrid upsert_contacts → PUT /marketing/contacts with { contacts: [...] } body", () => {
    const req = buildIntegrationRequest("sendgrid", "upsert_contacts", {
      contacts: [{ email: "a@example.com", first_name: "Ada" }],
    });
    expect(req.method).toBe("PUT");
    expect(req.path).toBe("/marketing/contacts");
    expect(req.body).toEqual({
      contacts: [{ email: "a@example.com", first_name: "Ada" }],
    });
  });

  it("SendGrid list_templates → GET with the optional generations query param", () => {
    const req = buildIntegrationRequest("sendgrid", "list_templates", {
      generations: "dynamic",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/templates?generations=dynamic");
    // …and when omitted, no query string is appended.
    expect(buildIntegrationRequest("sendgrid", "list_templates", {}).path).toBe(
      "/templates",
    );
  });

  it("Airtable create_record → POST /{baseId}/{tableId} with a fields body", () => {
    const req = buildIntegrationRequest("airtable", "create_record", {
      baseId: "appX",
      tableId: "tblY",
      fields: { Name: "Ada", Status: "Active" },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/appX/tblY");
    expect(req.body).toEqual({ fields: { Name: "Ada", Status: "Active" } });
  });

  it("Airtable get_record → GET path with recordId, no body", () => {
    const req = buildIntegrationRequest("airtable", "get_record", {
      baseId: "appX",
      tableId: "tblY",
      recordId: "recZ",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/appX/tblY/recZ");
    expect(req.body).toBeUndefined();
  });

  it("Asana create_task → POST /tasks, body wrapped in the data envelope", () => {
    const req = buildIntegrationRequest("asana", "create_task", {
      name: "Ship it",
      notes: "before Friday",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/tasks");
    expect(req.body).toEqual({
      data: { name: "Ship it", notes: "before Friday" },
    });
  });

  it("Asana add_comment → path gid + text nested under data", () => {
    const req = buildIntegrationRequest("asana", "add_comment", {
      taskGid: "12345",
      text: "looks good",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/tasks/12345/stories");
    expect(req.body).toEqual({ data: { text: "looks good" } });
  });

  it("Todoist create_task → POST /tasks, projectId maps to project_id via bodyPath", () => {
    const req = buildIntegrationRequest("todoist", "create_task", {
      content: "Buy milk",
      projectId: "2203306141",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/tasks");
    expect(req.body).toEqual({
      content: "Buy milk",
      project_id: "2203306141",
    });
  });

  it("Todoist close_task → POST path id, no body", () => {
    const req = buildIntegrationRequest("todoist", "close_task", {
      taskId: "2995104339",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/tasks/2995104339/close");
    expect(req.body).toBeUndefined();
  });

  it("Todoist list_tasks → GET with the query param named project_id (not projectId)", () => {
    const req = buildIntegrationRequest("todoist", "list_tasks", {
      project_id: "2203306141",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/tasks?project_id=2203306141");
  });

  it("Calendly get_event → GET, uuid in path, no body", () => {
    const req = buildIntegrationRequest("calendly", "get_event", {
      eventUuid: "evt-123",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/scheduled_events/evt-123");
    expect(req.body).toBeUndefined();
  });

  it("Calendly cancel_event → POST, uuid in path, reason in body", () => {
    const req = buildIntegrationRequest("calendly", "cancel_event", {
      eventUuid: "evt-123",
      reason: "no longer needed",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/scheduled_events/evt-123/cancellation");
    expect(req.body).toEqual({ reason: "no longer needed" });
  });

  it("Calendly list_events → GET with user/status/count query params (order preserved)", () => {
    const req = buildIntegrationRequest("calendly", "list_events", {
      user: "https://api.calendly.com/users/ABC",
      status: "active",
      count: 20,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe(
      "/scheduled_events?user=https%3A%2F%2Fapi.calendly.com%2Fusers%2FABC&status=active&count=20",
    );
  });

  it("Intercom create_contact → POST /contacts with role + email in body", () => {
    const req = buildIntegrationRequest("intercom", "create_contact", {
      role: "user",
      email: "jane@example.com",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/contacts");
    expect(req.body).toEqual({ role: "user", email: "jane@example.com" });
  });

  it("Intercom create_note → path contactId + { body } in the JSON body", () => {
    const req = buildIntegrationRequest("intercom", "create_note", {
      contactId: "c-1",
      body: "left a voicemail",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/contacts/c-1/notes");
    expect(req.body).toEqual({ body: "left a voicemail" });
  });

  it("Webflow create_item → POST with collectionId in path, fieldData json body", () => {
    const req = buildIntegrationRequest("webflow", "create_item", {
      collectionId: "col-1",
      fieldData: { name: "Post", slug: "post" },
      isDraft: true,
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/collections/col-1/items");
    expect(req.body).toEqual({
      fieldData: { name: "Post", slug: "post" },
      isDraft: true,
    });
  });

  it("Webflow get_item → GET with collectionId + itemId in path, no body", () => {
    const req = buildIntegrationRequest("webflow", "get_item", {
      collectionId: "col-1",
      itemId: "item-9",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/collections/col-1/items/item-9");
    expect(req.body).toBeUndefined();
  });

  it("Zoom create_meeting → POST /users/me/meetings with topic + start_time via bodyPath", () => {
    const req = buildIntegrationRequest("zoom", "create_meeting", {
      userId: "me",
      topic: "Sprint review",
      type: 2,
      startTime: "2026-08-01T15:00:00Z",
      duration: 45,
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/users/me/meetings");
    expect(req.body).toEqual({
      topic: "Sprint review",
      type: 2,
      start_time: "2026-08-01T15:00:00Z",
      duration: 45,
    });
  });

  it("Zoom get_meeting → GET /meetings/{meetingId}, no body", () => {
    const req = buildIntegrationRequest("zoom", "get_meeting", {
      meetingId: "8391234567",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/meetings/8391234567");
    expect(req.body).toBeUndefined();
  });

  it("Zoom list_meetings → GET /users/{userId}/meetings with the type query param", () => {
    const req = buildIntegrationRequest("zoom", "list_meetings", {
      userId: "me",
      type: "upcoming",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/users/me/meetings?type=upcoming");
    expect(req.body).toBeUndefined();
  });

  it("Zoom delete_meeting → DELETE /meetings/{meetingId}, no body", () => {
    const req = buildIntegrationRequest("zoom", "delete_meeting", {
      meetingId: "8391234567",
    });
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/meetings/8391234567");
    expect(req.body).toBeUndefined();
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

  it("rejects an empty-object ({}) json required field", () => {
    expect(
      validateIntegrationConfig({
        provider: "notion",
        action: "create_page",
        connectionId: "n",
        fields: { parent: { database_id: "db" }, properties: {} },
      }),
    ).toMatch(/missing required field 'properties'/);
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
