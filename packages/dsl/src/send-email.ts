import { getByPath } from "./mcp-args";
import type { SendEmailNodeConfig } from "./types";

/** The concrete email after binding resolution — no secret (the SMTP URI is
 *  attached in the activity from `connectionId`). */
export interface ResolvedSendEmail {
  connectionId: string;
  /** From address; empty when the activity should fall back to the SMTP URI user. */
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  costUsd?: number;
}

/** Node/agent outputs that wrap a single readable string under a conventional key — binding the
 *  WHOLE output to an email field should yield that message, not a JSON blob. See TEMPLATE-EDITOR.md. */
const BODY_TEXT_KEYS = [
  "text",
  "html",
  "body",
  "content",
  "message",
  "markdown",
] as const;

/**
 * Coerce a resolved field value to a string for an email field. A string passes through; a
 * primitive stringifies. For an OBJECT (the "I bound my whole agent/node output to the body" case
 * that used to render a raw `JSON.stringify` dump — the reported bug), render readably:
 *   - a wrapper with a single readable string (e.g. `{ text }`, `{ html }`, `{ body }`) → that string;
 *   - otherwise `key: value` lines (nested values compacted), not a one-line JSON blob;
 *   - an array → its items, one per line.
 * The real fix for readable email is a template (TEMPLATE-EDITOR.md); this is the graceful fallback
 * so an accidental object binding still sends something legible. Pure + deterministic.
 */
function toField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(toField).join("\n");
  const obj = value as Record<string, unknown>;
  for (const k of BODY_TEXT_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  const entries = Object.entries(obj);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      const rendered =
        typeof v === "string"
          ? v
          : v !== null && typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
      return `${k}: ${rendered}`;
    })
    .join("\n");
}

/**
 * Resolve a sendEmail node's concrete message from ctx. Static fields are the base;
 * each `fieldBindings` entry (to/subject/text/html) overrides its field from an
 * upstream output. Pure, deterministic (path-reads, no I/O, no credentials).
 */
export function resolveSendEmail(
  config: SendEmailNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedSendEmail {
  const fields: Record<string, string | undefined> = {
    from: config.from,
    to: config.to,
    subject: config.subject,
    text: config.text,
    html: config.html,
  };
  for (const [name, binding] of Object.entries(config.fieldBindings ?? {})) {
    fields[name] = toField(getByPath(ctx[binding.from], binding.path));
  }
  return {
    connectionId: config.connectionId,
    from: fields.from ?? "",
    to: fields.to ?? "",
    subject: fields.subject ?? "",
    ...(fields.text !== undefined ? { text: fields.text } : {}),
    ...(fields.html !== undefined ? { html: fields.html } : {}),
    costUsd: config.costUsd,
  };
}
