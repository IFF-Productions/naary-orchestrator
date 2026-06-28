import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FullConfig } from "@playwright/test";

/**
 * Prepares auth + seed data for the suite:
 *  1. Obtain a `nry_` API token — from E2E_API_TOKEN (CI), else mint one via the
 *     CLI against the running DB.
 *  2. Seed an "e2e" workflow so canvas/runs tests have something to act on.
 *  3. Write a storageState with the token in localStorage, so every test starts
 *     authenticated (the SPA attaches it as the bearer token) — no Firebase login.
 *
 * Run from apps/web (the package's test:e2e script), so cwd is apps/web.
 */
const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:3000";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8081";
const TENANT = process.env.E2E_TENANT ?? "t-demo";

async function globalSetup(_config: FullConfig): Promise<void> {
  const cwd = process.cwd();
  const repoRoot = path.resolve(cwd, "../..");

  let token = process.env.E2E_API_TOKEN;
  if (!token) {
    const out = execSync(
      `pnpm --filter @naary/api exec ts-node src/auth/mint-token.ts ${TENANT} e2e`,
      { cwd: repoRoot, encoding: "utf8" },
    );
    token = out.trim().split("\n").pop()?.trim();
  }
  if (!token) throw new Error("E2E setup: could not obtain an API token");

  // Seed a workflow (ignore 'already exists' / offline — tests handle empty too).
  await fetch(`${API_BASE}/graphs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      // "default" is the key the Runs "Start test run" button triggers.
      workflowKey: "default",
      name: "E2E flow",
      graph: {
        startNodeId: "s",
        nodes: [
          { id: "s", type: "start" },
          { id: "a", type: "humanApproval" },
          { id: "e", type: "end" },
        ],
        edges: [
          { from: "s", to: "a" },
          { from: "a", to: "e" },
        ],
      },
    }),
  }).catch(() => undefined);

  const authDir = path.resolve(cwd, "e2e/.auth");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(
    path.join(authDir, "state.json"),
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: BASE_URL,
          localStorage: [{ name: "naary_api_token", value: token }],
        },
      ],
    }),
  );
}

export default globalSetup;
