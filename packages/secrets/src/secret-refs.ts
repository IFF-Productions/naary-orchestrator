/**
 * Environment Secrets ($secrets) — in-activity resolution of `{{ $secrets.NAME }}` tokens.
 *
 * Secret VALUES must never enter the graph, run ctx, or Temporal history (CLAUDE.md Tier-1 §4). So —
 * unlike every other `{{ }}` token — the deterministic workflow leaves `{{ $secrets.NAME }}` LITERAL
 * (see @naary/dsl `isSecretRef`), and the ACTIVITY that consumes the config resolves it here, in
 * memory, immediately before use, from the encrypted per-env `SecretStore`.
 *
 * This module is PURE (no store dependency): the caller injects `resolveOne(name) => plaintext`, so
 * the DB/decrypt lives in the activity and this stays trivially testable. `NAME` is an identifier
 * (letters/digits/underscore, not leading digit) — the same shape the management API validates.
 */

/** Matches `{{ $secrets.NAME }}` (NAME = identifier). Global — reset lastIndex before .test()/.exec(). */
export const SECRET_TOKEN_RE =
  /\{\{\s*\$secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** True if `s` contains at least one `{{ $secrets.NAME }}` token. */
export function hasSecretRef(s: string): boolean {
  SECRET_TOKEN_RE.lastIndex = 0;
  return SECRET_TOKEN_RE.test(s);
}

/** The distinct secret NAMES referenced in `s` (in first-seen order). */
export function secretNamesIn(s: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(SECRET_TOKEN_RE.source, "g"); // own lastIndex
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex.exec loop
  while ((m = re.exec(s)) !== null) {
    const name = m[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Replace every `{{ $secrets.NAME }}` token in ONE string with its resolved plaintext. Each distinct
 * NAME in the string is resolved exactly once (via `resolveOne`) and reused. `resolveOne` throws if a
 * secret is missing — the activity maps that to a non-retryable failure naming only the NAME, never a
 * value. Returns the string with secrets inlined; the caller must treat the result as sensitive
 * (use it in-memory, never return/log it).
 */
export async function resolveSecretsInString(
  s: string,
  resolveOne: (name: string) => Promise<string>,
): Promise<string> {
  const names = secretNamesIn(s);
  if (names.length === 0) return s;
  const values = new Map<string, string>();
  await Promise.all(
    names.map(async (name) => {
      values.set(name, await resolveOne(name));
    }),
  );
  return s.replace(
    new RegExp(SECRET_TOKEN_RE.source, "g"),
    (_match, name: string) => values.get(name) ?? "",
  );
}

/** True if any string ANYWHERE in `value` (deep-walked object/array) holds a `{{ $secrets.X }}` token. */
export function hasSecretRefDeep(value: unknown): boolean {
  if (typeof value === "string") return hasSecretRef(value);
  if (Array.isArray(value)) return value.some(hasSecretRefDeep);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(
      hasSecretRefDeep,
    );
  }
  return false;
}

/**
 * Deep-resolve `{{ $secrets.NAME }}` tokens in every string of an object/array/string, returning the
 * same shape with secrets inlined. For an HTTP request body that embeds a token (e.g.
 * `{ "api_key": "{{ $secrets.KEY }}" }`). Same sensitivity contract as `resolveSecretsInString`:
 * in-memory only, never returned to the workflow or logged. Non-strings pass through unchanged.
 */
export async function resolveSecretsDeep<T>(
  value: T,
  resolveOne: (name: string) => Promise<string>,
): Promise<T> {
  if (typeof value === "string") {
    return (await resolveSecretsInString(value, resolveOne)) as unknown as T;
  }
  if (Array.isArray(value)) {
    return (await Promise.all(
      value.map((v) => resolveSecretsDeep(v, resolveOne)),
    )) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([k, v]) => {
        out[k] = await resolveSecretsDeep(v, resolveOne);
      }),
    );
    return out as unknown as T;
  }
  return value;
}
