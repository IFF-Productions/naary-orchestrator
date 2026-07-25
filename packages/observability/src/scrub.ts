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

/**
 * Exact key names that LOOK sensitive to {@link SENSITIVE_KEY} but provably are not (#581). The
 * OTel GenAI conventions spell token COUNTS as `gen_ai.usage.input_tokens` etc., and the `token`
 * substring in the pattern above was blanking every one of them to "[REDACTED]" — silently gutting
 * the GenAI spans/metrics (caught by the exported-envelope test, not by a mapper unit test).
 *
 * Deliberately EXACT full-key names, never a pattern: this is a hole in a security-critical filter,
 * so it must not be widenable by accident. A value under one of these keys is still deep-scrubbed
 * (recursed / redactString'd) — we only skip the key-NAME blanking. Every entry is a name WE emit
 * from genai.ts and whose value is a count or a fixed enum, never credential material.
 */
const SAFE_TELEMETRY_KEYS = new Set([
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cached_input_tokens",
  "gen_ai.usage.total_tokens",
  "gen_ai.request.max_tokens",
  "gen_ai.token.type", // metric dimension: "input" | "output"
  // The same bug in our OWN structured logs + ledger fields: `log.info({ inputTokens, … })` from the
  // agent activity shipped "[REDACTED]" for every count. Same exact-name, count-only reasoning.
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "maxOutputTokens",
]);

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
  // credentials-in-URL (#598): `scheme://user:password@host` under a benign key
  // (dsn/url/uri) matches neither the key-name list nor the shapes above. Keep
  // scheme://user:, redact the password; the lookahead leaves the @host readable.
  /((?:[a-z][a-z0-9+.-]*):\/\/[^\s/:@]+:)[^\s@/]+(?=@)/gi,
];

export function redactString(s: string): string {
  let out = s;
  for (const re of PATTERNS) {
    out = out.replace(re, (_m, p1?: unknown) =>
      // The key=value pattern has a capture group (the label) we keep, redacting
      // only the value. For patterns WITHOUT a group, the replacer's 2nd arg is
      // the match OFFSET (a number) — so only treat a STRING as the label;
      // otherwise redact the whole match. (Number check guards the offset case.)
      typeof p1 === "string" ? `${p1}${REDACTED}` : REDACTED,
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
    // Sentry transaction/span objects expose GETTER-ONLY (and non-writable) fields; assigning
    // to them throws "Cannot set property … which has only a getter" and crashed
    // beforeSendTransaction on every traced request. Only reassign a writable data slot; for a
    // read-only slot, still RECURSE into its value so nested mutable secrets are scrubbed in
    // place — we just never write the slot itself.
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    const settable = !desc || (desc.writable !== false && !desc.get);
    if (SENSITIVE_KEY.test(key) && !SAFE_TELEMETRY_KEYS.has(key)) {
      if (settable) obj[key] = REDACTED;
    } else if (settable) {
      obj[key] = deepScrub(obj[key], depth + 1, seen);
    } else {
      deepScrub(obj[key], depth + 1, seen); // recurse without reassigning the read-only slot
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
