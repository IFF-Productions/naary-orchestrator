import { resolve } from "node:path";
import { config } from "dotenv";

// Load the repo-root .env (DATABASE_URL, ENCRYPTION_KEY) before any @naary/*
// module evaluates. Import this FIRST in the process entrypoint.
config({ path: resolve(__dirname, "../../../.env") });

/**
 * Fail fast at boot if required config is missing/malformed — a process that
 * starts "healthy" but dies on the first credential op is a config footgun
 * (Sec#6). Validate here, before Nest builds the modules.
 */
function requireEnv(): void {
  const errors: string[] = [];

  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    errors.push("ENCRYPTION_KEY is required");
  } else if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    errors.push("ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
  }

  if (!process.env.DATABASE_URL) {
    errors.push("DATABASE_URL is required");
  }

  if (errors.length > 0) {
    // Don't print the values — only which vars are wrong.
    throw new Error(`Invalid environment:\n  - ${errors.join("\n  - ")}`);
  }
}

requireEnv();
