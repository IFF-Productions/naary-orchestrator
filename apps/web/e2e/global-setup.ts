import { execFileSync } from "node:child_process";
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

/**
 * Mint a `nry_` token straight into the DB, the way CI does — deliberately WITHOUT pnpm or a
 * TypeScript runner in the path.
 *
 * This used to shell out to `pnpm exec ts-node src/auth/mint-token.ts`. `ts-node` was removed in
 * the TS7 migration, so the documented local flow in this directory's README had been failing with
 * "Command ts-node not found" — CI never noticed because it sets `E2E_API_TOKEN` and skips this
 * branch entirely. Found by running the suite locally for the first time in a while.
 *
 * Throws with the underlying cause when the DB can't be reached — an earlier version returned a
 * silent undefined that surfaced as the caller's generic "could not obtain an API token", which
 * names nothing. The real cause is right here; carry it.
 */
function mintToken(): string {
  const url =
    process.env.DATABASE_URL ??
    `postgresql://${process.env.POSTGRES_USER ?? "naary"}:${
      process.env.POSTGRES_PASSWORD ?? ""
    }@localhost:${process.env.E2E_PG_PORT ?? 5432}/${
      process.env.POSTGRES_DB ?? "naary_orchestrator"
    }?schema=public`;
  const script = `
    const { createHash, randomBytes } = require("node:crypto");
    const { Client } = require("pg");
    (async () => {
      const token = "nry_" + randomBytes(24).toString("base64url");
      const hash = createHash("sha256").update(token).digest("hex");
      const c = new Client({ connectionString: ${JSON.stringify(url)} });
      await c.connect();
      await c.query(
        'insert into "ApiToken"(id,"tenantId","tokenHash",label) values (gen_random_uuid(),$1,$2,$3)',
        [${JSON.stringify(TENANT)}, hash, "e2e"],
      );
      await c.end();
      process.stdout.write(token);
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `;
  try {
    // execFile, NOT exec: a shell would eat the `$1,$2,$3` placeholders as variable expansions
    // (producing `values (gen_random_uuid(),,,)`) and mangle the newlines. No shell, no quoting.
    // cwd: packages/db, the workspace that actually has `pg` installed.
    return execFileSync("node", ["-e", script], {
      cwd: path.resolve(process.cwd(), "../../packages/db"),
      encoding: "utf8",
    }).trim();
  } catch (e) {
    const detail =
      e && typeof e === "object" && "stderr" in e
        ? String((e as { stderr?: unknown }).stderr).trim()
        : e instanceof Error
          ? e.message
          : String(e);
    throw new Error(
      `E2E setup: could not mint an API token against the DB — ${detail}\n` +
        "Is the stack up (docker compose up -d) and POSTGRES_PASSWORD/DATABASE_URL set?",
    );
  }
}

async function globalSetup(_config: FullConfig): Promise<void> {
  const cwd = process.cwd();

  // mintToken throws WITH the cause; no generic fallback message to flatten it into.
  const token = process.env.E2E_API_TOKEN || mintToken();

  /**
   * Seed one graph, and FAIL LOUDLY if the API refuses it.
   *
   * Every seed here used to be `fetch(...).catch(() => undefined)`, which is doubly silent: the
   * catch only fires on a network error, so a 4xx *resolved* and was dropped on the floor too.
   * When the integration save gate (#1138) started refusing one of these fixtures, the seed
   * vanished and the symptom was two unrelated specs failing on "element not found" — a locator
   * mystery instead of "the API answered 400 and said why". A seed the tests depend on is not
   * optional, and a broken one must say so here, once, in the setup that created it.
   */
  async function seedGraph(body: Record<string, unknown>): Promise<void> {
    const key = String(body.workflowKey);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/graphs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(
        `E2E setup: could not reach ${API_BASE}/graphs to seed "${key}" — ` +
          `${e instanceof Error ? e.message : String(e)}. Is the stack up?`,
      );
    }
    if (res.ok) return;
    const detail = await res.text().catch(() => "");
    throw new Error(
      `E2E setup: seeding workflow "${key}" failed with ${res.status}. ${detail}`,
    );
  }

  // Re-seeding is safe: POST /graphs is an upsert, so an existing key mints a new version and an
  // identical graph is a no-op — there is no 'already exists' to tolerate.
  await seedGraph({
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
  });

  // Seed a RUNNABLE new-node graph (no LLM key, no approval) that exercises the
  // set → merge (diamond) → wait nodes end-to-end, so the run-through e2e can start
  // it and watch it complete. workflowKey "e2e-nodes".
  await seedGraph({
    workflowKey: "e2e-nodes",
    name: "E2E new nodes",
    graph: {
      startNodeId: "s",
      nodes: [
        // sampleInput seeds ctx.__input, so the run-detail "Run input" panel has
        // a deterministic payload to assert against (session-fixes e2e).
        {
          id: "s",
          type: "start",
          config: {
            sampleInput: { source: "e2e-run-input", ticket: "NAARY-42" },
          },
        },
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
  });

  // Seed a wait(webhook) graph: start → wait(mode:webhook) → end. It parks the run
  // in `awaiting_webhook` indefinitely until an external POST to the signed resume URL
  // releases it — the durable human-in-the-loop path the resume e2e drives end-to-end.
  // workflowKey "e2e-wait-webhook".
  await seedGraph({
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
  });

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
  await seedGraph({
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
  });

  // Seed a chat-trigger graph: chatTrigger → respondToWebhook (echoes the message back as the reply)
  // → end. Hermetic (no LLM). The chat-page e2e registers a chat against this key and messages it.
  // workflowKey "e2e-chat".
  await seedGraph({
    workflowKey: "e2e-chat",
    name: "E2E hosted chat",
    graph: {
      startNodeId: "chat",
      nodes: [
        {
          id: "chat",
          type: "chatTrigger",
          config: { title: "E2E Chat", greeting: "Hi there!" },
        },
        {
          id: "reply",
          type: "respondToWebhook",
          // Echo the inbound message straight back as the reply (proves the round-trip).
          config: { bodyBinding: { from: "chat", path: "message" } },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "chat", to: "reply" },
        { from: "reply", to: "end" },
      ],
    },
  });

  // Seed a saved graph containing a GitHub INTEGRATION node. Every integration tile shares the
  // DSL type "integration", so a type-keyed label collapses to the last-registered tile ("Notion")
  // and mislabels this GitHub node. The session-fixes e2e opens this workflow's detail page and
  // asserts it reads "GitHub", guarding the provider-aware nodeDisplayLabel fix. workflowKey
  // "e2e-integration".
  //
  // The config is COMPLETE — a connection is chosen and every required field of `create_issue`
  // is filled. It was `connectionId: ""` with no fields until the integration save gate (#1138)
  // began refusing a node that cannot run, which is a graph no user can save any more; a fixture
  // that only exists because the API used to accept it tests nothing real.
  //
  // `connectionId` names a connection that does NOT exist in this stack, which is deliberate and
  // still reachable: the gate requires that a connection be CHOSEN, not that it resolves. The
  // canvas lint is what flags a dangling id, and the neighbouring spec covers that on its own
  // freshly-placed node. This one is about the LABEL, and it never runs the graph.
  await seedGraph({
    workflowKey: "e2e-integration",
    name: "E2E GitHub integration",
    graph: {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "gh",
          type: "integration",
          config: {
            provider: "github",
            action: "create_issue",
            connectionId: "e2e-github-connection",
            fields: {
              owner: "naary-e2e",
              repo: "fixtures",
              title: "E2E issue",
            },
          },
        },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "gh" },
        { from: "gh", to: "e" },
      ],
    },
  });

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
