/**
 * Security-critical scrubber (CLAUDE.md: API keys / secrets never enter telemetry).
 * Runs as Sentry's `beforeSend`, but kept pure + Sentry-free so it's unit-tested in
 * isolation. Two layers of defense:
 *   1. drop any object key whose NAME looks sensitive (token/secret/password/…)
 *   2. redact secret-shaped SUBSTRINGS inside any remaining string (a provider 401
 *      message can echo a partial key; a hex blob could be the ENCRYPTION_KEY).
 */

const REDACTED = "[REDACTED]";

/** Object keys we drop wholesale. */
const SENSITIVE_KEY =
  /(authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|apikey|encryption|ciphertext|auth[_-]?tag|^iv$|credential|signing|bearer|private[_-]?key)/i;

/** Secret-shaped substrings to redact inside any string value. */
const PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub tokens
  /\bnry_[A-Za-z0-9_-]{8,}/g, // our API tokens
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b[0-9a-fA-F]{64}\b/g, // 64-hex (ENCRYPTION_KEY shape; also content hashes — redact to be safe)
  /((?:api[_-]?key|token|secret|password|authorization)["':=\s]+)([^\s,'"}]{6,})/gi, // key=value
];

export function redactString(s: string): string {
  let out = s;
  for (const re of PATTERNS) {
    out = out.replace(re, (m, p1?: string) =>
      // key=value pattern keeps the label (group 1) and redacts the value
      p1 !== undefined ? `${p1}${REDACTED}` : REDACTED,
    );
  }
  return out;
}

/** Deep-scrub an arbitrary value (Sentry event subtree). Bounded depth + cycle-safe. */
export function deepScrub<T>(value: T, depth = 0, seen = new WeakSet()): T {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => deepScrub(v, depth + 1, seen)) as unknown as T;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_KEY.test(key)) {
      obj[key] = REDACTED;
    } else {
      obj[key] = deepScrub(obj[key], depth + 1, seen);
    }
  }
  return value;
}

/** Sentry `beforeSend`: drop the raw HTTP request (headers/body), then deep-scrub. */
export function scrubEvent<T extends Record<string, unknown>>(event: T): T {
  // The request envelope is the most likely secret carrier (auth header, body).
  delete event.request;
  return deepScrub(event);
}
