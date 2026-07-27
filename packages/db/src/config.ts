/**
 * Configuration for `@naary/db`. See docs/design/CONFIG-CENTRALIZATION.md (slice 3).
 *
 * A package-local module, NOT an app's: `@naary/db` is consumed by both apps/api and apps/worker,
 * so importing either one's config would invert the dependency direction.
 *
 * A function, not a constant: the connection string is read on FIRST USE (getPrisma's singleton),
 * which is what lets a process load dotenv before any @naary/* module needs a database.
 */

/** Postgres connection string. Loaded from the root .env by the running process — never from
 *  schema.prisma, which has no access to it. Required; getPrisma throws without it. */
export function databaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.DATABASE_URL;
}
