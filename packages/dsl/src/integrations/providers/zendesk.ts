// ── Zendesk Support (base = the CONNECTION's serverUrl, i.e. your account's /api/v2; auth
//    = HTTP Basic with the token stored as `email/token:api-token`) ────────────────────
import type { IntegrationProvider } from "../types";

export const ZENDESK: IntegrationProvider = {
  key: "zendesk",
  label: "Zendesk",
  baseUrlFromConnection: true,
  authScheme: "basic",
  description:
    "Manage Zendesk Support — read, create, and update tickets; create users.",
  auth: "A Zendesk connection whose Server URL is your account API base (https://your-subdomain.zendesk.com/api/v2) and whose token is `your-email@company.com/token:your-api-token` (sent as HTTP Basic).",
  credentialSetup: {
    steps: [
      "In Admin Center → Apps and integrations → APIs → API configuration, tick Allow API token access and save. You must be an administrator, and it is off by default.",
      "Then open APIs → API tokens → Add API token and copy the token.",
    ],
    // The literal `/token` between email and secret is the usual cause of a 401 here, and no
    // generated sentence could know it.
    tokenFormat:
      "Paste `your-email@company.com/token:your-api-token` — the literal `/token` between your email and the token is what makes this token auth rather than password auth. Naary sends it as HTTP Basic.",
  },

  actions: [
    {
      key: "get_ticket",
      label: "Get ticket",
      description: "Fetch a single ticket by id.",
      method: "GET",
      pathTemplate: "/tickets/{ticketId}.json",
      write: false,
      fields: [
        {
          key: "ticketId",
          label: "Ticket id",
          in: "path",
          required: true,
          type: "number",
        },
      ],
    },
    {
      key: "list_tickets",
      label: "List tickets",
      description: "List tickets, with optional paging.",
      method: "GET",
      pathTemplate: "/tickets.json",
      write: false,
      fields: [
        {
          key: "page",
          label: "Page",
          in: "query",
          required: false,
          type: "number",
        },
        {
          key: "per_page",
          label: "Per page",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "create_ticket",
      label: "Create ticket",
      description: "Open a new ticket.",
      method: "POST",
      pathTemplate: "/tickets.json",
      write: true,
      fields: [
        {
          key: "subject",
          label: "Subject",
          in: "body",
          required: true,
          bodyPath: "ticket.subject",
        },
        {
          key: "comment",
          label: "Comment (JSON)",
          in: "body",
          required: false,
          type: "json",
          bodyPath: "ticket.comment",
          hint: "e.g. { body: 'first message' }",
        },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          bodyPath: "ticket.priority",
          hint: "urgent | high | normal | low",
        },
        {
          key: "type",
          label: "Type",
          in: "body",
          required: false,
          bodyPath: "ticket.type",
          hint: "problem | incident | question | task",
        },
      ],
    },
    {
      key: "update_ticket",
      label: "Update ticket",
      description: "Update a ticket's status, priority, or add a comment.",
      method: "PUT",
      pathTemplate: "/tickets/{ticketId}.json",
      write: true,
      fields: [
        {
          key: "ticketId",
          label: "Ticket id",
          in: "path",
          required: true,
          type: "number",
        },
        {
          key: "status",
          label: "Status",
          in: "body",
          required: false,
          bodyPath: "ticket.status",
          hint: "new | open | pending | hold | solved | closed",
        },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          bodyPath: "ticket.priority",
          hint: "urgent | high | normal | low",
        },
        {
          key: "comment",
          label: "Comment (JSON)",
          in: "body",
          required: false,
          type: "json",
          bodyPath: "ticket.comment",
          hint: "e.g. { body: 'update', public: false }",
        },
      ],
    },
    {
      key: "create_user",
      label: "Create user",
      description: "Create a new end user or agent.",
      method: "POST",
      pathTemplate: "/users.json",
      write: true,
      fields: [
        {
          key: "name",
          label: "Name",
          in: "body",
          required: true,
          bodyPath: "user.name",
        },
        {
          key: "email",
          label: "Email",
          in: "body",
          required: true,
          bodyPath: "user.email",
        },
      ],
    },
  ],
};
