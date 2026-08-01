/**
 * Firestore resource-path construction — and the injection guard that makes it safe.
 *
 * `projectId`, `databaseId`, `collection` and `documentId` are all AUTHOR-supplied and all
 * land in the URL path. This is the exact analogue of the sqlQuery node's "the `sql` text
 * is STATIC": a `documentId` of `../orders/secret` would escape to a different document,
 * and a `?` or `#` would inject query parameters into the REST call.
 *
 * Two layers, both deliberate:
 *   1. VALIDATE — reject a segment that is empty, `.`/`..`, contains `/`, a control
 *      character, or Firestore's reserved `__…__` form. Firestore itself forbids all of
 *      these in an id, so rejecting is correct rather than restrictive: there is no
 *      legitimate document this could have meant.
 *   2. ENCODE — `encodeURIComponent` every segment, so even a character that slips past
 *      the validator cannot change the path's structure.
 *
 * PURE — no I/O. Unit-testable with no network.
 */

/** An author-supplied path segment that cannot be safely put in a Firestore URL. */
export class FirestorePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirestorePathError";
  }
}

/** Firestore's own limit on a single path segment. */
const MAX_SEGMENT_BYTES = 1500;

/** C0 + DEL. Written as \x escapes on purpose — a literal control byte in source is
 *  banned here (`pnpm check:control-bytes`) and would be invisible to a reviewer. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Validate one path segment and return it percent-encoded, ready to concatenate into a
 * URL path. `kind` names the field in the error so the author knows which one to fix.
 */
export function encodeSegment(kind: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new FirestorePathError(`${kind} is required`);
  }
  if (raw.includes("/")) {
    throw new FirestorePathError(
      `${kind} may not contain "/" — that would address a different document`,
    );
  }
  if (raw === "." || raw === "..") {
    throw new FirestorePathError(`${kind} may not be "." or ".."`);
  }
  if (CONTROL_CHARS.test(raw)) {
    throw new FirestorePathError(`${kind} may not contain control characters`);
  }
  if (/^__.*__$/.test(raw)) {
    throw new FirestorePathError(
      `${kind} may not match __*__ — Firestore reserves that form`,
    );
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_SEGMENT_BYTES) {
    throw new FirestorePathError(
      `${kind} is longer than Firestore's ${MAX_SEGMENT_BYTES}-byte limit`,
    );
  }
  return encodeURIComponent(raw);
}

/**
 * Validate + encode a COLLECTION path, which may legitimately name a subcollection:
 * `users/ada/orders`. A collection path always has an ODD number of segments (collection,
 * document, collection, …); an even count means the author pointed at a document, which is
 * a different resource and would silently produce a wrong-shaped request.
 */
export function encodeCollectionPath(collection: unknown): string {
  if (typeof collection !== "string" || collection.length === 0) {
    throw new FirestorePathError("collection is required");
  }
  const segments = collection.split("/");
  if (segments.length % 2 === 0) {
    throw new FirestorePathError(
      `collection "${collection}" names a document, not a collection — a collection path has an odd number of segments (e.g. "users" or "users/ada/orders")`,
    );
  }
  return segments.map((s) => encodeSegment("collection segment", s)).join("/");
}

export interface FirestoreTarget {
  projectId: string;
  databaseId?: string;
  collection: string;
  documentId?: string;
}

/** `projects/{p}/databases/{d}/documents` — the root every resource path hangs off. */
export function documentsRoot(
  projectId: unknown,
  databaseId?: unknown,
): string {
  const p = encodeSegment("projectId", projectId);
  const d = encodeSegment("databaseId", databaseId ?? "(default)");
  return `projects/${p}/databases/${d}/documents`;
}

/** Full relative path to a COLLECTION, e.g. `projects/p/databases/(default)/documents/users`. */
export function collectionPath(target: FirestoreTarget): string {
  return `${documentsRoot(target.projectId, target.databaseId)}/${encodeCollectionPath(target.collection)}`;
}

/** Full relative path to a DOCUMENT. Requires `documentId`. */
export function documentPath(target: FirestoreTarget): string {
  const id = encodeSegment("documentId", target.documentId);
  return `${collectionPath(target)}/${id}`;
}

/**
 * The `parent` + `collectionId` pair a structured query needs. `runQuery` is issued against
 * the collection's PARENT with the leaf collection named separately, so `users/ada/orders`
 * becomes parent `…/documents/users/ada` and collectionId `orders`.
 */
export function queryParent(target: FirestoreTarget): {
  parent: string;
  collectionId: string;
} {
  // Validate every segment (this throws on an injection attempt), then split the RAW
  // collection so the leaf stays un-encoded: `parent` goes in the URL path and must be
  // percent-encoded, but `collectionId` rides in the JSON body, where percent-encoding
  // would make it a different — and almost certainly nonexistent — collection name.
  encodeCollectionPath(target.collection);
  const rawSegments = (target.collection as string).split("/");
  const collectionId = rawSegments.pop() as string;
  const root = documentsRoot(target.projectId, target.databaseId);
  const encodedParents = rawSegments.map((s) =>
    encodeSegment("collection segment", s),
  );
  return {
    parent: encodedParents.length
      ? `${root}/${encodedParents.join("/")}`
      : root,
    collectionId,
  };
}
