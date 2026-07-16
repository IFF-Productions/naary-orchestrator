import { resolve } from "node:path";
import { config } from "dotenv";

// Load the repo-root .env (DATABASE_URL, ENCRYPTION_KEY) before any @naary/*
// module evaluates. Import this FIRST in the worker entrypoint.
config({ path: resolve(__dirname, "../../../.env") });

// Fail fast at boot if required config is missing/malformed (Sec#6): the worker
// fetches/decrypts tenant keys, so a bad ENCRYPTION_KEY must stop startup, not
// surface on the first agent run.
function requireEnv(): void {
  const errors: string[] = [];
  const key = process.env.ENCRYPTION_KEY;
  if (!key) errors.push("ENCRYPTION_KEY is required");
  else if (!/^[0-9a-fA-F]{64}$/.test(key))
    errors.push("ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
  if (!process.env.DATABASE_URL) errors.push("DATABASE_URL is required");
  if (errors.length > 0) {
    throw new Error(`Invalid environment:\n  - ${errors.join("\n  - ")}`);
  }
}

// Notifications need an absolute SPA URL to render clickable run links + Approve/Reject buttons.
// It resolves from APP_BASE_URL, falling back to the first http(s) origin in CORS_ORIGINS. Warn
// (don't fail) if neither is present — alerts still send, just with a bare run id and no buttons.
function warnIfNoAppBaseUrl(): void {
  const hasBase = [
    process.env.APP_BASE_URL ?? "",
    ...(process.env.CORS_ORIGINS ?? "").split(","),
  ].some((c) => /^https?:\/\/[^\s]+$/.test(c.trim()));
  if (!hasBase) {
    console.warn(
      "[worker] No APP_BASE_URL (or CORS_ORIGINS) set — Slack/Teams notifications will show a bare run id with no clickable link or Approve/Reject buttons. Set APP_BASE_URL to your SPA URL to enable them.",
    );
  }
}

requireEnv();
warnIfNoAppBaseUrl();
