// ── Twilio (cloud, api.twilio.com/2010-04-01; auth = HTTP Basic with the token stored as
//    `AccountSid:AuthToken`). Its writes are `bodyEncoding: "form"` — Twilio rejects JSON
//    (#707) — and `accountSid` is a real path field: it is NOT derived from the token.
//    `list_accounts` is the credential probe ───────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const TWILIO: IntegrationProvider = {
  key: "twilio",
  label: "Twilio",
  baseUrl: "https://api.twilio.com/2010-04-01",
  authScheme: "basic",
  description:
    "Send SMS and place calls with Twilio — send/read messages, list messages, make a call.",
  auth: "A custom connection whose token is `AccountSid:AuthToken` (sent as HTTP Basic). Set the same Account SID as the node's `accountSid` field — the request builder needs it explicitly for the {accountSid} path segment (it is not derived from the connection token).",
  actions: [
    {
      key: "send_sms",
      label: "Send SMS",
      description: "Send an SMS message.",
      method: "POST",
      pathTemplate: "/Accounts/{accountSid}/Messages.json",
      // Rejects JSON outright — form-encoded only (#707).
      bodyEncoding: "form",
      write: true,
      fields: [
        {
          key: "accountSid",
          label: "Account SID",
          in: "path",
          required: true,
          hint: "e.g. ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        },
        {
          key: "To",
          label: "To",
          in: "body",
          required: true,
          hint: "destination number in E.164, e.g. +15558675310",
        },
        {
          key: "From",
          label: "From",
          in: "body",
          required: true,
          hint: "your Twilio number in E.164",
        },
        { key: "Body", label: "Body", in: "body", required: true },
      ],
    },
    {
      key: "get_message",
      label: "Get message",
      description: "Fetch a single message by its SID.",
      method: "GET",
      pathTemplate: "/Accounts/{accountSid}/Messages/{messageSid}.json",
      write: false,
      fields: [
        {
          key: "accountSid",
          label: "Account SID",
          in: "path",
          required: true,
        },
        {
          key: "messageSid",
          label: "Message SID",
          in: "path",
          required: true,
          hint: "e.g. SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        },
      ],
    },
    {
      key: "list_messages",
      label: "List messages",
      description: "List messages, optionally filtered by To/From.",
      method: "GET",
      pathTemplate: "/Accounts/{accountSid}/Messages.json",
      write: false,
      fields: [
        {
          key: "accountSid",
          label: "Account SID",
          in: "path",
          required: true,
        },
        { key: "To", label: "To", in: "query", required: false },
        { key: "From", label: "From", in: "query", required: false },
        {
          key: "PageSize",
          label: "Page size",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "make_call",
      label: "Make call",
      description: "Place an outbound phone call.",
      method: "POST",
      pathTemplate: "/Accounts/{accountSid}/Calls.json",
      // Rejects JSON outright — form-encoded only (#707).
      bodyEncoding: "form",
      write: true,
      fields: [
        {
          key: "accountSid",
          label: "Account SID",
          in: "path",
          required: true,
        },
        {
          key: "To",
          label: "To",
          in: "body",
          required: true,
          hint: "destination number in E.164",
        },
        {
          key: "From",
          label: "From",
          in: "body",
          required: true,
          hint: "your Twilio number in E.164",
        },
        {
          key: "Url",
          label: "TwiML URL",
          in: "body",
          required: true,
          hint: "URL returning TwiML that controls the call",
        },
      ],
    },
    {
      key: "list_accounts",
      label: "List accounts",
      description:
        "List the accounts these credentials can see. Needs no arguments (not even the Account SID), so it is the connection check.",
      method: "GET",
      pathTemplate: "/Accounts.json",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
