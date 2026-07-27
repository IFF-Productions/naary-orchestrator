/**
 * Configuration for `@naary/connections`. See docs/design/CONFIG-CENTRALIZATION.md (slice 3).
 *
 * These are PLATFORM credentials — one GitHub App and one Atlassian app per deployment, shared by
 * every tenant — as distinct from the per-tenant tokens that live encrypted in Postgres. That is
 * why they are env at all: a tenant can't set them, and an operator must.
 */

/** Numeric GitHub App id. With the private key absent, the App flow is off and connections fall
 *  back to PATs. */
export function githubAppId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.GITHUB_APP_ID;
}

/**
 * The App's PEM private key. A single-line env var carries the PEM's newlines as literal `\n`, so
 * they are un-escaped here — `createPrivateKey` needs a real PEM, and a key pasted with real
 * newlines passes through untouched.
 */
export function githubAppPrivateKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.GITHUB_APP_PRIVATE_KEY;
  if (!raw) return undefined;
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

/** The app's URL slug (e.g. "naary"), for the install URL. Undefined ⇒ the install flow is off. */
export function githubAppSlug(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.GITHUB_APP_SLUG || undefined;
}

/** Atlassian 3LO client id. Both id and secret are required, or the OAuth flow stays off. */
export function atlassianClientId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.ATLASSIAN_OAUTH_CLIENT_ID;
}

/** Atlassian 3LO client secret. See {@link atlassianClientId}. */
export function atlassianClientSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.ATLASSIAN_OAUTH_CLIENT_SECRET;
}

/**
 * Scope override, comma- OR space-separated (both forms get pasted out of Atlassian's console).
 * Empty ⇒ the caller's DEFAULT_SCOPES. `offline_access` is force-added at authorize time
 * regardless, so a misconfigured list here can't silently kill token refresh.
 */
export function atlassianScopes(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.ATLASSIAN_OAUTH_SCOPES?.trim();
  return raw ? raw.split(/[,\s]+/).filter(Boolean) : [];
}

/**
 * Whether a database is configured. Used ONLY to decide whether OAuth refresh can take a
 * Postgres advisory lock across processes, or must fall back to in-process locking (dev/test).
 * The connection string itself belongs to @naary/db, which is the only thing that should hold it.
 */
export function hasDatabase(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DATABASE_URL);
}
