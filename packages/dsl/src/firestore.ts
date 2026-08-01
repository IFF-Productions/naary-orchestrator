import { getByPath, hasForbiddenPathSegment } from "./mcp-args";
import type {
  FirestoreQueryNodeConfig,
  FirestoreWriteNodeConfig,
} from "./types";

/**
 * The plain object the `callFirestoreQuery` activity receives, after binding resolution.
 * NO secrets — the Google OAuth token is resolved from `connectionId` inside the activity.
 */
export interface ResolvedFirestoreQuery {
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

/** The plain object the `callFirestoreWrite` activity receives. */
export interface ResolvedFirestoreWrite {
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

/**
 * Set a value at a dotted path, creating intermediate objects. Mutates `root` (callers
 * pass a fresh copy). Mirrors the httpRequest/graphQL resolvers.
 */
function setByPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (hasForbiddenPathSegment(path)) return; // #591: never walk/assign prototype-chain keys
  const keys = path.split(".");
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i] as string;
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1] as string] = value;
}

/**
 * Resolve a firestoreQuery node's concrete request from the run context.
 *
 * Pure + deterministic (ctx path-reads only, no I/O), so it runs in the interpreter —
 * CLAUDE.md rule 2. A binding may fill `documentId`, `projectId`, `collection`, a filter
 * value (`filters.0.value`), etc.; nothing here talks to Firestore.
 */
export function resolveFirestoreQuery(
  config: FirestoreQueryNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedFirestoreQuery {
  const resolved: Record<string, unknown> = {
    connectionId: config.connectionId,
    action: config.action ?? "get",
    projectId: config.projectId,
    databaseId: config.databaseId,
    collection: config.collection,
    documentId: config.documentId,
    filters: config.filters
      ? JSON.parse(JSON.stringify(config.filters))
      : undefined,
    orderBy: config.orderBy
      ? JSON.parse(JSON.stringify(config.orderBy))
      : undefined,
    limit: config.limit,
    maxPages: config.maxPages,
    typedValues: config.typedValues,
    timeoutMs: config.timeoutMs,
    costUsd: config.costUsd,
  };
  for (const [path, binding] of Object.entries(config.argumentBindings ?? {})) {
    setByPath(resolved, path, getByPath(ctx[binding.from], binding.path));
  }
  return resolved as unknown as ResolvedFirestoreQuery;
}

/**
 * Resolve a firestoreWrite node's concrete request from the run context.
 *
 * A binding path is relative to the RESOLVED object, so `data.name` fills a document
 * field and `documentId` fills the id — the same shape the httpRequest node uses for
 * `body.*`, so an author who knows one knows the other.
 */
export function resolveFirestoreWrite(
  config: FirestoreWriteNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedFirestoreWrite {
  const resolved: Record<string, unknown> = {
    connectionId: config.connectionId,
    action: config.action ?? "set",
    projectId: config.projectId,
    databaseId: config.databaseId,
    collection: config.collection,
    documentId: config.documentId,
    // Deep-copied so a binding can never mutate the saved graph's config object.
    data: config.data
      ? (JSON.parse(JSON.stringify(config.data)) as unknown)
      : {},
    updateMask: config.updateMask ? [...config.updateMask] : undefined,
    typedValues: config.typedValues,
    timeoutMs: config.timeoutMs,
    costUsd: config.costUsd,
  };
  for (const [path, binding] of Object.entries(config.argumentBindings ?? {})) {
    setByPath(resolved, path, getByPath(ctx[binding.from], binding.path));
  }
  return resolved as unknown as ResolvedFirestoreWrite;
}
