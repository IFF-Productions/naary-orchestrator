import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { databaseUrl } from "./config";

// Re-export the generated client types/values so consumers import from
// @naary/db, never @prisma/client directly. (workflows.ts must NEVER import
// this package — Prisma's driver/engine breaks deterministic replay + bundling.)
export * from "@prisma/client";
export { PrismaClient };

let client: PrismaClient | undefined;

/**
 * Process-wide singleton — one pg pool per worker/api process. Prisma 7 requires
 * a driver adapter; the connection string comes from DATABASE_URL (loaded from
 * the root .env by the running process), never from schema.prisma.
 */
export function getPrisma(): PrismaClient {
  if (!client) {
    const connectionString = databaseUrl();
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    const adapter = new PrismaPg({ connectionString });
    client = new PrismaClient({ adapter });
  }
  return client;
}

/**
 * The tenant's DEFAULT environment id — the `prod`-slug row that holds all pre-environments data
 * (design ENVIRONMENTS.md §2/§5), created lazily if absent (race-safe upsert on the (tenantId, slug)
 * unique). This is the compatibility-shim default target, shared by env-scoped READS that can't reach
 * the API's Nest `EnvironmentsService` — e.g. worker activities and the secrets/connections packages.
 * Read-first so steady state is a single indexed lookup. NEVER call from workflow code (Prisma is
 * non-deterministic; @naary/db is activity/API-only).
 */
export async function getDefaultEnvironmentId(
  tenantId: string,
): Promise<string> {
  const prisma = getPrisma();
  const existing = await prisma.environment.findUnique({
    where: { tenantId_slug: { tenantId, slug: "prod" } },
    select: { id: true, isDefault: true },
  });
  if (existing) {
    // Repair the inconsistent case (mirrors EnvironmentsService.ensureDefault): a prod-slug row that
    // somehow lost isDefault (manual edit / partial write) must be restored, else the delete-guard
    // ("can't delete the default env") could be bypassed and this shim would point at a deletable env.
    if (!existing.isDefault) {
      await prisma.environment.update({
        where: { id: existing.id },
        data: { isDefault: true },
      });
    }
    return existing.id;
  }
  // Create-if-missing, race-safe: a concurrent create is absorbed by the unique (empty update).
  const row = await prisma.environment.upsert({
    where: { tenantId_slug: { tenantId, slug: "prod" } },
    create: { tenantId, name: "Production", slug: "prod", isDefault: true },
    update: {},
    select: { id: true },
  });
  return row.id;
}

// Workflow key aliases (#904) — the shared old-key → live-key resolver, importable by BOTH the API
// and the worker (the sub-workflow resolver runs in a different process).
export { aliasesOf, resolveWorkflowKey } from "./workflow-key-alias";

/** Close the pg pool on shutdown (Arch§4.9). Safe to call when never connected. */
export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
