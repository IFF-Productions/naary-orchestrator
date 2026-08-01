/**
 * Firestore REST request building + response parsing.
 *
 * PURE by design: this module decides *what* call to make and *how to read the answer*,
 * but never makes it. The worker activity performs the fetch through the repo's guarded
 * `safeFetch`, so egress policy stays in one place — and every branch here is testable
 * with no network and no Google project.
 */
import {
  type EncodeOptions,
  type FirestoreValue,
  decodeFields,
  encodeFields,
  encodeValue,
} from "./value";
import {
  type FirestoreTarget,
  FirestorePathError,
  collectionPath,
  documentPath,
  queryParent,
} from "./path";

/** The public Firestore REST endpoint. A FIXED host — never author-supplied. */
export const FIRESTORE_BASE_URL = "https://firestore.googleapis.com";

/** Default / maximum documents returned by one firestoreQuery node. */
export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1000;
/** Default / maximum pages a `list` will walk (mirrors the httpRequest node's bound). */
export const DEFAULT_MAX_PAGES = 10;
export const MAX_MAX_PAGES = 100;

/** A request the activity should issue. `body` is already Firestore-shaped. */
export interface FirestoreHttpRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Absolute URL, built from a fixed base + validated, encoded path segments. */
  url: string;
  body?: unknown;
}

export type FirestoreReadAction = "get" | "list" | "query";
export type FirestoreWriteAction = "set" | "create" | "update" | "delete";

/** A `where` clause. `field` is a Firestore field path (`a.b`), not a URL segment. */
export interface FirestoreFilter {
  field: string;
  op: string;
  value?: unknown;
}

export interface FirestoreOrderBy {
  field: string;
  direction?: string;
}

export interface FirestoreQuerySpec extends FirestoreTarget {
  action: FirestoreReadAction;
  filters?: FirestoreFilter[];
  orderBy?: FirestoreOrderBy[];
  limit?: number;
  maxPages?: number;
  typedValues?: boolean;
}

export interface FirestoreWriteSpec extends FirestoreTarget {
  action: FirestoreWriteAction;
  data?: Record<string, unknown>;
  /** `update` only — the field paths to merge. Absent ⇒ derived from `data`'s own keys. */
  updateMask?: string[];
  typedValues?: boolean;
}

/** A bad action/filter/limit in the node config. Non-retryable — re-running won't help. */
export class FirestoreRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirestoreRequestError";
  }
}

/** Author-facing operator → the Firestore `fieldFilter` enum. */
const FIELD_OPS: Record<string, string> = {
  "==": "EQUAL",
  "!=": "NOT_EQUAL",
  "<": "LESS_THAN",
  "<=": "LESS_THAN_OR_EQUAL",
  ">": "GREATER_THAN",
  ">=": "GREATER_THAN_OR_EQUAL",
  "array-contains": "ARRAY_CONTAINS",
  "array-contains-any": "ARRAY_CONTAINS_ANY",
  in: "IN",
  "not-in": "NOT_IN",
};

export const FIRESTORE_FILTER_OPS = Object.keys(FIELD_OPS);

function clamp(value: unknown, fallback: number, max: number): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.max(1, Math.min(n, max));
}

/** Field paths ride in the JSON body, but a control character there is still junk. */
function assertFieldPath(field: unknown): string {
  if (typeof field !== "string" || field.length === 0) {
    throw new FirestoreRequestError(
      "A filter/orderBy entry needs a field name",
    );
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\x00-\x1f\x7f]/.test(field)) {
    throw new FirestoreRequestError(
      `Field path "${field}" contains control characters`,
    );
  }
  return field;
}

/**
 * Build the `structuredQuery` filter for one clause. A comparison against `null` MUST use
 * Firestore's unary form — `fieldFilter` with a `nullValue` is rejected by the API, which
 * is a genuinely confusing error to hit from the canvas.
 */
function buildFilter(f: FirestoreFilter, opts: EncodeOptions): unknown {
  const field = { fieldPath: assertFieldPath(f.field) };
  const op = FIELD_OPS[f.op];
  if (!op) {
    throw new FirestoreRequestError(
      `Unsupported filter operator "${f.op}" — use one of ${FIRESTORE_FILTER_OPS.join(", ")}`,
    );
  }
  if (f.value === null || f.value === undefined) {
    if (op === "EQUAL") return { unaryFilter: { field, op: "IS_NULL" } };
    if (op === "NOT_EQUAL")
      return { unaryFilter: { field, op: "IS_NOT_NULL" } };
    throw new FirestoreRequestError(
      `Operator "${f.op}" cannot compare against null — only == and != can`,
    );
  }
  return {
    fieldFilter: {
      field,
      op,
      value: encodeValue(f.value, opts, `$.${f.field}`),
    },
  };
}

function buildStructuredQuery(spec: FirestoreQuerySpec): unknown {
  const opts: EncodeOptions = { typedValues: spec.typedValues };
  const { collectionId } = queryParent(spec);
  const filters = (spec.filters ?? []).map((f) => buildFilter(f, opts));
  const orderBy = (spec.orderBy ?? []).map((o) => ({
    field: { fieldPath: assertFieldPath(o.field) },
    direction:
      String(o.direction ?? "asc").toLowerCase() === "desc"
        ? "DESCENDING"
        : "ASCENDING",
  }));

  return {
    from: [{ collectionId }],
    ...(filters.length === 1 ? { where: filters[0] } : {}),
    ...(filters.length > 1
      ? { where: { compositeFilter: { op: "AND", filters } } }
      : {}),
    ...(orderBy.length ? { orderBy } : {}),
    limit: clamp(spec.limit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT),
  };
}

/**
 * Build the read request. `list` is paged by the caller, which passes the `pageToken` it
 * got from the previous response.
 */
export function buildQueryRequest(
  spec: FirestoreQuerySpec,
  baseUrl = FIRESTORE_BASE_URL,
  pageToken?: string,
): FirestoreHttpRequest {
  const base = baseUrl.replace(/\/+$/, "");

  if (spec.action === "get") {
    return { method: "GET", url: `${base}/v1/${documentPath(spec)}` };
  }

  if (spec.action === "list") {
    const params = new URLSearchParams({
      pageSize: String(clamp(spec.limit, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT)),
    });
    if (pageToken) params.set("pageToken", pageToken);
    for (const o of spec.orderBy ?? []) {
      params.append(
        "orderBy",
        `${assertFieldPath(o.field)}${String(o.direction ?? "asc").toLowerCase() === "desc" ? " desc" : ""}`,
      );
    }
    return {
      method: "GET",
      url: `${base}/v1/${collectionPath(spec)}?${params}`,
    };
  }

  if (spec.action === "query") {
    const { parent } = queryParent(spec);
    return {
      method: "POST",
      url: `${base}/v1/${parent}:runQuery`,
      body: { structuredQuery: buildStructuredQuery(spec) },
    };
  }

  throw new FirestoreRequestError(
    `Unknown firestoreQuery action "${spec.action}"`,
  );
}

/** Build the write request. */
export function buildWriteRequest(
  spec: FirestoreWriteSpec,
  baseUrl = FIRESTORE_BASE_URL,
): FirestoreHttpRequest {
  const base = baseUrl.replace(/\/+$/, "");
  const opts: EncodeOptions = { typedValues: spec.typedValues };
  const data = spec.data ?? {};

  if (spec.action !== "delete" && !isPlainRecord(data)) {
    throw new FirestoreRequestError(
      "Firestore document data must be an object",
    );
  }

  switch (spec.action) {
    case "create": {
      // Server-assigned id. This is the action that makes the whole node at-most-once:
      // a retry would create a SECOND document.
      const params = new URLSearchParams();
      if (spec.documentId) params.set("documentId", spec.documentId);
      const qs = params.toString();
      return {
        method: "POST",
        url: `${base}/v1/${collectionPath(spec)}${qs ? `?${qs}` : ""}`,
        body: { fields: encodeFields(data, opts) },
      };
    }
    case "set": {
      // PATCH with NO updateMask replaces the whole document (create-or-replace).
      return {
        method: "PATCH",
        url: `${base}/v1/${documentPath(spec)}`,
        body: { fields: encodeFields(data, opts) },
      };
    }
    case "update": {
      // PATCH with an updateMask merges: fields outside the mask are left alone. The mask
      // defaults to the data's own top-level keys, which is what "update these fields"
      // means to an author. Without it Firestore would silently DELETE every unlisted
      // field — the same call, a totally different outcome.
      const mask = spec.updateMask?.length
        ? spec.updateMask
        : Object.keys(data);
      if (!mask.length) {
        throw new FirestoreRequestError(
          "update needs at least one field — an empty update would clear the document",
        );
      }
      const params = new URLSearchParams();
      for (const f of mask)
        params.append("updateMask.fieldPaths", assertFieldPath(f));
      return {
        method: "PATCH",
        url: `${base}/v1/${documentPath(spec)}?${params}`,
        body: { fields: encodeFields(data, opts) },
      };
    }
    case "delete":
      return { method: "DELETE", url: `${base}/v1/${documentPath(spec)}` };
    default:
      throw new FirestoreRequestError(
        `Unknown firestoreWrite action "${String(spec.action)}"`,
      );
  }
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A Firestore document as the REST API returns it. */
export interface RawDocument {
  name?: string;
  fields?: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
}

/** A document decoded for the canvas: plain `data`, plus the metadata worth branching on. */
export interface FirestoreDocument {
  /** Document id (the last path segment), decoded back from the resource name. */
  id: string;
  /** Full resource name, e.g. `projects/p/databases/(default)/documents/users/ada`. */
  name: string;
  data: Record<string, unknown>;
  createTime?: string;
  updateTime?: string;
}

/** Decode one raw REST document into plain JSON. */
export function parseDocument(raw: RawDocument): FirestoreDocument {
  const name = raw.name ?? "";
  const last = name.split("/").pop() ?? "";
  return {
    // The resource name is percent-encoded; give the author back what they wrote.
    id: safeDecode(last),
    name,
    data: decodeFields(raw.fields ?? {}),
    ...(raw.createTime ? { createTime: raw.createTime } : {}),
    ...(raw.updateTime ? { updateTime: raw.updateTime } : {}),
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a malformed escape is not worth failing a read over
  }
}

/** Decode a `:runQuery` response — entries without a `document` are skipped results. */
export function parseRunQueryResponse(body: unknown): FirestoreDocument[] {
  if (!Array.isArray(body)) return [];
  return body
    .filter(
      (e): e is { document: RawDocument } =>
        typeof e === "object" &&
        e !== null &&
        "document" in e &&
        Boolean(e.document),
    )
    .map((e) => parseDocument(e.document));
}

/** Decode a `list` page. */
export function parseListResponse(body: unknown): {
  documents: FirestoreDocument[];
  nextPageToken?: string;
} {
  const b = (body ?? {}) as {
    documents?: RawDocument[];
    nextPageToken?: string;
  };
  return {
    documents: (b.documents ?? []).map(parseDocument),
    ...(b.nextPageToken ? { nextPageToken: b.nextPageToken } : {}),
  };
}

export { FirestorePathError };
