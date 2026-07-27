/**
 * Configuration for `@naary/flags`. See docs/design/CONFIG-CENTRALIZATION.md (slice 3).
 */

/** Flagsmith environment key. Unset ⇒ flags are OFF entirely (flagsConfig returns null and every
 *  lookup falls back to its default) — a feature-flag service must never be able to break boot. */
export function flagsmithEnvironmentKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.FLAGSMITH_ENVIRONMENT_KEY;
}

/** Self-hosted Flagsmith API base (e.g. https://flags.internal/api/v1/). Omit for SaaS. */
export function flagsmithApiUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.FLAGSMITH_API_URL || undefined;
}
