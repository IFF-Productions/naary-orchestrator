// firestoreQuery / firestoreWrite nodes — Cloud Firestore reads and at-most-once writes.
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import {
  BlockedEgressError,
  MissingConnectionTokenError,
  NeedsReauthError,
  assertEgressAllowed,
  resolveAuthHeader,
  safeFetch,
} from "@naary/connections";
import {
  DEFAULT_MAX_PAGES,
  FIRESTORE_BASE_URL,
  type FirestoreDocument,
  type FirestoreQuerySpec,
  type FirestoreReadAction,
  type FirestoreWriteAction,
  type FirestoreWriteSpec,
  FirestorePathError,
  FirestoreRequestError,
  FirestoreValueError,
  MAX_MAX_PAGES,
  buildQueryRequest,
  buildWriteRequest,
  isEmulatorBase,
  parseDocument,
  parseListResponse,
  parseRunQueryResponse,
  resolveEmulatorBaseUrl,
} from "@naary/firestore";
import { getObjectStore, maybeOffload } from "@naary/storage";
import {
  activityDuration,
  activityRuns,
  runCostUsd,
  secondsSince,
} from "../../metrics";
import { type AgentMeta } from "./shared";

const log = createLogger({ component: "worker" });

const DEFAULT_FIRESTORE_TIMEOUT_MS = 30_000;
/** Hard cap. MUST stay below the proxy's startToCloseTimeout so the HTTP call — not
 *  Temporal — is the deadline. */
const MAX_FIRESTORE_TIMEOUT_MS = 120_000;

/** A resolved firestoreQuery (bindings already applied by the interpreter). NO secrets:
 *  the Google OAuth token is read from the connection inside this activity. */
export interface FirestoreQueryConfig {
  connectionId: string;
  action: string;
  projectId: string;
  databaseId?: string;
  collection: string;
  documentId?: string;
  filters?: { field: string; op: string; value?: unknown }[];
  orderBy?: { field: string; direction?: string }[];
  limit?: number;
  maxPages?: number;
  typedValues?: boolean;
  timeoutMs?: number;
  costUsd?: number;
}

export interface FirestoreQueryResult {
  status: "ok";
  /** Decoded documents (a claim-check reference if large). The graph branches on `count`. */
  documents: unknown;
  count: number;
  /** True when a bound (limit / maxPages) stopped the read before the data ran out. */
  truncated: boolean;
  costUsd: number;
}

export interface FirestoreWriteConfig {
  connectionId: string;
  action: string;
  projectId: string;
  databaseId?: string;
  collection: string;
  documentId?: string;
  data: Record<string, unknown>;
  updateMask?: string[];
  typedValues?: boolean;
  timeoutMs?: number;
  costUsd?: number;
}

export interface FirestoreWriteResult {
  status: "ok";
  /** Full resource name of the written document ("" for a delete). */
  name: string;
  documentId: string;
  deleted: boolean;
  costUsd: number;
}

/** Test seam: auth + transport, swappable so tests need no Google project and no network. */
export const __firestoreDeps = {
  resolveAuthHeader,
  assertEgressAllowed,
  fetch: safeFetch,
  /** Read the emulator override from the WORKER PROCESS env only — never from tenant data. */
  emulatorHost: () => process.env.FIRESTORE_EMULATOR_HOST,
};

/**
 * The base URL for this call: the real Firestore, or a loopback emulator when the worker's
 * own environment says so. `resolveEmulatorBaseUrl` refuses any non-loopback value, so this
 * cannot be turned into an arbitrary-host redirect (see @naary/firestore/emulator).
 */
function resolveBaseUrl(): string {
  return (
    resolveEmulatorBaseUrl(__firestoreDeps.emulatorHost()) ?? FIRESTORE_BASE_URL
  );
}

/**
 * Auth header for a Firestore call.
 *
 * TIER-1 §4: the token is resolved from `connectionId` HERE, held in memory for this one
 * request, and never returned, logged or put in a span. Against the emulator no header is
 * sent at all — the emulator has no auth, and posting a real tenant token to it would be a
 * genuine credential leak.
 */
async function authHeaders(
  tenantId: string,
  connectionId: string,
  baseUrl: string,
): Promise<Record<string, string>> {
  if (isEmulatorBase(baseUrl)) return {};
  return __firestoreDeps.resolveAuthHeader(tenantId, connectionId);
}

const READ_ACTIONS: readonly FirestoreReadAction[] = ["get", "list", "query"];
const WRITE_ACTIONS: readonly FirestoreWriteAction[] = [
  "set",
  "create",
  "update",
  "delete",
];

/**
 * Narrow the author-supplied `action` string to the typed union.
 *
 * The graph carries `action` as a plain string, so this is the boundary where an
 * unrecognized value has to be rejected — with a message naming the valid actions,
 * rather than a cast that would let it fall through to a confusing Firestore 400.
 */
function readSpec(cfg: FirestoreQueryConfig): FirestoreQuerySpec {
  if (!READ_ACTIONS.includes(cfg.action as FirestoreReadAction)) {
    throw new FirestoreRequestError(
      `Unknown firestoreQuery action "${cfg.action}" — use ${READ_ACTIONS.join(", ")}`,
    );
  }
  return { ...cfg, action: cfg.action as FirestoreReadAction };
}

function writeSpec(cfg: FirestoreWriteConfig): FirestoreWriteSpec {
  if (!WRITE_ACTIONS.includes(cfg.action as FirestoreWriteAction)) {
    throw new FirestoreRequestError(
      `Unknown firestoreWrite action "${cfg.action}" — use ${WRITE_ACTIONS.join(", ")}`,
    );
  }
  return { ...cfg, action: cfg.action as FirestoreWriteAction };
}

/**
 * Issue one Firestore REST call.
 *
 * The host is FIXED (`firestore.googleapis.com`) rather than author-supplied, which makes
 * this simpler than the SQL node's case — but the URL still goes through
 * `assertEgressAllowed` + the guarded `safeFetch`, exactly like httpRequest/integration, so
 * there is one egress policy and no bespoke trust. The emulator base is loopback by
 * construction and would fail the public-address check, so it skips it deliberately.
 */
async function callFirestore(
  req: { method: string; url: string; body?: unknown },
  headers: Record<string, string>,
  timeoutMs: number,
  emulator: boolean,
): Promise<unknown> {
  if (!emulator) await __firestoreDeps.assertEgressAllowed(req.url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await __firestoreDeps.fetch(req.url, {
      method: req.method,
      headers: {
        ...headers,
        ...(req.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw firestoreHttpFailure(res.status, text);
    return text ? (JSON.parse(text) as unknown) : {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map a Firestore HTTP error to Temporal semantics.
 *
 * 401/403 is a bad or unscoped token — the user must fix the connection, so DON'T burn
 * retries on it (CLAUDE.md). 404/400/409 are deterministic. 429/5xx are genuinely
 * transient. The response body can echo back document contents, so only the status and
 * Google's short `status` code are surfaced — never the raw body.
 */
function firestoreHttpFailure(
  status: number,
  body: string,
): ApplicationFailure {
  let code = "";
  try {
    code = String(
      (JSON.parse(body) as { error?: { status?: unknown } })?.error?.status ??
        "",
    );
  } catch {
    /* a non-JSON error body tells us nothing extra */
  }
  const detail = code ? ` (${code})` : "";

  if (status === 401 || status === 403) {
    return ApplicationFailure.nonRetryable(
      `Firestore rejected the credential${detail} — reconnect the Firestore connection`,
      "CONNECTION_REAUTH",
    );
  }
  if (status === 404) {
    return ApplicationFailure.nonRetryable(
      `Firestore document or collection not found${detail}`,
      "FIRESTORE_NOT_FOUND",
    );
  }
  if (status === 429 || status >= 500) {
    return ApplicationFailure.retryable(
      `Firestore call failed transiently (HTTP ${status})`,
      "FIRESTORE_TRANSIENT",
    );
  }
  return ApplicationFailure.nonRetryable(
    `Firestore rejected the request (HTTP ${status})${detail}`,
    "FIRESTORE_REQUEST_ERROR",
  );
}

function timeoutFor(cfg: { timeoutMs?: number }): number {
  return Math.min(
    cfg.timeoutMs ?? DEFAULT_FIRESTORE_TIMEOUT_MS,
    MAX_FIRESTORE_TIMEOUT_MS,
  );
}

/** Shared error mapping for both activities. `nonRetryableOnly` is the at-most-once write. */
function toFailure(
  e: unknown,
  connectionId: string,
  nonRetryableOnly: boolean,
): ApplicationFailure {
  if (e instanceof ApplicationFailure) {
    // A write must never be retried, even for an otherwise-transient cause.
    if (nonRetryableOnly && !e.nonRetryable) {
      return ApplicationFailure.nonRetryable(
        e.message,
        e.type ?? "FIRESTORE_ERROR",
        {
          connectionId,
        },
      );
    }
    return e;
  }
  if (e instanceof BlockedEgressError) {
    return ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED", {
      connectionId,
    });
  }
  if (
    e instanceof MissingConnectionTokenError ||
    e instanceof NeedsReauthError
  ) {
    return ApplicationFailure.nonRetryable(
      "Connection needs re-authorization",
      "CONNECTION_REAUTH",
      { connectionId },
    );
  }
  // A bad path/value/action is the author's config — the same call fails the same way.
  if (
    e instanceof FirestorePathError ||
    e instanceof FirestoreRequestError ||
    e instanceof FirestoreValueError
  ) {
    return ApplicationFailure.nonRetryable(
      e.message,
      "FIRESTORE_CONFIG_ERROR",
      {
        connectionId,
      },
    );
  }
  if (nonRetryableOnly) {
    return ApplicationFailure.nonRetryable(
      "Firestore write failed",
      "FIRESTORE_WRITE_FAILED",
      { connectionId },
    );
  }
  return ApplicationFailure.retryable(
    "Firestore call failed transiently",
    "FIRESTORE_TRANSIENT",
    { connectionId },
  );
}

/**
 * firestoreQuery node: read Cloud Firestore and return PLAIN JSON documents.
 *
 * Bounded on purpose. A collection can hold millions of documents, so `limit` caps the
 * documents and `maxPages` caps the `list` page walk — and when a bound stops the read, the
 * node says so in its OUTPUT (`truncated: true`) rather than quietly returning a short
 * list. A graph can branch on that; it cannot branch on a log line.
 */
export async function callFirestoreQuery(
  cfg: FirestoreQueryConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<FirestoreQueryResult> {
  void input; // entry-node input flows via bindings, not directly into the query
  const startedAt = process.hrtime.bigint();
  try {
    const baseUrl = resolveBaseUrl();
    const emulator = isEmulatorBase(baseUrl);
    const headers = await authHeaders(meta.tenantId, cfg.connectionId, baseUrl);
    const timeoutMs = timeoutFor(cfg);

    let documents: FirestoreDocument[] = [];
    let truncated = false;

    if (cfg.action === "get") {
      const raw = await callFirestore(
        buildQueryRequest(readSpec(cfg), baseUrl),
        headers,
        timeoutMs,
        emulator,
      );
      documents = [parseDocument(raw as Parameters<typeof parseDocument>[0])];
    } else if (cfg.action === "query") {
      const raw = await callFirestore(
        buildQueryRequest(readSpec(cfg), baseUrl),
        headers,
        timeoutMs,
        emulator,
      );
      documents = parseRunQueryResponse(raw);
      // runQuery applies `limit` server-side, so a full page means there may be more.
      truncated = documents.length >= (buildLimit(cfg) ?? 0);
    } else {
      // list — walk pages up to maxPages, then stop and SAY we stopped.
      const maxPages = Math.max(
        1,
        Math.min(cfg.maxPages ?? DEFAULT_MAX_PAGES, MAX_MAX_PAGES),
      );
      let pageToken: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const raw = await callFirestore(
          buildQueryRequest(readSpec(cfg), baseUrl, pageToken),
          headers,
          timeoutMs,
          emulator,
        );
        const parsed = parseListResponse(raw);
        documents = documents.concat(parsed.documents);
        pageToken = parsed.nextPageToken;
        if (!pageToken) break;
      }
      // Firestore still had more to give when we hit the page bound.
      truncated = Boolean(pageToken);
    }

    const count = documents.length;
    // Offload a large result set so it can't blow Temporal's ~2MB payload cap.
    const payload = await maybeOffload(documents, getObjectStore(), {
      keyPrefix: `firestore/${meta.tenantId}`,
    });

    log.info(
      {
        activity: "callFirestoreQuery",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        action: cfg.action,
        connectionId: cfg.connectionId,
        count,
        truncated,
        costUsd: cfg.costUsd ?? 0,
      },
      "firestore query completed",
    );
    activityRuns.inc({ activity: "callFirestoreQuery", outcome: "ok" });
    activityDuration.observe(
      { activity: "callFirestoreQuery" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);

    return {
      status: "ok",
      documents: payload,
      count,
      truncated,
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callFirestoreQuery", outcome: "error" });
    activityDuration.observe(
      { activity: "callFirestoreQuery" },
      secondsSince(startedAt),
    );
    throw toFailure(e, cfg.connectionId, false);
  }
}

/** The effective document cap the request builder will apply. */
function buildLimit(cfg: FirestoreQueryConfig): number {
  const DEFAULT = 100;
  const MAX = 1000;
  const n =
    typeof cfg.limit === "number" && Number.isFinite(cfg.limit)
      ? Math.floor(cfg.limit)
      : DEFAULT;
  return Math.max(1, Math.min(n, MAX));
}

/**
 * firestoreWrite node: write ONE Firestore document from PLAIN JSON.
 *
 * Registered AT-MOST-ONCE (retry: 1), exactly like callSqlExec: `create` assigns a
 * server-side id, so a retry would create a SECOND document. Every error is therefore
 * non-retryable here.
 */
export async function callFirestoreWrite(
  cfg: FirestoreWriteConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<FirestoreWriteResult> {
  void input;
  const startedAt = process.hrtime.bigint();
  try {
    const baseUrl = resolveBaseUrl();
    const emulator = isEmulatorBase(baseUrl);
    const headers = await authHeaders(meta.tenantId, cfg.connectionId, baseUrl);

    const raw = await callFirestore(
      buildWriteRequest(writeSpec(cfg), baseUrl),
      headers,
      timeoutFor(cfg),
      emulator,
    );

    const deleted = cfg.action === "delete";
    const doc = deleted
      ? { name: "", id: cfg.documentId ?? "" }
      : parseDocument(raw as Parameters<typeof parseDocument>[0]);

    log.info(
      {
        activity: "callFirestoreWrite",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        action: cfg.action,
        connectionId: cfg.connectionId,
        // The document id is graph metadata, not content — the DATA is never logged.
        documentId: doc.id,
        costUsd: cfg.costUsd ?? 0,
      },
      "firestore write completed",
    );
    activityRuns.inc({ activity: "callFirestoreWrite", outcome: "ok" });
    activityDuration.observe(
      { activity: "callFirestoreWrite" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);

    return {
      status: "ok",
      name: doc.name,
      documentId: doc.id,
      deleted,
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callFirestoreWrite", outcome: "error" });
    activityDuration.observe(
      { activity: "callFirestoreWrite" },
      secondsSince(startedAt),
    );
    throw toFailure(e, cfg.connectionId, true);
  }
}
