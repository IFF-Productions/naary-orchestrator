// ── Microsoft Graph (cloud, graph.microsoft.com/v1.0; auth = an OAuth access token as a
//    Bearer). Unprobeable on purpose: `/me` answers only a DELEGATED token, and these
//    actions are built for an application token ───────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const MSGRAPH: IntegrationProvider = {
  key: "msgraph",
  label: "Microsoft Graph",
  baseUrl: "https://graph.microsoft.com/v1.0",
  authScheme: "bearer",
  description:
    "Work with Microsoft 365 via Graph — read mail, send mail, read and create calendar events.",
  auth: "A custom connection whose token is a Microsoft Graph OAuth access token — sent as a Bearer token.",
  unprobeableReason:
    "Microsoft Graph's `/me` answers only for a DELEGATED token; an application (client-credentials) " +
    "token — which is what the `/users/{id}/…` actions here are built for — is rejected by it in a " +
    "way indistinguishable from a bad credential. Reporting that as a dead token would be a lie, so " +
    "Graph is left unchecked: test it with an integration node on a canvas (single-node Test).",
  actions: [
    {
      key: "list_messages",
      label: "List messages",
      description: "List a user's mail messages.",
      method: "GET",
      pathTemplate: "/users/{userId}/messages",
      write: false,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "'me' for the delegated user, or a user id / UPN",
        },
      ],
    },
    {
      key: "send_mail",
      label: "Send mail",
      description: "Send an email as a user.",
      method: "POST",
      pathTemplate: "/users/{userId}/sendMail",
      write: true,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "'me' for the delegated user, or a user id / UPN",
        },
        {
          key: "message",
          label: "Message (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "message",
          hint: "Graph message object: { subject, body, toRecipients }",
        },
        {
          key: "saveToSentItems",
          label: "Save to sent items",
          in: "body",
          required: false,
          type: "boolean",
          bodyPath: "saveToSentItems",
        },
      ],
    },
    {
      key: "list_events",
      label: "List events",
      description: "List a user's calendar events.",
      method: "GET",
      pathTemplate: "/users/{userId}/events",
      write: false,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "'me' for the delegated user, or a user id / UPN",
        },
      ],
    },
    {
      key: "create_event",
      label: "Create event",
      description: "Create a calendar event for a user.",
      method: "POST",
      pathTemplate: "/users/{userId}/events",
      write: true,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "'me' for the delegated user, or a user id / UPN",
        },
        { key: "subject", label: "Subject", in: "body", required: true },
        {
          key: "start",
          label: "Start (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ dateTime, timeZone }",
        },
        {
          key: "end",
          label: "End (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ dateTime, timeZone }",
        },
      ],
    },
  ],
};
