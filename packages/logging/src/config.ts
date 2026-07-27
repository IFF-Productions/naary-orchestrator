/**
 * Configuration for `@naary/logging`. See docs/design/CONFIG-CENTRALIZATION.md (slice 3).
 *
 * Package-local (consumed by both apps), and a function so the level is read when a logger is
 * created rather than when this module is first imported.
 */

/** pino level. Quiet by default; `LOG_LEVEL=debug` for local debugging. Not validated here —
 *  pino rejects an unknown level itself, with a better message than we would write. */
export function logLevel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOG_LEVEL ?? "info";
}
