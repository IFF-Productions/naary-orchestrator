// httpRequest + graphql nodes — the hardened HTTP machinery (SSRF egress guard,
// in-activity auth + $secrets resolution, pagination, claim-check offload).
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import { getByPath } from "@naary/dsl";
import type { ResolvedGraphQL } from "@naary/dsl";
import {
  AuthConfigError,
  BlockedEgressError,
  ConnectionService,
  MissingConnectionTokenError,
  NeedsReauthError,
  assertEgressAllowed,
  resolveAuthHeader,
  safeFetch,
} from "@naary/connections";
import {
  hasSecretRef,
  hasSecretRefDeep,
  resolveSecretsDeep,
  resolveSecretsInString,
} from "@naary/secrets";
import {
  getObjectStore,
  maybeOffload,
  resolveClaimChecks,
} from "@naary/storage";
import {
  activityDuration,
  activityRuns,
  runCostUsd,
  secondsSince,
} from "../../metrics";
import {
  type AgentMeta,
  getSecretStore,
  makeSecretResolver,
  toSanitizedRetryable,
} from "./shared";

// Activities run in the worker PROCESS (a side-effect zone), so structured
// logging is fine here — unlike workflows.ts, which must stay deterministic.
// Logs carry execution-correlated ids (executionId/nodeId/tenantId) and token/
// cost numbers only — never prompts, completions, or keys (the logger scrubs).
const log = createLogger({ component: "worker" });

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
/** Hard cap on the per-request deadline. MUST stay below the callHttpRequest
 *  proxy's startToCloseTimeout (150s) so the AbortController — not Temporal — is
 *  the real deadline; otherwise a slow request would be killed + RETRIED (Temporal),
 *  duplicating non-idempotent writes. */
const MAX_HTTP_TIMEOUT_MS = 120_000;

/** A resolved HTTP request (bindings already applied by the interpreter). Mirrors
 *  @naary/dsl's ResolvedHttpRequest — kept independent so workflow↔activity stays
 *  type-only. NO secrets: the auth header is attached here, from `connectionId`. */
export interface HttpRequestConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  connectionId?: string;
  failOnErrorStatus?: boolean;
  timeoutMs?: number;
  costUsd?: number;
  /** Auto-follow pages (mirrors @naary/dsl's HttpPaginationConfig); the loop runs
   *  entirely in this activity so the workflow stays deterministic. */
  pagination?: {
    mode: "cursor" | "page" | "url";
    itemsPath?: string;
    cursorPath?: string;
    cursorParam?: string;
    pageParam?: string;
    startPage?: number;
    nextUrlPath?: string;
    stopOnEmpty?: boolean;
    maxPages?: number;
  };
}

export interface HttpRequestResult {
  status: "ok";
  /** HTTP response status code — the graph branches on this (e.g. status gt 399).
   *  When paginating, the status of the LAST page fetched. */
  httpStatus: number;
  headers: Record<string, string>;
  body: unknown;
  /** Metered cost of this call — the workflow accumulates it (Arch§4.6). */
  costUsd: number;
  /** Pages fetched when paginating (absent for a single request). */
  pages?: number;
}

/** Test seam: the network call + connection/egress resolution, swappable in tests. */
export const __httpDeps = {
  // SSRF-hardened (see safeFetch): validates every redirect hop at connect time and
  // pins the checked IP, so a public URL can't redirect/rebind into internal hosts.
  fetch: (url: string | URL, init?: RequestInit): Promise<Response> =>
    safeFetch(String(url), init as never) as unknown as Promise<Response>,
  resolveAuthHeader,
  assertEgressAllowed,
  // The connection's site URL (base for connection-based providers like Jira) + its authMode
  // (so a "basic"-scheme provider keeps Bearer for OAuth and only Basic-wraps a token).
  getConnection: async (
    tenantId: string,
    connectionId: string,
  ): Promise<{ serverUrl: string; authMode: string } | null> => {
    const conn = await new ConnectionService().getById(tenantId, connectionId);
    return conn ? { serverUrl: conn.serverUrl, authMode: conn.authMode } : null;
  },
  // Environment Secrets ($secrets): decrypt one named secret for a run's env (in-memory only).
  // Null = not configured. Swappable so tests never touch the encrypted store.
  getSecret: (
    tenantId: string,
    environmentId: string,
    name: string,
  ): Promise<string | null> =>
    getSecretStore().get(tenantId, environmentId, `secret:${name}`),
};

/**
 * Resolve `{{ $secrets.NAME }}` tokens in the HTTP node's static headers AND request body, in-memory,
 * right before the request (Tier-1 §4 — the value never crosses the workflow boundary; the workflow
 * left these tokens literal). Slice 2 covers headers + body (the two places auth material belongs);
 * url/query stay unsupported (a secret in a URL leaks to server/proxy logs + can be echoed in an
 * error body — bad practice regardless). Returns:
 *  - `headers` / `body` with secrets inlined,
 *  - `secretKeys`: lower-cased header keys a secret went into (dropped cross-origin, like conn auth),
 *  - `bodyHasSecret`: whether the body carries a secret (dropped cross-origin too).
 * One memoized resolver is shared across headers + body, so a secret used in both is fetched once.
 * A missing secret is a non-retryable failure naming only the NAME.
 */
async function resolveHttpSecrets(
  headers: Record<string, string>,
  body: unknown,
  meta: AgentMeta,
): Promise<{
  headers: Record<string, string>;
  body: unknown;
  secretKeys: Set<string>;
  bodyHasSecret: boolean;
}> {
  const headerEntries = Object.entries(headers);
  const headerNeeds = headerEntries.some(
    ([, v]) => typeof v === "string" && hasSecretRef(v),
  );
  const bodyNeeds = hasSecretRefDeep(body);
  if (!headerNeeds && !bodyNeeds) {
    return { headers, body, secretKeys: new Set(), bodyHasSecret: false };
  }
  const resolveOne = makeSecretResolver(meta, __httpDeps.getSecret);
  const outHeaders: Record<string, string> = {};
  const secretKeys = new Set<string>();
  for (const [k, v] of headerEntries) {
    if (typeof v === "string" && hasSecretRef(v)) {
      outHeaders[k] = await resolveSecretsInString(v, resolveOne);
      secretKeys.add(k.toLowerCase());
    } else {
      outHeaders[k] = v;
    }
  }
  const outBody = bodyNeeds ? await resolveSecretsDeep(body, resolveOne) : body;
  return {
    headers: outHeaders,
    body: outBody,
    secretKeys,
    bodyHasSecret: bodyNeeds,
  };
}

/**
 * HTTP Request node: call a plain HTTP/REST endpoint and return the structured
 * response so the graph can branch on `.httpStatus`. Auth (if any) is resolved
 * from `connectionId` IN-ACTIVITY — the token never crosses the workflow boundary.
 *
 * Behavior contract: a non-2xx response is NOT an error by default — it's returned
 * for the graph to branch on. Only transport/DNS/timeout failures throw (retryable);
 * a blocked egress target (SSRF guard) throws non-retryable. `failOnErrorStatus`
 * opts a flow into a hard non-retryable fail on status ≥ 400.
 */
export async function callHttpRequest(
  cfg: HttpRequestConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<HttpRequestResult> {
  void input; // entry-node input flows via bindings, not directly into the request
  const startedAt = process.hrtime.bigint();
  let host = "unknown";
  try {
    const store = getObjectStore();

    // Auth comes ONLY from the connection, resolved in-memory here (never in config,
    // never in workflow history). Static config headers are non-secret; the auth
    // header takes precedence over any same-named static header.
    const authHeaders = cfg.connectionId
      ? await __httpDeps.resolveAuthHeader(meta.tenantId, cfg.connectionId)
      : {};
    // A claim-checked upstream value (e.g. a large bound body) is resolved back to
    // its real value before the call — the workflow only carried the small reference.
    const claimResolvedBody = await resolveClaimChecks(cfg.body, store);

    // Resolve `{{ $secrets.NAME }}` in the static headers AND body in-memory (Tier-1 §4).
    // `secretKeys` (header keys) + `bodyHasSecret` drive the cross-origin drop below, so a secret
    // never rides to a response-driven next-URL host — same treatment as the connection auth header.
    const {
      headers: staticHeaders,
      body: resolvedBody,
      secretKeys,
      bodyHasSecret,
    } = await resolveHttpSecrets(cfg.headers ?? {}, claimResolvedBody, meta);
    const headers: Record<string, string> = {
      ...staticHeaders,
      ...authHeaders,
    };

    const init: RequestInit = { method: cfg.method, headers };
    if (cfg.method !== "GET" && resolvedBody !== undefined) {
      if (typeof resolvedBody === "string") {
        init.body = resolvedBody;
      } else {
        init.body = JSON.stringify(resolvedBody);
        if (!("content-type" in mapKeysLower(headers))) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    // The connection-derived auth header must NEVER ride to a different host. A
    // paginated `url`-mode `next` URL comes from the (untrusted) response body, so a
    // cross-origin next page gets the static, non-secret headers only — mirroring how
    // browsers/curl drop `Authorization` across origins (Tier-1 rule 4).
    // Cross-origin drop set = connection auth keys ∪ the keys we injected a $secret into. A
    // response-driven `url`-mode next page can point at an attacker host, so NEITHER a connection
    // token NOR a $secret may ride to a different origin (Tier-1 §4; mirrors how browsers/curl drop
    // Authorization cross-origin).
    const sensitiveKeys = new Set([
      ...Object.keys(authHeaders).map((k) => k.toLowerCase()),
      ...secretKeys,
    ]);
    const headersNoAuth: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!sensitiveKeys.has(k.toLowerCase())) headersNoAuth[k] = v;
    }
    const originOf = (u: string): string | null => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    };
    const baseOrigin = originOf(cfg.url);

    const timeoutMs = Math.min(
      cfg.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
      MAX_HTTP_TIMEOUT_MS,
    );

    // One page fetch. The egress guard runs on EVERY page URL — a response-supplied
    // `next` URL (url mode) is attacker-influenceable, so pagination can never escape
    // the https-and-public-host SSRF check. Bound each request with the deadline too.
    const fetchPage = async (
      reqUrl: string,
      reqQuery: Record<string, string>,
      useHeaders: Record<string, string> = headers,
      useBody: RequestInit["body"] = init.body,
    ): Promise<{
      res: Response;
      body: unknown;
      responseHeaders: Record<string, string>;
    }> => {
      let rawUrl = reqUrl;
      const qs = new URLSearchParams(reqQuery).toString();
      if (qs) rawUrl += (rawUrl.includes("?") ? "&" : "?") + qs;
      const url = await __httpDeps.assertEgressAllowed(rawUrl);
      host = url.host;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await __httpDeps.fetch(url, {
          ...init,
          headers: useHeaders,
          body: useBody,
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
      // Drop response-side credentials (Set-Cookie) before the headers land in ctx →
      // Temporal history. The rest (content-type, etc.) is useful for branching.
      const responseHeaders: Record<string, string> = {};
      for (const [k, v] of res.headers.entries()) {
        if (k.toLowerCase() === "set-cookie") continue;
        responseHeaders[k] = v;
      }
      return { res, body, responseHeaders };
    };

    // `failOnErrorStatus` opts a flow into a hard non-retryable fail on status ≥ 400.
    const checkStatus = (status: number): void => {
      if (cfg.failOnErrorStatus && status >= 400) {
        throw ApplicationFailure.nonRetryable(
          `HTTP request returned status ${status}`,
          "HTTP_ERROR_STATUS",
          { httpStatus: status },
        );
      }
    };

    const finish = (
      httpStatus: number,
      responseHeaders: Record<string, string>,
      body: unknown,
      cost: number,
      pages?: number,
    ): HttpRequestResult => {
      log.info(
        {
          activity: "callHttpRequest",
          executionId: meta.executionId,
          nodeId: meta.nodeId,
          tenantId: meta.tenantId,
          method: cfg.method,
          host,
          httpStatus,
          costUsd: cost,
          ...(pages !== undefined ? { pages } : {}),
        },
        "http request completed",
      );
      activityRuns.inc({ activity: "callHttpRequest", outcome: "ok" });
      activityDuration.observe(
        { activity: "callHttpRequest" },
        secondsSince(startedAt),
      );
      if (cost > 0) runCostUsd.inc(cost);
      return {
        status: "ok",
        httpStatus,
        headers: responseHeaders,
        body,
        costUsd: cost,
        ...(pages !== undefined ? { pages } : {}),
      };
    };

    const pg = cfg.pagination;
    if (!pg) {
      const { res, body, responseHeaders } = await fetchPage(
        cfg.url,
        cfg.query ?? {},
      );
      checkStatus(res.status);
      // Offload a large body so it can't blow Temporal's ~2MB payload cap (Arch§4.6).
      const offloaded = await maybeOffload(body, store, {
        keyPrefix: `http/${meta.tenantId}`,
      });
      return finish(res.status, responseHeaders, offloaded, cfg.costUsd ?? 0);
    }

    // --- Paginated: fetch pages until a stop condition; `body` is the accumulated
    // items array. The whole loop is in this activity, so the workflow is unaffected. ---
    const maxPages = Math.min(Math.max(pg.maxPages ?? 10, 1), 100);
    const stopOnEmpty = pg.stopOnEmpty ?? true;
    const items: unknown[] = [];
    let cursor: unknown;
    let nextUrl: string | undefined;
    let page = pg.startPage ?? 1;
    let lastStatus = 0;
    let lastHeaders: Record<string, string> = {};
    let pages = 0;

    while (pages < maxPages) {
      let reqUrl: string;
      let reqQuery: Record<string, string>;
      // Same-origin pages carry the auth header + secret body; a cross-origin `url`-mode next page
      // gets the non-secret headers only AND drops a secret-bearing body — never leak a connection
      // token OR a $secret off-host (the body is re-sent every page since `init` is shared).
      let reqHeaders = headers;
      let reqBody = init.body;
      if (pg.mode === "url" && pages > 0) {
        // A response-supplied next URL is already complete — don't re-append query.
        reqUrl = nextUrl as string;
        reqQuery = {};
        if (baseOrigin === null || originOf(reqUrl) !== baseOrigin) {
          reqHeaders = headersNoAuth;
          // `null` (not `undefined`) — an explicit "no body"; passing undefined would trip
          // fetchPage's `= init.body` default and re-send the secret body.
          if (bodyHasSecret) reqBody = null;
        }
      } else {
        reqUrl = cfg.url;
        reqQuery = { ...(cfg.query ?? {}) };
        if (pg.mode === "page") reqQuery[pg.pageParam ?? "page"] = String(page);
        if (pg.mode === "cursor" && cursor != null)
          reqQuery[pg.cursorParam ?? "cursor"] = String(cursor);
      }

      const { res, body, responseHeaders } = await fetchPage(
        reqUrl,
        reqQuery,
        reqHeaders,
        reqBody,
      );
      pages++; // count every fetch performed (drives the page count + per-page cost)
      checkStatus(res.status);
      lastStatus = res.status;
      lastHeaders = responseHeaders;

      const raw = pg.itemsPath ? getByPath(body, pg.itemsPath) : body;
      const pageItems = Array.isArray(raw) ? raw : [];
      // Append without spreading (a huge page would overflow the arg stack).
      for (const it of pageItems) items.push(it);
      if (stopOnEmpty && pageItems.length === 0) break;

      if (pg.mode === "cursor") {
        const c = pg.cursorPath ? getByPath(body, pg.cursorPath) : undefined;
        if (c == null || c === "") break;
        cursor = c;
      } else if (pg.mode === "url") {
        const nu = pg.nextUrlPath ? getByPath(body, pg.nextUrlPath) : undefined;
        if (nu == null || nu === "") break;
        nextUrl = String(nu);
      } else {
        page++;
      }
    }

    const offloaded = await maybeOffload(items, store, {
      keyPrefix: `http/${meta.tenantId}`,
    });
    // Each page is a real HTTP call → meter the flat cost per page.
    return finish(
      lastStatus,
      lastHeaders,
      offloaded,
      (cfg.costUsd ?? 0) * pages,
      pages,
    );
  } catch (e) {
    activityRuns.inc({ activity: "callHttpRequest", outcome: "error" });
    activityDuration.observe(
      { activity: "callHttpRequest" },
      secondsSince(startedAt),
    );
    // Our own deliberate failures (HTTP_ERROR_STATUS) are already safe — pass through.
    if (e instanceof ApplicationFailure) throw e;
    // A blocked egress target is a misconfiguration (SSRF guard) — retrying the same
    // URL won't help, so fail non-retryable (mirrors the mcpTool handling).
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(
        "Request target is not allowed",
        "BLOCKED_EGRESS",
        { host },
      );
    }
    if (e instanceof AuthConfigError) {
      throw ApplicationFailure.nonRetryable(e.message, "AUTH_NOT_CONFIGURED");
    }
    if (
      e instanceof MissingConnectionTokenError ||
      e instanceof NeedsReauthError
    ) {
      throw ApplicationFailure.nonRetryable(
        "Connection needs re-authorization",
        "CONNECTION_REAUTH",
        { connectionId: cfg.connectionId },
      );
    }
    // Transient (network blip, DNS, abort/timeout): sanitized retryable so a request
    // object carrying the auth header can't be serialized into history.
    throw toSanitizedRetryable(e, "HTTP_TRANSIENT");
  }
}

export interface GraphQLResult {
  status: "ok";
  /** HTTP status of the POST (GraphQL usually 200 even on errors). Edges may branch on it. */
  httpStatus: number;
  /** The `data` field of the response (a claim-check reference if large). */
  data: unknown;
  /** The `errors` array (GraphQL returns 200-with-errors), or null when there were none. */
  errors: unknown;
  /** Metered per-call cost — the workflow accumulates it (Arch§4.6). */
  costUsd: number;
}

/**
 * GraphQL node: POST `{ query, variables }` to a GraphQL endpoint and return `{ data, errors,
 * httpStatus }`. A thin node over the SAME hardened HTTP machinery as callHttpRequest — it reuses
 * the SSRF egress guard (`__httpDeps.assertEgressAllowed`), the safe fetch (`__httpDeps.fetch`), the
 * in-activity `$secrets` resolution (`resolveHttpSecrets` over headers + variables), and the
 * claim-check offload (`maybeOffload`) — dropping only pagination + cross-origin (a single POST).
 * `$secrets` values are resolved in memory here and NEVER cross the workflow boundary (Tier-1 §4).
 */
export async function callGraphQL(
  cfg: ResolvedGraphQL,
  input: unknown,
  meta: AgentMeta,
): Promise<GraphQLResult> {
  void input; // variables carry upstream data via bindings, not the raw entry input
  const startedAt = process.hrtime.bigint();
  let host = "unknown";
  try {
    const store = getObjectStore();
    // Resolve `{{ $secrets.NAME }}` in headers AND variables in-memory (Tier-1 §4 — the workflow left
    // them literal). Reuse the httpRequest resolver (headers flat + variables deep); GraphQL has no
    // pagination, so its cross-origin tracking fields are unused.
    const { headers: secretHeaders, body: resolvedVariables } =
      await resolveHttpSecrets(cfg.headers ?? {}, cfg.variables ?? {}, meta);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...secretHeaders,
    };
    const body = JSON.stringify({
      query: cfg.query,
      variables: resolvedVariables ?? {},
    });
    const timeoutMs = Math.min(
      cfg.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
      MAX_HTTP_TIMEOUT_MS,
    );
    const url = await __httpDeps.assertEgressAllowed(cfg.url);
    host = url.host;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await __httpDeps.fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const raw = await res.text();
    let parsed: { data?: unknown; errors?: unknown };
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      // A GraphQL endpoint always speaks JSON — non-JSON (an HTML proxy/error page) is a
      // misconfiguration, not a transient blip, so don't burn retries.
      throw ApplicationFailure.nonRetryable(
        `GraphQL endpoint returned a non-JSON response (status ${res.status})`,
        "GRAPHQL_BAD_RESPONSE",
        { httpStatus: res.status },
      );
    }
    const errors = parsed.errors ?? null;
    if (cfg.failOnErrors && Array.isArray(errors) && errors.length > 0) {
      throw ApplicationFailure.nonRetryable(
        `GraphQL returned ${errors.length} error(s)`,
        "GRAPHQL_ERROR",
        { httpStatus: res.status },
      );
    }
    // Offload large `data` to object storage (claim-check) so it can't blow the ~2MB history cap.
    const data = await maybeOffload(parsed.data ?? null, store, {
      keyPrefix: `graphql/${meta.tenantId}`,
    });
    const cost = cfg.costUsd ?? 0;
    log.info(
      {
        activity: "callGraphQL",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        host,
        httpStatus: res.status,
        costUsd: cost,
      },
      "graphql request completed",
    );
    activityRuns.inc({ activity: "callGraphQL", outcome: "ok" });
    activityDuration.observe(
      { activity: "callGraphQL" },
      secondsSince(startedAt),
    );
    if (cost > 0) runCostUsd.inc(cost);
    return {
      status: "ok",
      httpStatus: res.status,
      data,
      errors,
      costUsd: cost,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callGraphQL", outcome: "error" });
    activityDuration.observe(
      { activity: "callGraphQL" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(
        "Request target is not allowed",
        "BLOCKED_EGRESS",
        { host },
      );
    }
    // Transient (network blip, DNS, abort/timeout): sanitized retryable — a request object
    // carrying an auth header must not be serialized into history.
    throw toSanitizedRetryable(e, "GRAPHQL_TRANSIENT");
  }
}

/** Lower-case header keys for case-insensitive presence checks (HTTP is case-insensitive). */
function mapKeysLower(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
  return out;
}
