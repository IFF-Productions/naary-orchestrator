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

  // Seed a RUNNABLE new-node graph (no LLM key, no approval) that exercises the
  // set → merge (diamond) → wait nodes end-to-end, so the run-through e2e can start
  // it and watch it complete. workflowKey "e2e-nodes".
  await fetch(`${API_BASE}/graphs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      workflowKey: "e2e-nodes",
      name: "E2E new nodes",
      graph: {
        startNodeId: "s",
        nodes: [
          { id: "s", type: "start" },
          { id: "a", type: "set", config: { fields: { a: 1 } } },
          { id: "b", type: "set", config: { fields: { b: 2 } } },
          { id: "m", type: "merge", config: { mode: "array" } },
          { id: "dt", type: "dateTime", config: { addSeconds: 30 } },
          {
            id: "rk",
            type: "renameKeys",
            config: { from: "a", rename: { a: "alpha" } },
          },
          {
            id: "c",
            type: "code",
            config: {
              // real QuickJS/WASM run in the worker container — reads $ctx, returns
              code: "return { doubled: ($ctx.a.a || 0) * 2, has: typeof $ctx.rk === 'object' };",
            },
          },
          { id: "w", type: "wait", config: { durationSeconds: 1 } },
          { id: "e", type: "end" },
        ],
        edges: [
          { from: "s", to: "a" },
          { from: "s", to: "b" },
          { from: "a", to: "m" },
          { from: "b", to: "m" },
          { from: "m", to: "dt" },
          { from: "dt", to: "rk" },
          { from: "rk", to: "c" },
          { from: "c", to: "w" },
          { from: "w", to: "e" },
        ],
      },
    }),
  }).catch(() => undefined);

  // Seed a wait(webhook) graph: start → wait(mode:webhook) → end. It parks the run
  // in `awaiting_webhook` indefinitely until an external POST to the signed resume URL
  // releases it — the durable human-in-the-loop path the resume e2e drives end-to-end.
  // workflowKey "e2e-wait-webhook".
  await fetch(`${API_BASE}/graphs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      workflowKey: "e2e-wait-webhook",
      name: "E2E wait for webhook",
      graph: {
        startNodeId: "s",
        nodes: [
          { id: "s", type: "start" },
          { id: "w", type: "wait", config: { mode: "webhook" } },
          { id: "e", type: "end" },
        ],
        edges: [
          { from: "s", to: "w" },
          { from: "w", to: "e" },
        ],
      },
    }),
  }).catch(() => undefined);

  // A monthly budget cap for the tenant — REQUIRED before a public form can be registered (the
  // anonymous endpoint's spend backstop). Seed it on the TOKEN's real tenant (via /me), not the
  // env TENANT: when E2E_API_TOKEN is supplied in CI its tenant may differ, and the form-page test
  // registers against the token's tenant (resolved server-side), so the budget must match. Falls
  // back to the env TENANT if /me is unavailable. Idempotent PUT.
  const budgetTenant = await fetch(`${API_BASE}/me`, {
    headers: { authorization: `Bearer ${token}` },
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { tenantId?: string } | null) => j?.tenantId ?? TENANT)
    .catch(() => TENANT);
  await fetch(`${API_BASE}/tenants/${budgetTenant}/budget`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ monthlyCapUsd: 100, perExecutionCapUsd: 5 }),
  }).catch(() => undefined);

  // Seed a form-trigger graph: formTrigger → end. Its config carries the field schema the hosted
  // public form renders. The form-page e2e registers a form against this key and submits it.
  // workflowKey "e2e-form".
  await fetch(`${API_BASE}/graphs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      workflowKey: "e2e-form",
      name: "E2E hosted form",
      graph: {
        startNodeId: "form",
        nodes: [
          {
            id: "form",
            type: "formTrigger",
            config: {
              title: "E2E Contact",
              description: "Say hello.",
              submitLabel: "Send it",
              fields: [
                { key: "email", label: "Email", type: "email", required: true },
                { key: "message", label: "Message", type: "textarea" },
              ],
            },
          },
          { id: "end", type: "end" },
        ],
        edges: [{ from: "form", to: "end" }],
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
