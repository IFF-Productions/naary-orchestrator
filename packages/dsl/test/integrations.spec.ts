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

  it("Front add_comment → path conversationId + body/author_id in the JSON body", () => {
    const req = buildIntegrationRequest("front", "add_comment", {
      conversationId: "cnv_123",
      body: "internal note",
      author_id: "tea_1",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/conversations/cnv_123/comments");
    expect(req.body).toEqual({ body: "internal note", author_id: "tea_1" });
  });

  it("Front get_conversation → GET /conversations/{conversationId}, no body", () => {
    const req = buildIntegrationRequest("front", "get_conversation", {
      conversationId: "cnv_123",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/conversations/cnv_123");
    expect(req.body).toBeUndefined();
  });

  it("Sentry update_issue → PUT /issues/{issueId}/ (trailing slash) with { status } body", () => {
    const req = buildIntegrationRequest("sentry", "update_issue", {
      issueId: "1234567890",
      status: "resolved",
    });
    expect(req.method).toBe("PUT");
    expect(req.path).toBe("/issues/1234567890/");
    expect(req.body).toEqual({ status: "resolved" });
  });

  it("Sentry list_issues → GET path with org/project slugs (trailing slash), no body", () => {
    const req = buildIntegrationRequest("sentry", "list_issues", {
      organizationSlug: "acme",
      projectSlug: "backend",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/projects/acme/backend/issues/");
    expect(req.body).toBeUndefined();
  });

  it("Vercel list_deployments → GET with projectId + limit query params", () => {
    const req = buildIntegrationRequest("vercel", "list_deployments", {
      projectId: "prj_abc",
      limit: 20,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v6/deployments?projectId=prj_abc&limit=20");
    expect(req.body).toBeUndefined();
  });

  it("Vercel delete_deployment → DELETE with id in the versioned path", () => {
    const req = buildIntegrationRequest("vercel", "delete_deployment", {
      deploymentId: "dpl_123",
    });
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/v13/deployments/dpl_123");
    expect(req.body).toBeUndefined();
  });

  it("Netlify get_site → GET /sites/{siteId}, no body", () => {
    const req = buildIntegrationRequest("netlify", "get_site", {
      siteId: "my-site-id",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/sites/my-site-id");
    expect(req.body).toBeUndefined();
  });

  it("Netlify get_deploy → GET /sites/{siteId}/deploys/{deployId}, no body", () => {
    const req = buildIntegrationRequest("netlify", "get_deploy", {
      siteId: "my-site-id",
      deployId: "deploy-123",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/sites/my-site-id/deploys/deploy-123");
    expect(req.body).toBeUndefined();
  });

  it("DigitalOcean create_droplet → POST /droplets with name/region/size/image in body", () => {
    const req = buildIntegrationRequest("digitalocean", "create_droplet", {
      name: "web-1",
      region: "nyc3",
      size: "s-1vcpu-1gb",
      image: "ubuntu-22-04-x64",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/droplets");
    expect(req.body).toEqual({
      name: "web-1",
      region: "nyc3",
      size: "s-1vcpu-1gb",
      image: "ubuntu-22-04-x64",
    });
  });

  it("DigitalOcean delete_droplet → DELETE /droplets/{dropletId}, no body", () => {
    const req = buildIntegrationRequest("digitalocean", "delete_droplet", {
      dropletId: "3164444",
    });
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/droplets/3164444");
    expect(req.body).toBeUndefined();
  });

  it("Cloudflare create_dns_record → POST /zones/{zoneId}/dns_records with type/name/content in body", () => {
    const req = buildIntegrationRequest("cloudflare", "create_dns_record", {
      zoneId: "zone123",
      type: "A",
      name: "www.example.com",
      content: "192.0.2.1",
      ttl: 3600,
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/zones/zone123/dns_records");
    expect(req.body).toEqual({
      type: "A",
      name: "www.example.com",
      content: "192.0.2.1",
      ttl: 3600,
    });
  });

  it("Cloudflare delete_dns_record → DELETE with both zoneId and recordId in path, no body", () => {
    const req = buildIntegrationRequest("cloudflare", "delete_dns_record", {
      zoneId: "zone123",
      recordId: "rec456",
    });
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/zones/zone123/dns_records/rec456");
    expect(req.body).toBeUndefined();
  });

  it("PostHog create_annotation → POST, projectId in path, content in body", () => {
    const req = buildIntegrationRequest("posthog", "create_annotation", {
      projectId: "123",
      content: "Deployed v2",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/projects/123/annotations/");
    expect(req.body).toEqual({ content: "Deployed v2" });
  });

  it("PostHog list_persons → GET, projectId in path, search in query", () => {
    const req = buildIntegrationRequest("posthog", "list_persons", {
      projectId: "123",
      search: "jane@acme.com",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/projects/123/persons/?search=jane%40acme.com");
    expect(req.body).toBeUndefined();
  });

  it('Dropbox list_folder → POST /files/list_folder with { path: "" } in the body', () => {
    const req = buildIntegrationRequest("dropbox", "list_folder", {
      path: "",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/files/list_folder");
    expect(req.body).toEqual({ path: "" });
  });

  it("Dropbox create_folder → POST /files/create_folder_v2 with the path in the body", () => {
    const req = buildIntegrationRequest("dropbox", "create_folder", {
      path: "/Docs/2026",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/files/create_folder_v2");
    expect(req.body).toEqual({ path: "/Docs/2026" });
  });

  it("Microsoft Graph send_mail → POST /users/me/sendMail with the message in the body", () => {
    const req = buildIntegrationRequest("msgraph", "send_mail", {
      userId: "me",
      message: {
        subject: "Hello",
        body: { contentType: "Text", content: "Hi there" },
        toRecipients: [{ emailAddress: { address: "a@b.com" } }],
      },
      saveToSentItems: true,
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/users/me/sendMail");
    expect(req.body).toEqual({
      message: {
        subject: "Hello",
        body: { contentType: "Text", content: "Hi there" },
        toRecipients: [{ emailAddress: { address: "a@b.com" } }],
      },
      saveToSentItems: true,
    });
  });

  it("Microsoft Graph list_messages → GET /users/me/messages, no body", () => {
    const req = buildIntegrationRequest("msgraph", "list_messages", {
      userId: "me",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/users/me/messages");
    expect(req.body).toBeUndefined();
  });

  it("Box create_folder → POST /folders with name + parent in the JSON body", () => {
    const req = buildIntegrationRequest("box", "create_folder", {
      name: "Reports",
      parent: { id: "0" },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/folders");
    expect(req.body).toEqual({ name: "Reports", parent: { id: "0" } });
  });

  it("Box list_folder_items → GET /folders/0/items with the optional limit query param", () => {
    const req = buildIntegrationRequest("box", "list_folder_items", {
      folderId: "0",
      limit: 100,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/folders/0/items?limit=100");
    expect(req.body).toBeUndefined();
  });

  it("Stripe create_customer → POST /customers with a flat body", () => {
    const req = buildIntegrationRequest("stripe", "create_customer", {
      email: "jane@example.com",
      name: "Jane Doe",
      description: "VIP",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/customers");
    expect(req.body).toEqual({
      email: "jane@example.com",
      name: "Jane Doe",
      description: "VIP",
    });
  });

  it("Stripe get_customer → GET /customers/{customerId}, no body", () => {
    const req = buildIntegrationRequest("stripe", "get_customer", {
      customerId: "cus_ABC123",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/customers/cus_ABC123");
    expect(req.body).toBeUndefined();
  });

  it("Stripe create_payment_intent → POST /payment_intents, amount/currency in body", () => {
    const req = buildIntegrationRequest("stripe", "create_payment_intent", {
      amount: 1999,
      currency: "usd",
      customer: "cus_ABC123",
      description: "Order #42",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/payment_intents");
    expect(req.body).toEqual({
      amount: 1999,
      currency: "usd",
      customer: "cus_ABC123",
      description: "Order #42",
    });
  });

  it("Stripe list_charges → GET /charges with customer + limit query params", () => {
    const req = buildIntegrationRequest("stripe", "list_charges", {
      customer: "cus_ABC123",
      limit: 5,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/charges?customer=cus_ABC123&limit=5");
    expect(req.body).toBeUndefined();
  });

  it("Stripe create_refund → POST /refunds, omits the optional amount for a full refund", () => {
    const req = buildIntegrationRequest("stripe", "create_refund", {
      charge: "ch_ABC123",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/refunds");
    expect(req.body).toEqual({ charge: "ch_ABC123" });
  });

  it("Shopify create_product → POST /products.json, fields wrapped in the product envelope", () => {
    const req = buildIntegrationRequest("shopify", "create_product", {
      title: "Snowboard",
      bodyHtml: "<p>Fast</p>",
      vendor: "Acme",
      productType: "Boards",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/products.json");
    expect(req.body).toEqual({
      product: {
        title: "Snowboard",
        body_html: "<p>Fast</p>",
        vendor: "Acme",
        product_type: "Boards",
      },
    });
  });

  it("Shopify get_product → GET /products/{productId}.json, no body", () => {
    const req = buildIntegrationRequest("shopify", "get_product", {
      productId: "788032119674292922",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/products/788032119674292922.json");
    expect(req.body).toBeUndefined();
  });

  it("Shopify list_products → GET /products.json with limit + vendor query params", () => {
    const req = buildIntegrationRequest("shopify", "list_products", {
      limit: 10,
      vendor: "Acme",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/products.json?limit=10&vendor=Acme");
    expect(req.body).toBeUndefined();
    // …and with no filters, no query string is appended.
    expect(buildIntegrationRequest("shopify", "list_products", {}).path).toBe(
      "/products.json",
    );
  });

  it("Shopify update_product → PUT, id in path, fields nested under product", () => {
    const req = buildIntegrationRequest("shopify", "update_product", {
      productId: "632910392",
      title: "Renamed",
      vendor: "NewCo",
    });
    expect(req.method).toBe("PUT");
    expect(req.path).toBe("/products/632910392.json");
    expect(req.body).toEqual({
      product: { title: "Renamed", vendor: "NewCo" },
    });
  });

  it("Shopify create_order → POST /orders.json, line_items/email nested under order", () => {
    const req = buildIntegrationRequest("shopify", "create_order", {
      lineItems: [{ variant_id: 447654529, quantity: 1 }],
      email: "buyer@example.com",
      financialStatus: "paid",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/orders.json");
    expect(req.body).toEqual({
      order: {
        line_items: [{ variant_id: 447654529, quantity: 1 }],
        email: "buyer@example.com",
        financial_status: "paid",
      },
    });
  });

  it("Twilio send_sms → POST /Accounts/{accountSid}/Messages.json with To/From/Body body", () => {
    const req = buildIntegrationRequest("twilio", "send_sms", {
      accountSid: "AC123",
      To: "+15558675310",
      From: "+15017122661",
      Body: "Hello from Naary",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/Accounts/AC123/Messages.json");
    expect(req.body).toEqual({
      To: "+15558675310",
      From: "+15017122661",
      Body: "Hello from Naary",
    });
  });

  it("Twilio get_message → GET, accountSid + messageSid in path, no body", () => {
    const req = buildIntegrationRequest("twilio", "get_message", {
      accountSid: "AC123",
      messageSid: "SM456",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/Accounts/AC123/Messages/SM456.json");
    expect(req.body).toBeUndefined();
  });

  it("Twilio list_messages → GET with To/From/PageSize query params (order preserved)", () => {
    const req = buildIntegrationRequest("twilio", "list_messages", {
      accountSid: "AC123",
      To: "+15558675310",
      From: "+15017122661",
      PageSize: 20,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe(
      "/Accounts/AC123/Messages.json?To=%2B15558675310&From=%2B15017122661&PageSize=20",
    );
    expect(req.body).toBeUndefined();
    // …and with only the required path field, no query string is appended.
    expect(
      buildIntegrationRequest("twilio", "list_messages", {
        accountSid: "AC123",
      }).path,
    ).toBe("/Accounts/AC123/Messages.json");
  });

  it("Twilio make_call → POST /Accounts/{accountSid}/Calls.json with To/From/Url body", () => {
    const req = buildIntegrationRequest("twilio", "make_call", {
      accountSid: "AC123",
      To: "+15558675310",
      From: "+15017122661",
      Url: "https://example.com/twiml.xml",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/Accounts/AC123/Calls.json");
    expect(req.body).toEqual({
      To: "+15558675310",
      From: "+15017122661",
      Url: "https://example.com/twiml.xml",
    });
  });

  it("Mailchimp add_member → POST /lists/{listId}/members with email/status/merge_fields body", () => {
    const req = buildIntegrationRequest("mailchimp", "add_member", {
      listId: "abc123",
      email_address: "ada@example.com",
      status: "subscribed",
      merge_fields: { FNAME: "Ada", LNAME: "Lovelace" },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/lists/abc123/members");
    expect(req.body).toEqual({
      email_address: "ada@example.com",
      status: "subscribed",
      merge_fields: { FNAME: "Ada", LNAME: "Lovelace" },
    });
  });

  it("Mailchimp add_member → drops an empty ({}) merge_fields", () => {
    const req = buildIntegrationRequest("mailchimp", "add_member", {
      listId: "abc123",
      email_address: "ada@example.com",
      status: "subscribed",
      merge_fields: {},
    });
    expect(req.body).toEqual({
      email_address: "ada@example.com",
      status: "subscribed",
    });
  });

  it("Mailchimp get_member → GET, listId + subscriberHash in path, no body", () => {
    const req = buildIntegrationRequest("mailchimp", "get_member", {
      listId: "abc123",
      subscriberHash: "62eeb292278cc15f5817cb78f7790b08",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe(
      "/lists/abc123/members/62eeb292278cc15f5817cb78f7790b08",
    );
    expect(req.body).toBeUndefined();
  });

  it("Mailchimp update_member → PATCH path + status/merge_fields in body", () => {
    const req = buildIntegrationRequest("mailchimp", "update_member", {
      listId: "abc123",
      subscriberHash: "62eeb292278cc15f5817cb78f7790b08",
      status: "unsubscribed",
      merge_fields: { FNAME: "Ada" },
    });
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe(
      "/lists/abc123/members/62eeb292278cc15f5817cb78f7790b08",
    );
    expect(req.body).toEqual({
      status: "unsubscribed",
      merge_fields: { FNAME: "Ada" },
    });
  });

  it("Mailchimp list_members → GET /lists/{listId}/members with status/count query params", () => {
    const req = buildIntegrationRequest("mailchimp", "list_members", {
      listId: "abc123",
      status: "subscribed",
      count: 50,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/lists/abc123/members?status=subscribed&count=50");
    expect(req.body).toBeUndefined();
    // …and with no filters, no query string is appended.
    expect(
      buildIntegrationRequest("mailchimp", "list_members", {
        listId: "abc123",
      }).path,
    ).toBe("/lists/abc123/members");
  });

  it("Mailchimp create_campaign → POST /campaigns with type/recipients/settings body", () => {
    const req = buildIntegrationRequest("mailchimp", "create_campaign", {
      type: "regular",
      recipients: { list_id: "abc123" },
      settings: { subject_line: "Hello", from_name: "Naary" },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/campaigns");
    expect(req.body).toEqual({
      type: "regular",
      recipients: { list_id: "abc123" },
      settings: { subject_line: "Hello", from_name: "Naary" },
    });
  });

  it("Discord send_message → POST /channels/{channelId}/messages with content/tts/embeds body", () => {
    const req = buildIntegrationRequest("discord", "send_message", {
      channelId: "123456789",
      content: "Deploy finished ✅",
      tts: false,
      embeds: [{ title: "Build", description: "green" }],
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/channels/123456789/messages");
    expect(req.body).toEqual({
      content: "Deploy finished ✅",
      tts: false,
      embeds: [{ title: "Build", description: "green" }],
    });
  });

  it("Discord send_message → omits optional tts/embeds when not supplied", () => {
    const req = buildIntegrationRequest("discord", "send_message", {
      channelId: "123456789",
      content: "hi",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/channels/123456789/messages");
    expect(req.body).toEqual({ content: "hi" });
  });

  it("Discord get_channel → GET /channels/{channelId}, no body", () => {
    const req = buildIntegrationRequest("discord", "get_channel", {
      channelId: "123456789",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/channels/123456789");
    expect(req.body).toBeUndefined();
  });

  it("Discord list_messages → GET with limit/before/after query params (order preserved)", () => {
    const req = buildIntegrationRequest("discord", "list_messages", {
      channelId: "123456789",
      limit: 50,
      before: "999",
      after: "100",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe(
      "/channels/123456789/messages?limit=50&before=999&after=100",
    );
    expect(req.body).toBeUndefined();
    // …and with no query params, no query string is appended.
    expect(
      buildIntegrationRequest("discord", "list_messages", {
        channelId: "123456789",
      }).path,
    ).toBe("/channels/123456789/messages");
  });

  it("Discord create_dm → POST /users/@me/channels with { recipient_id } body", () => {
    const req = buildIntegrationRequest("discord", "create_dm", {
      recipient_id: "987654321",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/users/@me/channels");
    expect(req.body).toEqual({ recipient_id: "987654321" });
  });

  it("Discord add_reaction → PUT with channel/message/emoji in path (emoji URL-encoded)", () => {
    const req = buildIntegrationRequest("discord", "add_reaction", {
      channelId: "123456789",
      messageId: "555",
      emoji: "👍",
    });
    expect(req.method).toBe("PUT");
    expect(req.path).toBe(
      "/channels/123456789/messages/555/reactions/%F0%9F%91%8D/@me",
    );
    expect(req.body).toBeUndefined();
  });

  it("Linear create_issue → POST /graphql with { query, variables } body", () => {
    const query =
      "mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }";
    const req = buildIntegrationRequest("linear", "create_issue", {
      query,
      variables: { input: { title: "It broke", teamId: "team-1" } },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/graphql");
    expect(req.body).toEqual({
      query,
      variables: { input: { title: "It broke", teamId: "team-1" } },
    });
    expect(typeof (req.body as { query: unknown }).query).toBe("string");
  });

  it("Linear get_issue → POST /graphql, id passed through variables", () => {
    const query = "query ($id: String!) { issue(id: $id) { id title } }";
    const req = buildIntegrationRequest("linear", "get_issue", {
      query,
      variables: { id: "issue-123" },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/graphql");
    expect(req.body).toEqual({ query, variables: { id: "issue-123" } });
  });

  it("Linear list_issues → POST /graphql; optional variables omitted leaves only { query }", () => {
    const query = "query { issues { nodes { id title } } }";
    const req = buildIntegrationRequest("linear", "list_issues", { query });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/graphql");
    // variables is optional here; an unset/empty one stays out of the body.
    expect(req.body).toEqual({ query });
  });

  it("Linear create_comment → POST /graphql, write mutation with variables", () => {
    const query =
      "mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }";
    const req = buildIntegrationRequest("linear", "create_comment", {
      query,
      variables: { input: { issueId: "issue-123", body: "triaged" } },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/graphql");
    expect(req.body).toEqual({
      query,
      variables: { input: { issueId: "issue-123", body: "triaged" } },
    });
  });

  it("Linear update_issue → POST /graphql, id + input in variables", () => {
    const query =
      "mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }";
    const req = buildIntegrationRequest("linear", "update_issue", {
      query,
      variables: { id: "issue-123", input: { title: "Renamed" } },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/graphql");
    expect(req.body).toEqual({
      query,
      variables: { id: "issue-123", input: { title: "Renamed" } },
    });
  });

  it("ClickUp create_task → POST /list/{listId}/task with a JSON body", () => {
    const req = buildIntegrationRequest("clickup", "create_task", {
      listId: "901",
      name: "Ship it",
      description: "the details",
      assignees: ["u1", "u2"],
      priority: 2,
      due_date: 1700000000000,
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/list/901/task");
    expect(req.body).toEqual({
      name: "Ship it",
      description: "the details",
      assignees: ["u1", "u2"],
      priority: 2,
      due_date: 1700000000000,
    });
  });

  it("ClickUp create_task → omits blank optionals, keeps the required name", () => {
    const req = buildIntegrationRequest("clickup", "create_task", {
      listId: "901",
      name: "Just a name",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/list/901/task");
    expect(req.body).toEqual({ name: "Just a name" });
  });

  it("ClickUp get_task → GET /task/{taskId}, no body", () => {
    const req = buildIntegrationRequest("clickup", "get_task", {
      taskId: "abc123",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/task/abc123");
    expect(req.body).toBeUndefined();
  });

  it("ClickUp update_task → PUT /task/{taskId} with name/status/priority in body", () => {
    const req = buildIntegrationRequest("clickup", "update_task", {
      taskId: "abc123",
      name: "Renamed",
      status: "in progress",
      priority: 1,
    });
    expect(req.method).toBe("PUT");
    expect(req.path).toBe("/task/abc123");
    expect(req.body).toEqual({
      name: "Renamed",
      status: "in progress",
      priority: 1,
    });
  });

  it("ClickUp list_tasks → GET with archived/page query params (verbatim names)", () => {
    const req = buildIntegrationRequest("clickup", "list_tasks", {
      listId: "901",
      archived: "false",
      page: 0,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/list/901/task?archived=false&page=0");
    expect(req.body).toBeUndefined();
  });

  it("ClickUp create_comment → POST /task/{taskId}/comment with comment_text in body", () => {
    const req = buildIntegrationRequest("clickup", "create_comment", {
      taskId: "abc123",
      comment_text: "looks good",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/task/abc123/comment");
    expect(req.body).toEqual({ comment_text: "looks good" });
  });

  it("Monday create_item → POST /v2 with a GraphQL query + variables in the body", () => {
    const req = buildIntegrationRequest("monday", "create_item", {
      query:
        "mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON) { create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id } }",
      variables: {
        boardId: "123",
        itemName: "New task",
        columnValues: { status: { label: "Working on it" } },
      },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v2");
    expect(typeof req.body?.query).toBe("string");
    expect(req.body).toEqual({
      query:
        "mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON) { create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id } }",
      variables: {
        boardId: "123",
        itemName: "New task",
        columnValues: { status: { label: "Working on it" } },
      },
    });
  });

  it("Monday get_item → POST /v2, GraphQL query + { itemId } variables", () => {
    const req = buildIntegrationRequest("monday", "get_item", {
      query:
        "query ($itemId: [ID!]) { items(ids: $itemId) { id name column_values { id text } } }",
      variables: { itemId: ["456"] },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v2");
    expect(typeof req.body?.query).toBe("string");
    expect(req.body?.variables).toEqual({ itemId: ["456"] });
  });

  it("Monday list_items → POST /v2, optional variables omitted when empty", () => {
    const req = buildIntegrationRequest("monday", "list_items", {
      query:
        "query ($boardId: [ID!]) { boards(ids: $boardId) { items_page { items { id name } } } }",
      // variables omitted — an optional empty json must stay out of the body
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v2");
    expect(typeof req.body?.query).toBe("string");
    expect(req.body?.variables).toBeUndefined();
  });

  it("Monday create_update → POST /v2 mutation posting an update on an item", () => {
    const req = buildIntegrationRequest("monday", "create_update", {
      query:
        "mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }",
      variables: { itemId: "789", body: "Looks good to me" },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v2");
    expect(typeof req.body?.query).toBe("string");
    expect(req.body).toEqual({
      query:
        "mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }",
      variables: { itemId: "789", body: "Looks good to me" },
    });
  });

  it("Monday change_column_value → POST /v2 mutation with column variables", () => {
    const req = buildIntegrationRequest("monday", "change_column_value", {
      query:
        "mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) { change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id } }",
      variables: {
        boardId: "123",
        itemId: "789",
        columnId: "status",
        value: JSON.stringify({ label: "Done" }),
      },
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v2");
    expect(typeof req.body?.query).toBe("string");
    expect(req.body?.variables).toMatchObject({ columnId: "status" });
  });

  it("Pipedrive create_deal → POST /deals with title/value/currency/person_id/org_id in body", () => {
    const req = buildIntegrationRequest("pipedrive", "create_deal", {
      title: "Acme renewal",
      value: 5000,
      currency: "USD",
      person_id: 42,
      org_id: 7,
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/deals");
    expect(req.body).toEqual({
      title: "Acme renewal",
      value: 5000,
      currency: "USD",
      person_id: 42,
      org_id: 7,
    });
  });

  it("Pipedrive get_deal → GET /deals/{dealId}, no body", () => {
    const req = buildIntegrationRequest("pipedrive", "get_deal", {
      dealId: "123",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/deals/123");
    expect(req.body).toBeUndefined();
  });

  it("Pipedrive update_deal → PUT path id substituted, title/value/status in body", () => {
    const req = buildIntegrationRequest("pipedrive", "update_deal", {
      dealId: "123",
      title: "Acme renewal (updated)",
      value: 6000,
      status: "won",
    });
    expect(req.method).toBe("PUT");
    expect(req.path).toBe("/deals/123");
    expect(req.body).toEqual({
      title: "Acme renewal (updated)",
      value: 6000,
      status: "won",
    });
  });

  it("Pipedrive create_person → POST /persons with name + email array + phone in body", () => {
    const req = buildIntegrationRequest("pipedrive", "create_person", {
      name: "Ada Lovelace",
      email: ["ada@example.com"],
      phone: "+15551234567",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/persons");
    expect(req.body).toEqual({
      name: "Ada Lovelace",
      email: ["ada@example.com"],
      phone: "+15551234567",
    });
  });

  it("Pipedrive list_deals → GET /deals with status/limit/start query params", () => {
    const req = buildIntegrationRequest("pipedrive", "list_deals", {
      status: "open",
      limit: 50,
      start: 0,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/deals?status=open&limit=50&start=0");
    expect(req.body).toBeUndefined();
    // …and with no filters, no query string is appended.
    expect(buildIntegrationRequest("pipedrive", "list_deals", {}).path).toBe(
      "/deals",
    );
  });

  it("Zendesk create_ticket → POST /tickets.json, body wrapped under the ticket key", () => {
    const req = buildIntegrationRequest("zendesk", "create_ticket", {
      subject: "Printer is on fire",
      comment: { body: "smoke everywhere" },
      priority: "urgent",
      type: "incident",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/tickets.json");
    expect(req.body).toEqual({
      ticket: {
        subject: "Printer is on fire",
        comment: { body: "smoke everywhere" },
        priority: "urgent",
        type: "incident",
      },
    });
  });

  it("Zendesk get_ticket → GET /tickets/{ticketId}.json, no body", () => {
    const req = buildIntegrationRequest("zendesk", "get_ticket", {
      ticketId: 42,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/tickets/42.json");
    expect(req.body).toBeUndefined();
  });

  it("Zendesk update_ticket → PUT path id substituted, status/comment under ticket", () => {
    const req = buildIntegrationRequest("zendesk", "update_ticket", {
      ticketId: 42,
      status: "solved",
      comment: { body: "fixed", public: false },
    });
    expect(req.method).toBe("PUT");
    expect(req.path).toBe("/tickets/42.json");
    expect(req.body).toEqual({
      ticket: { status: "solved", comment: { body: "fixed", public: false } },
    });
  });

  it("Zendesk list_tickets → GET /tickets.json with page/per_page query params", () => {
    const req = buildIntegrationRequest("zendesk", "list_tickets", {
      page: 2,
      per_page: 50,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/tickets.json?page=2&per_page=50");
    expect(req.body).toBeUndefined();
    // …and when omitted, no query string is appended.
    expect(buildIntegrationRequest("zendesk", "list_tickets", {}).path).toBe(
      "/tickets.json",
    );
  });

  it("Zendesk create_user → POST /users.json, name/email wrapped under the user key", () => {
    const req = buildIntegrationRequest("zendesk", "create_user", {
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/users.json");
    expect(req.body).toEqual({
      user: { name: "Ada Lovelace", email: "ada@example.com" },
    });
  });

  /* ── batch 4: Mattermost · PagerDuty · Google Sheets · DeepL ── */

  it("Mattermost send_message → POST /api/v4/posts with channel_id + message (root_id only when set)", () => {
    const req = buildIntegrationRequest("mattermost", "send_message", {
      channel_id: "cccccccccccccccccccccccccc",
      message: "deploy finished",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v4/posts");
    expect(req.body).toEqual({
      channel_id: "cccccccccccccccccccccccccc",
      message: "deploy finished",
    });
    // A thread reply adds root_id.
    expect(
      buildIntegrationRequest("mattermost", "send_message", {
        channel_id: "c1",
        message: "…and it passed",
        root_id: "p1",
      }).body,
    ).toEqual({ channel_id: "c1", message: "…and it passed", root_id: "p1" });
  });

  it("Mattermost get_channel_by_name → GET the team/channel name path", () => {
    const req = buildIntegrationRequest("mattermost", "get_channel_by_name", {
      teamName: "acme",
      channelName: "town-square",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/v4/teams/name/acme/channels/name/town-square");
    expect(req.body).toBeUndefined();
  });

  it("Mattermost list_channel_posts → GET channel posts with paging", () => {
    const req = buildIntegrationRequest("mattermost", "list_channel_posts", {
      channelId: "c1",
      per_page: 20,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/v4/channels/c1/posts?per_page=20");
  });

  it("Mattermost add_reaction → POST /api/v4/reactions with the emoji triple", () => {
    const req = buildIntegrationRequest("mattermost", "add_reaction", {
      user_id: "u1",
      post_id: "p1",
      emoji_name: "white_check_mark",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v4/reactions");
    expect(req.body).toEqual({
      user_id: "u1",
      post_id: "p1",
      emoji_name: "white_check_mark",
    });
  });

  it("PagerDuty create_incident → POST /incidents, const type discriminators injected, From as a HEADER", () => {
    const req = buildIntegrationRequest("pagerduty", "create_incident", {
      From: "oncall@acme.com",
      title: "Checkout is down",
      serviceId: "PW7YESS",
      urgency: "high",
      details: "5xx rate above 20%",
      // A configured value must NOT be able to override a const field.
      type: "not-an-incident",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/incidents");
    expect(req.body).toEqual({
      incident: {
        type: "incident",
        title: "Checkout is down",
        service: { id: "PW7YESS", type: "service_reference" },
        urgency: "high",
        body: { type: "incident_body", details: "5xx rate above 20%" },
      },
    });
    // `From` is a request HEADER, never part of the body/path.
    expect(req.headers).toEqual({ From: "oncall@acme.com" });
  });

  it("PagerDuty create_incident → omitting From leaves the header off entirely", () => {
    const req = buildIntegrationRequest("pagerduty", "create_incident", {
      title: "Latency spike",
      serviceId: "PSVC",
    });
    expect(req.headers).toBeUndefined();
    // No `details` → no `incident.body` at all: a nested const must not conjure a sub-object
    // that exists only to hold its own type tag.
    expect(req.body).toEqual({
      incident: {
        type: "incident",
        title: "Latency spike",
        service: { id: "PSVC", type: "service_reference" },
      },
    });
  });

  it("PagerDuty create_incident → the nested body const appears only WITH details", () => {
    const withDetails = buildIntegrationRequest(
      "pagerduty",
      "create_incident",
      {
        title: "Latency spike",
        serviceId: "PSVC",
        details: "p99 over 4s",
      },
    );
    expect(withDetails.body).toEqual({
      incident: {
        type: "incident",
        title: "Latency spike",
        service: { id: "PSVC", type: "service_reference" },
        body: { type: "incident_body", details: "p99 over 4s" },
      },
    });
  });

  it("PagerDuty resolve_incident → PUT /incidents/{id} with the incident_reference + resolved consts", () => {
    const req = buildIntegrationRequest("pagerduty", "resolve_incident", {
      From: "oncall@acme.com",
      id: "PT4KHLK",
      resolution: "rolled back",
    });
    expect(req.method).toBe("PUT");
    expect(req.path).toBe("/incidents/PT4KHLK");
    expect(req.body).toEqual({
      incident: {
        type: "incident_reference",
        status: "resolved",
        resolution: "rolled back",
      },
    });
    expect(req.headers).toEqual({ From: "oncall@acme.com" });
  });

  it("PagerDuty acknowledge_incident → same endpoint, status const 'acknowledged'", () => {
    const req = buildIntegrationRequest("pagerduty", "acknowledge_incident", {
      id: "PT4KHLK",
    });
    expect(req.method).toBe("PUT");
    expect(req.body).toEqual({
      incident: { type: "incident_reference", status: "acknowledged" },
    });
  });

  it("PagerDuty add_note → POST /incidents/{id}/notes with note.content", () => {
    const req = buildIntegrationRequest("pagerduty", "add_note", {
      From: "oncall@acme.com",
      id: "PT4KHLK",
      content: "paging the DB team",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/incidents/PT4KHLK/notes");
    expect(req.body).toEqual({ note: { content: "paging the DB team" } });
  });

  it("PagerDuty list_incidents → GET /incidents with the status/service filters", () => {
    const req = buildIntegrationRequest("pagerduty", "list_incidents", {
      "statuses[]": "triggered",
      limit: 25,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/incidents?statuses%5B%5D=triggered&limit=25");
    // …and with no filters there's no query string at all.
    expect(
      buildIntegrationRequest("pagerduty", "list_incidents", {}).path,
    ).toBe("/incidents");
  });

  it("PagerDuty rejects a CR/LF in a header field (a bound value must not inject headers)", () => {
    expect(() =>
      buildIntegrationRequest("pagerduty", "create_incident", {
        From: "oncall@acme.com\r\nX-Injected: 1",
        title: "t",
        serviceId: "s",
      }),
    ).toThrow(/header field 'From' contains a newline/);
  });

  it("a header field's value is TRIMMED (trailing whitespace from a binding is not a failure)", () => {
    const req = buildIntegrationRequest("pagerduty", "add_note", {
      From: "  oncall@acme.com\n",
      id: "PT4KHLK",
      content: "noted",
    });
    expect(req.headers).toEqual({ From: "oncall@acme.com" });
    // …and a whitespace-only value carries nothing, so no header is sent.
    expect(
      buildIntegrationRequest("pagerduty", "add_note", {
        From: "   ",
        id: "PT4KHLK",
        content: "noted",
      }).headers,
    ).toBeUndefined();
  });

  it("Google Sheets append_row → POST …/values/{range}:append with valueInputOption + rows", () => {
    const req = buildIntegrationRequest("googlesheets", "append_row", {
      spreadsheetId: "1AbC",
      range: "Sheet1!A1",
      valueInputOption: "USER_ENTERED",
      values: [["Ada", "ada@acme.com"]],
    });
    expect(req.method).toBe("POST");
    // The range is A1 notation, so it's percent-encoded into the path segment.
    expect(req.path).toBe(
      "/v4/spreadsheets/1AbC/values/Sheet1!A1:append?valueInputOption=USER_ENTERED",
    );
    expect(req.body).toEqual({ values: [["Ada", "ada@acme.com"]] });
  });

  it("Google Sheets get_values → GET the range, with the render options as query params", () => {
    const req = buildIntegrationRequest("googlesheets", "get_values", {
      spreadsheetId: "1AbC",
      range: "Sheet1!A1:D20",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe(
      "/v4/spreadsheets/1AbC/values/Sheet1!A1%3AD20?valueRenderOption=UNFORMATTED_VALUE",
    );
    expect(req.body).toBeUndefined();
  });

  it("Google Sheets update_values → PUT with valueInputOption; clear_values sends no body", () => {
    const put = buildIntegrationRequest("googlesheets", "update_values", {
      spreadsheetId: "1AbC",
      range: "Sheet1!A2:B2",
      valueInputOption: "RAW",
      values: [["done", 42]],
    });
    expect(put.method).toBe("PUT");
    expect(put.path).toBe(
      "/v4/spreadsheets/1AbC/values/Sheet1!A2%3AB2?valueInputOption=RAW",
    );
    expect(put.body).toEqual({ values: [["done", 42]] });

    const clear = buildIntegrationRequest("googlesheets", "clear_values", {
      spreadsheetId: "1AbC",
      range: "Sheet1!A1:D20",
    });
    expect(clear.method).toBe("POST");
    expect(clear.path).toBe(
      "/v4/spreadsheets/1AbC/values/Sheet1!A1%3AD20:clear",
    );
    expect(clear.body).toBeUndefined();
  });

  it("DeepL translate_text → POST /v2/translate with a text ARRAY + target_lang", () => {
    const req = buildIntegrationRequest("deepl", "translate_text", {
      text: ["Hello world!"],
      target_lang: "DE",
      formality: "more",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v2/translate");
    expect(req.body).toEqual({
      text: ["Hello world!"],
      target_lang: "DE",
      formality: "more",
    });
  });

  it("DeepL get_usage / list_languages → plain GETs, no body", () => {
    const usage = buildIntegrationRequest("deepl", "get_usage", {});
    expect(usage.method).toBe("GET");
    expect(usage.path).toBe("/v2/usage");
    expect(usage.body).toBeUndefined();
    expect(
      buildIntegrationRequest("deepl", "list_languages", { type: "target" })
        .path,
    ).toBe("/v2/languages?type=target");
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

  it("never asks for a const field — the catalog supplies it", () => {
    // PagerDuty create_incident declares required const fields (incident.type,
    // service.type, body.type); a config with only the USER-facing fields must pass.
    expect(
      validateIntegrationConfig({
        provider: "pagerduty",
        action: "create_incident",
        connectionId: "pd",
        fields: { title: "Checkout is down", serviceId: "PW7YESS" },
      }),
    ).toBeNull();
    // …but a genuinely missing user field is still caught.
    expect(
      validateIntegrationConfig({
        provider: "pagerduty",
        action: "create_incident",
        connectionId: "pd",
        fields: { title: "Checkout is down" },
      }),
    ).toMatch(/missing required field 'serviceId'/);
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

describe("buildIntegrationRequest — an empty path value never becomes a URL", () => {
  it("throws instead of collapsing the segment", () => {
    // Reported from a real run: `PUT /incidents/` reached PagerDuty and came back
    // "400 Bad Request", which names neither the field nor the node. We knew the request was
    // malformed before sending it.
    expect(() =>
      buildIntegrationRequest("pagerduty", "acknowledge_incident", {
        id: "",
        From: "oncall@example.com",
      }),
    ).toThrow(/path field 'id' is empty/);
  });

  it("names the binding as the thing to check", () => {
    // Save-time validation accepts a field as supplied when a BINDING exists for it, so this
    // failure mode is reachable ONLY through a binding that resolved to nothing — which is
    // where the author has to look.
    expect(() =>
      buildIntegrationRequest("pagerduty", "acknowledge_incident", { id: "" }),
    ).toThrow(/binding/);
  });

  it("treats undefined and null the same as empty", () => {
    for (const id of [undefined, null]) {
      expect(() =>
        buildIntegrationRequest("pagerduty", "acknowledge_incident", { id }),
      ).toThrow(/path field 'id' is empty/);
    }
  });

  it("still builds the request when the path field IS supplied", () => {
    // The guard must not fire on the happy path.
    const req = buildIntegrationRequest("pagerduty", "acknowledge_incident", {
      id: "PT4KHLK",
    });
    expect(req.path).toBe("/incidents/PT4KHLK");
  });
});

// ---------------------------------------------------------------------------
// An UNFINISHED binding row (no `from`) must not blank a typed-in value. Three
// places disagreed about what counts as bound: both resolvers and the save gate
// took any key in the map, the canvas panel required a non-empty `from`. So a
// value could pass the gate, render as an ordinary manual field, and arrive
// empty — "I'm setting the ID manually and it's still not picked up".
// ---------------------------------------------------------------------------
describe("bindings that name no source", () => {
  const cfg = (fieldBindings: Record<string, unknown>) => ({
    provider: "pagerduty",
    action: "acknowledge_incident",
    connectionId: "c1",
    fields: { id: "PINC123", From: "me@example.com" },
    fieldBindings,
  });

  it("keeps the static value when the binding has no `from`", () => {
    const out = resolveIntegrationFields(
      cfg({ id: { path: "incident.id" } }) as never,
      { upstream: { incident: { id: "FROM_UPSTREAM" } } },
    );
    expect(out.id).toBe("PINC123");
  });

  it("keeps it for a blank/whitespace `from` too — an editor leaves those behind", () => {
    for (const from of ["", "   "]) {
      const out = resolveIntegrationFields(cfg({ id: { from, path: "x" } }) as never, {});
      expect(out.id).toBe("PINC123");
    }
  });

  it("a COMPLETE binding still wins over the static value — that's the feature", () => {
    const out = resolveIntegrationFields(
      cfg({ id: { from: "upstream", path: "incident.id" } }) as never,
      { upstream: { incident: { id: "FROM_UPSTREAM" } } },
    );
    expect(out.id).toBe("FROM_UPSTREAM");
  });

  it("a complete binding resolving to nothing still blanks it — the run must fail, not send a stale id", () => {
    const out = resolveIntegrationFields(
      cfg({ id: { from: "upstream", path: "nope.missing" } }) as never,
      { upstream: {} },
    );
    expect(out.id).toBeUndefined();
  });

  it("the save gate no longer accepts an unfinished row as supplying a required field", () => {
    const err = validateIntegrationConfig({
      provider: "pagerduty",
      action: "acknowledge_incident",
      connectionId: "c1",
      fields: {},
      fieldBindings: { id: { path: "incident.id" } },
    } as never);
    expect(err).toMatch(/missing required field 'id'/);
  });

  it("…and still accepts a complete one (no static value needed)", () => {
    expect(
      validateIntegrationConfig({
        provider: "pagerduty",
        action: "acknowledge_incident",
        connectionId: "c1",
        fields: {},
        fieldBindings: { id: { from: "upstream", path: "incident.id" } },
      } as never),
    ).toBeNull();
  });
});
