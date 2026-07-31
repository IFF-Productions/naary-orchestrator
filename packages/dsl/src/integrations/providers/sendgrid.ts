// ── SendGrid (cloud, api.sendgrid.com/v3; auth = a SendGrid API key as a Bearer) ─────
import type { IntegrationProvider } from "../types";

export const SENDGRID: IntegrationProvider = {
  key: "sendgrid",
  label: "SendGrid",
  baseUrl: "https://api.sendgrid.com/v3",
  description:
    "Send email and manage marketing contacts via SendGrid — send mail, upsert contacts, list templates.",
  auth: "A custom connection whose token is a SendGrid API key.",
  actions: [
    {
      key: "send_mail",
      label: "Send mail",
      description: "Send a transactional email via the v3 Mail Send API.",
      method: "POST",
      pathTemplate: "/mail/send",
      write: true,
      fields: [
        {
          key: "personalizations",
          label: "Personalizations (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "array of personalization objects",
        },
        {
          key: "from",
          label: "From (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ email, name? }",
        },
        {
          key: "subject",
          label: "Subject",
          in: "body",
          required: true,
          type: "string",
        },
        {
          key: "content",
          label: "Content (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "array of { type, value }",
        },
      ],
    },
    {
      key: "upsert_contacts",
      label: "Upsert contacts",
      description: "Add or update marketing contacts (async upsert).",
      method: "PUT",
      pathTemplate: "/marketing/contacts",
      write: true,
      fields: [
        {
          key: "contacts",
          label: "Contacts (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "array of contact objects",
        },
      ],
    },
    {
      key: "list_templates",
      label: "List templates",
      description: "List transactional templates.",
      method: "GET",
      pathTemplate: "/templates",
      write: false,
      fields: [
        {
          key: "generations",
          label: "Generations",
          in: "query",
          required: false,
          hint: "legacy|dynamic",
        },
        // SendGrid REQUIRES page_size on this endpoint (1–200) — without it the call is a 400,
        // every time, which is what the catalog shipped (#813). Supplied as a `const` rather than
        // asked of the author for two reasons: nothing else about "list my templates" needs an
        // argument, and this is the action `pickConnectionTestAction` uses to prove a SendGrid
        // token — a required field the user must fill would take SendGrid out of one-click
        // "Test connection" (VERIFICATION.md §2.4) to model an API quirk. 200 is the maximum the
        // spec allows, so one call returns as much as the endpoint can give.
        {
          key: "page_size",
          label: "Page size",
          in: "query",
          required: true,
          type: "number",
          const: 200,
          hint: "fixed at SendGrid's maximum — the API rejects the call without it",
        },
      ],
    },
  ],
};
