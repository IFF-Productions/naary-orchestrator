/**
 * @naary/firestore — the Cloud Firestore value codec + REST request builder behind the
 * `firestoreQuery` / `firestoreWrite` nodes.
 *
 * PURE: this package builds requests and parses responses. It performs NO I/O — the worker
 * activity does the fetch through the repo's egress-guarded `safeFetch`. Used by worker
 * activities, NEVER by workflow code.
 */
export {
  FIRESTORE_VALUE_TAGS,
  FirestoreValueError,
  decodeFields,
  decodeValue,
  encodeFields,
  encodeValue,
} from "./value";
export type { EncodeOptions, FirestoreValue } from "./value";

export {
  FirestorePathError,
  collectionPath,
  documentPath,
  documentsRoot,
  encodeCollectionPath,
  encodeSegment,
  queryParent,
} from "./path";
export type { FirestoreTarget } from "./path";

export {
  DEFAULT_MAX_PAGES,
  DEFAULT_QUERY_LIMIT,
  FIRESTORE_BASE_URL,
  FIRESTORE_FILTER_OPS,
  FirestoreRequestError,
  MAX_MAX_PAGES,
  MAX_QUERY_LIMIT,
  buildQueryRequest,
  buildWriteRequest,
  parseDocument,
  parseListResponse,
  parseRunQueryResponse,
} from "./request";
export type {
  FirestoreDocument,
  FirestoreFilter,
  FirestoreHttpRequest,
  FirestoreOrderBy,
  FirestoreQuerySpec,
  FirestoreReadAction,
  FirestoreWriteAction,
  FirestoreWriteSpec,
  RawDocument,
} from "./request";

export {
  FirestoreEmulatorError,
  isEmulatorBase,
  resolveEmulatorBaseUrl,
} from "./emulator";
