/**
 * Friendly presentation of node types for Simple mode (design docs/design/PRODUCT-VARIANTS.md §4).
 * Maps a graph node type → a plain-language step (title, blurb, a curated set of editable fields).
 * A node type NOT here renders as a read-only "advanced step" (open in Builder to edit) — Simple
 * mode never drops structure, it just hides complexity. Keep titles jargon-free.
 */

export interface FriendlyField {
  /** config key on the node. */
  key: string;
  label: string;
  kind: "text" | "textarea" | "number" | "select" | "connection";
  options?: { value: string; label: string }[];
  /** for kind "connection": which connection types to offer. */
  connectionTypes?: readonly string[];
  placeholder?: string;
  help?: string;
}

export interface FriendlyStep {
  /** Plain-language step name, e.g. "Ask the AI". */
  title: string;
  /** One friendly line about what it does. */
  blurb: string;
  /** A --node-* accent token for the step's color bar. */
  accent: string;
  /** Editable fields shown in Simple mode (empty = no editable config). */
  fields: FriendlyField[];
}

const MODEL_OPTIONS = [
  { value: "", label: "Default model" },
  { value: "claude-opus-4-8", label: "Claude Opus (smartest)" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet (balanced)" },
  { value: "claude-haiku-4-5", label: "Claude Haiku (fastest)" },
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
];

export const FRIENDLY_CATALOG: Record<string, FriendlyStep> = {
  manualTrigger: {
    title: "Manual start",
    blurb: "This automation runs when you start it (or via the API).",
    accent: "var(--node-trigger)",
    fields: [],
  },
  webhookTrigger: {
    title: "When a webhook arrives",
    blurb: "Runs whenever an incoming request hits this automation's URL.",
    accent: "var(--node-trigger)",
    fields: [],
  },
  scheduleTrigger: {
    title: "On a schedule",
    blurb: "Runs automatically on a repeating timer.",
    accent: "var(--node-trigger)",
    fields: [
      {
        key: "cron",
        label: "Schedule (cron)",
        kind: "text",
        placeholder: "0 9 * * 1-5",
        help: "e.g. 0 9 * * 1-5 = weekdays at 9am.",
      },
    ],
  },
  agent: {
    title: "Ask the AI",
    blurb: "The AI reads what's happened so far and produces a result.",
    accent: "var(--node-agent)",
    fields: [
      {
        key: "systemPrompt",
        label: "Instructions for the AI",
        kind: "textarea",
        placeholder: "Summarize the message in one sentence.",
      },
      { key: "model", label: "Model", kind: "select", options: MODEL_OPTIONS },
    ],
  },
  humanApproval: {
    title: "Wait for your approval",
    blurb: "Pauses until a person approves or rejects — could be days.",
    accent: "var(--node-approval)",
    fields: [
      {
        key: "title",
        label: "What are you approving?",
        kind: "text",
        placeholder: "Approve the drafted reply",
      },
      {
        key: "instructions",
        label: "Notes for the reviewer",
        kind: "textarea",
      },
    ],
  },
  sendEmail: {
    title: "Send an email",
    blurb: "Sends an email through your connected mailbox.",
    accent: "var(--node-http)",
    fields: [
      {
        key: "connectionId",
        label: "Mailbox",
        kind: "connection",
        connectionTypes: ["smtp"],
      },
      { key: "to", label: "To", kind: "text", placeholder: "you@example.com" },
      { key: "subject", label: "Subject", kind: "text" },
      { key: "body", label: "Body", kind: "textarea" },
    ],
  },
  httpRequest: {
    title: "Call an API",
    blurb: "Makes a web request to another service.",
    accent: "var(--node-http)",
    fields: [
      {
        key: "url",
        label: "URL",
        kind: "text",
        placeholder: "https://api.example.com/...",
      },
      {
        key: "method",
        label: "Method",
        kind: "select",
        options: [
          { value: "GET", label: "GET" },
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
          { value: "DELETE", label: "DELETE" },
        ],
      },
    ],
  },
  wait: {
    title: "Wait",
    blurb: "Pauses for a set amount of time, then continues.",
    accent: "var(--node-router)",
    fields: [
      {
        key: "durationSeconds",
        label: "Wait for (seconds)",
        kind: "number",
        placeholder: "3600",
      },
    ],
  },
  respondToWebhook: {
    title: "Reply to the webhook",
    blurb: "Sends a response back to whoever called the webhook.",
    accent: "var(--node-http)",
    fields: [],
  },
  end: {
    title: "Done",
    blurb: "The automation finishes here.",
    accent: "var(--node-end)",
    fields: [],
  },
};

export function friendlyStep(type: string): FriendlyStep | null {
  return FRIENDLY_CATALOG[type] ?? null;
}
