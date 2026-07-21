import type { ArgBinding } from "./core";

/**
 * Send Email node — send a message via an `smtp` connection. The connection's SMTP
 * URI (with credentials) is read + used IN the activity (never in config/history).
 * Static `to`/`subject`/`text`/`html` are the base; each `fieldBindings` entry
 * fills/overrides that field from an upstream output. Output is `{ messageId }`.
 */
export interface SendEmailNodeConfig {
  /** An `smtp` connection; its stored URI is read in-activity. */
  connectionId: string;
  /** From address. If omitted, the activity falls back to the SMTP URI's user. */
  from?: string;
  to?: string;
  subject?: string;
  /** Plain-text body. */
  text?: string;
  /** HTML body (optional; sent alongside/instead of text). */
  html?: string;
  /** field ("to"|"subject"|"text"|"html") → upstream output binding. */
  fieldBindings?: Record<string, ArgBinding>;
  /** Flat per-send cost metered into the run budget (Arch§4.6). */
  costUsd?: number;
}
