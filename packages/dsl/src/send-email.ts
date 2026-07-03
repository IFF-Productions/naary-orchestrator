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

/** Coerce a resolved field value to a string (objects → JSON, nullish → ""). */
function toField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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
