// ── Intercom (cloud, api.intercom.io, pinned to API version 2.11 via a static header;
//    auth = an access token as a Bearer. `get_me` is the credential probe) ─────────────
import type { IntegrationProvider } from "../types";

export const INTERCOM: IntegrationProvider = {
  key: "intercom",
  label: "Intercom",
  baseUrl: "https://api.intercom.io",
  authScheme: "bearer",
  headers: { "Intercom-Version": "2.11" },
  description:
    "Work with Intercom — read/create contacts, add a note, send a message.",
  auth: "A custom connection whose token is an Intercom access token.",
  actions: [
    {
      key: "get_contact",
      label: "Get contact",
      description: "Fetch a single contact by id.",
      method: "GET",
      pathTemplate: "/contacts/{contactId}",
      write: false,
      fields: [
        { key: "contactId", label: "Contact id", in: "path", required: true },
      ],
    },
    {
      key: "create_contact",
      label: "Create contact",
      description: "Create a new contact (user or lead).",
      method: "POST",
      pathTemplate: "/contacts",
      write: true,
      fields: [
        {
          key: "role",
          label: "Role",
          in: "body",
          required: true,
          hint: "user|lead",
        },
        { key: "email", label: "Email", in: "body", required: false },
        { key: "name", label: "Name", in: "body", required: false },
      ],
    },
    {
      key: "create_note",
      label: "Create note",
      description: "Add a note to a contact.",
      method: "POST",
      pathTemplate: "/contacts/{contactId}/notes",
      write: true,
      fields: [
        { key: "contactId", label: "Contact id", in: "path", required: true },
        { key: "body", label: "Note", in: "body", required: true },
      ],
    },
    {
      key: "send_message",
      label: "Send message",
      description: "Send an in-app or email message.",
      method: "POST",
      pathTemplate: "/messages",
      write: true,
      fields: [
        {
          key: "messageType",
          label: "Message type",
          in: "body",
          required: true,
          bodyPath: "message_type",
          hint: "inapp|email",
        },
        { key: "subject", label: "Subject", in: "body", required: false },
        {
          key: "bodyText",
          label: "Body",
          in: "body",
          required: true,
          bodyPath: "body",
        },
        {
          key: "from",
          label: "From",
          in: "body",
          required: true,
          type: "json",
          hint: "{ type, id }",
        },
        {
          key: "to",
          label: "To",
          in: "body",
          required: true,
          type: "json",
          hint: "{ type, id }",
        },
      ],
    },
    {
      key: "get_me",
      label: "Get current admin",
      description:
        "Return the admin this access token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
