// Native integration node — curated, connection-authed REST calls (GitHub/Jira/…).
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import {
  buildIntegrationRequest,
  getIntegrationAction,
  getIntegrationProvider,
  validateIntegrationConfig,
} from "@naary/dsl";
import type { IntegrationNodeConfig } from "@naary/dsl";
import {
  AuthConfigError,
  BlockedEgressError,
  MissingConnectionTokenError,
  NeedsReauthError,
} from "@naary/connections";
import { getObjectStore, maybeOffload } from "@naary/storage";
import { activityDuration, activityRuns, secondsSince } from "../../metrics";
import { type AgentMeta, toSanitizedRetryable } from "./shared";
import { DEFAULT_HTTP_TIMEOUT_MS, __httpDeps } from "./http";

// Activities run in the worker PROCESS (a side-effect zone), so structured
// logging is fine here — unlike workflows.ts, which must stay deterministic.
// Logs carry execution-correlated ids (executionId/nodeId/tenantId) and token/
// cost numbers only — never prompts, completions, or keys (the logger scrubs).
const log = createLogger({ component: "worker" });

/** Structured result of an integration action — mirrors HttpRequestResult's branchable shape. */
export interface IntegrationResult {
  status: "ok";
  httpStatus: number;
  ok: boolean;
  body: unknown;
}

/**
 * Native integration node (design docs/design/INTEGRATION-NODES.md): a curated,
 * connection-authed REST call. The catalog (in @naary/dsl) maps { provider, action } →
 * method + path + body; this activity resolves auth IN-ACTIVITY (never in config/history),
 * runs the SSRF egress guard, and returns the structured response so the graph can branch
 * on `<id>.status`. A non-2xx is RETURNED (not thrown), like httpRequest. `fields` are the
 * interpreter-resolved field values (static + bindings) — no ctx, no secrets, cross this boundary.
 *
 * WRITE actions are proxied AT-MOST-ONCE by the interpreter (no retry) — a lost response
 * must not duplicate a create/comment (design §4).
 */
export async function callIntegration(
  cfg: IntegrationNodeConfig,
  fields: Record<string, unknown>,
  meta: AgentMeta,
): Promise<IntegrationResult> {
  const startedAt = process.hrtime.bigint();
  // Full catalog-aware validation (unknown provider/action, missing required/path field) →
  // non-retryable, so a misconfigured node fails clearly rather than firing a bad request.
  const invalid = validateIntegrationConfig(cfg);
  if (invalid) {
    throw ApplicationFailure.nonRetryable(
      invalid,
      "INTEGRATION_INVALID_CONFIG",
    );
  }
  const provider = getIntegrationProvider(cfg.provider)!;

  // Fetch the connection once if we need its site URL (Jira base) or its authMode (to decide
  // Basic-vs-Bearer for a "basic"-scheme provider). GitHub needs neither.
  const needsConnection =
    provider.baseUrlFromConnection || provider.authScheme === "basic";
  const conn = needsConnection
    ? await __httpDeps.getConnection(meta.tenantId, cfg.connectionId)
    : null;

  // Base URL: static (GitHub) or the connection's site (Jira). A connection-based provider
  // with no serverUrl is a config error, not a retry.
  let base = provider.baseUrl ?? null;
  if (provider.baseUrlFromConnection) {
    base = conn?.serverUrl ?? null;
    if (!base) {
      throw ApplicationFailure.nonRetryable(
        `integration '${cfg.provider}': connection '${cfg.connectionId}' has no server URL`,
        "INTEGRATION_NO_BASE_URL",
      );
    }
  }
  const req = buildIntegrationRequest(cfg.provider, cfg.action, fields);
  const url = `${base!.replace(/\/$/, "")}${req.path}`;
  const action = getIntegrationAction(cfg.provider, cfg.action);
  // req.path is "path + query string" — log the PATH ONLY so query-param values can't leak
  // into logs (and to keep cardinality low). The template placeholders are non-secret ids.
  const loggedPath = req.path.split("?")[0];

  try {
    // Auth resolved in-memory here (Tier-1 rule 4) — never in config, never in history.
    const authHeaders = await __httpDeps.resolveAuthHeader(
      meta.tenantId,
      cfg.connectionId,
    );
    // A "basic"-scheme provider (Jira Cloud) with an API TOKEN uses HTTP Basic
    // (`base64(email:token)`): the connection stores `email:token`, resolveAuthHeader hands it
    // back as `Bearer email:token`, and we re-wrap it. But an OAuth connection's access token IS
    // a Bearer — pass it through unchanged (so Jira-over-OAuth keeps working).
    if (
      provider.authScheme === "basic" &&
      conn?.authMode !== "oauth" &&
      authHeaders.Authorization
    ) {
      const raw = authHeaders.Authorization.replace(/^Bearer\s+/i, "");
      authHeaders.Authorization = `Basic ${Buffer.from(raw).toString("base64")}`;
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(provider.headers ?? {}),
      // Per-action header overrides (e.g. GitHub's diff media type) win over the provider
      // defaults but never over auth (auth is spread last so it can't be clobbered).
      ...(action?.headers ?? {}),
      ...authHeaders,
    };
    const init: RequestInit = { method: req.method, headers };
    if (req.method !== "GET" && req.body !== undefined) {
      init.body = JSON.stringify(req.body);
      headers["Content-Type"] = "application/json";
    }

    const checked = await __httpDeps.assertEgressAllowed(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_HTTP_TIMEOUT_MS);
    let res: Response;
    try {
      res = await __httpDeps.fetch(checked, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    let body: unknown = raw;
    if (contentType.includes("json")) {
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = raw; // malformed JSON — hand back the text rather than failing
      }
    }

    // A side-effecting WRITE action that comes back non-2xx FAILS the node loudly — a POST
    // that didn't happen must not read as success by handing back the error body as "output"
    // (which silently buries e.g. a 404). READ actions still RETURN the status so a graph can
    // branch on it (a 404 "not found" is a meaningful read result). Writes are at-most-once, so
    // a clean non-retryable failure can't double-post. The message carries the resolved path
    // (owner/repo/number — no secrets; auth lives in headers) so the cause is diagnosable, plus
    // a GitHub-specific hint: GitHub returns 404/403 when a token can't see a PRIVATE repo — the
    // most common cause of a "correct endpoint but 404" write.
    if (action?.write && !res.ok) {
      const detail =
        body && typeof body === "object" && "message" in body
          ? String((body as { message: unknown }).message)
          : typeof body === "string" && body.length > 0
            ? body.slice(0, 200)
            : res.statusText;
      const hint =
        cfg.provider === "github" && (res.status === 404 || res.status === 403)
          ? " — GitHub returns 404/403 when the connection's token lacks access to a (private) repo; check the token has repo / issues:write scope on this repository, or verify the resolved owner/repo/number."
          : "";
      throw ApplicationFailure.nonRetryable(
        `integration '${cfg.provider}.${cfg.action}' failed: ${res.status} ${detail} [${req.method} ${req.path}]${hint}`,
        "INTEGRATION_WRITE_FAILED",
        { httpStatus: res.status },
      );
    }
    // Offload a large response so it can't blow Temporal's ~2MB payload cap (like httpRequest);
    // the interpreter resolves the claim-check back before a downstream node reads it.
    body = await maybeOffload(body, getObjectStore(), {
      keyPrefix: `integration/${meta.tenantId}`,
    });
    log.info(
      {
        activity: "callIntegration",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        provider: cfg.provider,
        action: cfg.action,
        method: req.method,
        path: loggedPath,
        httpStatus: res.status,
        ok: res.ok,
        durationMs: Math.round(secondsSince(startedAt) * 1000),
      },
      "integration call completed",
    );
    activityRuns.inc({ activity: "callIntegration", outcome: "ok" });
    activityDuration.observe(
      { activity: "callIntegration" },
      secondsSince(startedAt),
    );
    return { status: "ok", httpStatus: res.status, ok: res.ok, body };
  } catch (e) {
    activityRuns.inc({ activity: "callIntegration", outcome: "error" });
    // Log the failure with call context (the logger scrubs; no secrets/bodies) so an
    // integration error — the 404/403 write-fail, a transient network error — is visible.
    log.warn(
      {
        activity: "callIntegration",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        provider: cfg.provider,
        action: cfg.action,
        method: req.method,
        path: loggedPath,
        durationMs: Math.round(secondsSince(startedAt) * 1000),
        err: e instanceof Error ? e.message : String(e),
      },
      "integration call failed",
    );
    // Our own typed failures (e.g. INTEGRATION_WRITE_FAILED) are already sanitized +
    // carry the right retryability — rethrow as-is, never re-wrap them as retryable.
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof AuthConfigError) {
      // Platform misconfig (e.g. GitHub App env unset) — retrying can't fix it.
      throw ApplicationFailure.nonRetryable(e.message, "AUTH_NOT_CONFIGURED");
    }
    if (e instanceof NeedsReauthError) {
      throw ApplicationFailure.nonRetryable(
        "Connection needs re-authorization",
        "CONNECTION_REAUTH",
        { connectionId: cfg.connectionId },
      );
    }
    if (e instanceof MissingConnectionTokenError) {
      throw ApplicationFailure.nonRetryable(
        `integration '${cfg.provider}': connection '${cfg.connectionId}' has no token`,
        "INTEGRATION_NO_TOKEN",
      );
    }
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(
        "integration target blocked by egress policy (cloud hosts only)",
        "INTEGRATION_EGRESS_BLOCKED",
      );
    }
    // Transient — sanitized retryable (the interpreter runs WRITE actions at-most-once).
    throw toSanitizedRetryable(e, "INTEGRATION_TRANSIENT");
  }
}
