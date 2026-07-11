/**
 * Pure secret-scrubbing for browser Sentry events — no React/Sentry imports, so it's
 * unit-testable in isolation (see apps/web/test/sentry-scrub.spec.ts) and safe to run
 * over an entire Sentry event/breadcrumb tree in beforeSend/beforeBreadcrumb.
 *
 * Two passes, applied recursively to every string in the tree:
 *   1. Drop the VALUE of any key that names a secret (authorization / token / secret /
 *      api-key / password) — a whole-field redaction, so a bearer header never ships.
 *   2. Redact secret-SHAPED substrings inside any remaining string: bearer tokens, our
 *      `nry_` API tokens, provider keys (`sk-…`, `gh*_…`), AND URL query-string secrets
 *      (`?token=…`, `?access_token=…`, …) — the case the first pass misses because the
 *      secret is embedded in a URL string, not a field of its own.
 */

/** Field names whose entire value we redact, regardless of content. */
const SENSITIVE_KEY_RE =
  /authorization|token|secret|api[_-]?key|password|cookie/i;

/** Secret-SHAPED substrings inside a string value. Token tails allow `-`/`_` so a
 *  hyphenated key (`sk-proj-…`, `sk-live-…`) is redacted whole, not just its prefix. */
const SECRET_TOKEN_RE =
  /\b(?:Bearer\s+[\w.\-]+|nry_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{10,})/g;

/** Secrets carried as URL query parameters — redact the value, keep the key for context.
 *  The leading delimiter is `^` OR `?`/`&`, so a bare `query_string` ("api_key=…&q=…")
 *  whose FIRST param is the secret is still caught. */
const URL_SECRET_PARAM_RE =
  /(^|[?&])((?:access_token|refresh_token|token|api[_-]?key|key|secret|sig|signature|password)=)[^&#\s]+/gi;

const REDACTED = "[redacted]";

function redactString(s: string): string {
  return s
    .replace(URL_SECRET_PARAM_RE, `$1$2${REDACTED}`)
    .replace(SECRET_TOKEN_RE, REDACTED);
}

/**
 * Recursively scrub a value (object / array / string / primitive). Returns a new value;
 * does not mutate the input. Safe on cyclic-free Sentry payloads (events aren't cyclic).
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redactSecrets(v);
    }
    return out;
  }
  return value;
}
