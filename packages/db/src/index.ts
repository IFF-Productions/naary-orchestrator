import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

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
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }
    const adapter = new PrismaPg({ connectionString });
    client = new PrismaClient({ adapter });
  }
  return client;
}
