/**
 * Catalog + resolved field values → the concrete method / path / query / body / headers the
 * activity sends. Pure and total; this is exactly what the unit tests assert on.
 *
 * Named `build-request`, not `request`, deliberately: `../integration-request.ts` is a DIFFERENT
 * module (`planIntegrationCall` / `pickConnectionTestAction`, which resolve auth and the base URL
 * AROUND this function's output). An `integrations/request.ts` sitting next to it would be a
 * coin-flip at every import site.
 *
 * `setPath` / `hasObjectAtPath` stay private here — they exist only to assemble a nested JSON
 * body, and both refuse to walk prototype-chain keys (#591), which is a property worth keeping
 * in one place rather than re-deriving at a call site.
 */
import { isEmptyFieldValue } from "../integration-fields";
import { hasForbiddenPathSegment } from "../mcp-args";
import { getIntegrationAction } from "./lookup";
import type { IntegrationAction, IntegrationField } from "./types";

/** Set a dotted path on an object, creating intermediate objects. Pure. */
function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (hasForbiddenPathSegment(path)) return; // #591: prototype-chain keys must never be walked/assigned
  const keys = path.split(".");
  let obj = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (obj[k] == null || typeof obj[k] !== "object") obj[k] = {};
    obj = obj[k] as Record<string, unknown>;
  }
  obj[keys[keys.length - 1]] = value;
}

/** True when `path` already resolves to an object on `target` — i.e. some field has already
 *  put data in that sub-object. Used to decide whether a nested `const` discriminator has a
 *  payload to describe. Pure; never walks prototype-chain keys (#591). */
function hasObjectAtPath(
  target: Record<string, unknown> | undefined,
  path: string,
): boolean {
  if (!target || hasForbiddenPathSegment(path)) return false;
  let obj: unknown = target;
  for (const key of path.split(".")) {
    if (obj == null || typeof obj !== "object") return false;
    // OWN properties only — an inherited member must never read as "this sub-object already
    // carries data" (#591); the forbidden-segment check above is belt, this is braces.
    // (`hasOwnProperty.call`, not `Object.hasOwn` — the es2021 lib, as in registry.ts.)
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
    obj = (obj as Record<string, unknown>)[key];
  }
  return obj != null && typeof obj === "object";
}

export interface BuiltIntegrationRequest {
  method: IntegrationAction["method"];
  /** Path portion with `{placeholders}` filled + the query string appended (no base URL). */
  path: string;
  /** Assembled JSON body for write verbs (undefined when there are no body fields / for GETs). */
  body?: Record<string, unknown>;
  /** Headers built from `in: "header"` fields (undefined when the action declares none).
   *  The activity merges these UNDER the resolved auth headers — never over them. */
  headers?: Record<string, string>;
}

/**
 * Build the concrete request (path + query + body) for an action from resolved field
 * values, using ONLY the catalog. Pure + total: this is exactly what the unit tests
 * assert and what the activity sends. Fields with `undefined`/`""` values are omitted
 * (a missing optional stays out of the payload). Throws on unknown provider/action.
 */
export function buildIntegrationRequest(
  provider: string,
  action: string,
  fields: Record<string, unknown>,
): BuiltIntegrationRequest {
  const act = getIntegrationAction(provider, action);
  if (!act) throw new Error(`Unknown integration ${provider}/${action}`);

  let path = act.pathTemplate;
  const queryParts: string[] = [];
  let body: Record<string, unknown> | undefined;
  let headers: Record<string, string> | undefined;

  const applyField = (field: IntegrationField, value: unknown): void => {
    const missing = isEmptyFieldValue(value);
    if (field.in === "header") {
      if (missing) return;
      // Trailing whitespace/newlines are common on a value bound from upstream text — trim
      // rather than fail. An INTERIOR CR/LF would let run data inject extra headers into the
      // request, so that still hard-fails in the pure builder (never echoing the value).
      const raw = String(value).trim();
      if (raw === "") return;
      if (/[\r\n]/.test(raw)) {
        throw new Error(
          `Integration ${provider}/${action}: header field '${field.key}' contains a newline`,
        );
      }
      headers ??= {};
      headers[field.key] = raw;
    } else if (field.in === "path") {
      // An empty path value is NEVER substitutable: it collapses the segment and sends a
      // malformed URL. `PUT /incidents/` reached PagerDuty and came back "400 Bad Request",
      // which names neither the field nor the node — the author is left guessing from a
      // provider error about a request we knew was broken before we sent it.
      //
      // Save-time validation can't catch this. It accepts a field as supplied when a BINDING
      // exists for it, and a binding's value isn't known until the run — so a binding pointing
      // at a path that yields nothing passes the gate and fails here. (Every path field in the
      // catalog is required, all 133 of them, so there is no optional-segment case to preserve.)
      if (missing) {
        throw new Error(
          `Integration ${provider}/${action}: path field '${field.key}' is empty — ` +
            `check the binding that supplies it (it resolved to nothing at run time).`,
        );
      }
      path = path.replace(`{${field.key}}`, encodeURIComponent(String(value)));
    } else if (field.in === "query") {
      if (!missing) {
        queryParts.push(
          `${encodeURIComponent(field.key)}=${encodeURIComponent(String(value))}`,
        );
      }
    } else {
      // Empty optional body fields are dropped — UNLESS keepEmpty (an empty string is meaningful,
      // e.g. Dropbox root path ""). A truly-absent value still coalesces to "" via the field default.
      if (missing && !field.keepEmpty) return;
      body ??= {};
      setPath(body, field.bodyPath ?? field.key, value ?? "");
    }
  };

  // Pass 1 — the user's fields.
  for (const field of act.fields) {
    if (field.const === undefined) applyField(field, fields[field.key]);
  }
  // Pass 2 — catalog `const` fields (API type discriminators). They run AFTER the user's
  // fields so a const inside a DEEPER sub-object can see whether that sub-object actually
  // carries data: PagerDuty's `incident.body.type` must not conjure an otherwise-empty
  // `body: { type: "incident_body" }` when no details were given. A const at the top of the
  // payload envelope (`incident.type`) or at the root is always sent.
  for (const field of act.fields) {
    if (field.const === undefined) continue;
    if (field.in === "body") {
      const target = field.bodyPath ?? field.key;
      const parent = target.slice(0, Math.max(0, target.lastIndexOf(".")));
      if (parent.includes(".") && !hasObjectAtPath(body, parent)) continue;
    }
    applyField(field, field.const);
  }

  const qs = queryParts.join("&");
  // A form-encoded action can't express nesting (#707). Reject it HERE, at build time, for the
  // same reason the header-CRLF check above is here: this is a data/config fault a retry can never
  // fix, and the activity's build-time catch already maps it to a non-retryable
  // INTEGRATION_INVALID_CONFIG. Raised in the planner too as a backstop, but by then auth has been
  // resolved and the failure would fall through to "transient" — losing this message.
  if (act.bodyEncoding === "form" && body !== undefined) {
    for (const [key, value] of Object.entries(body)) {
      // A list is fine — it becomes repeated keys (`MediaUrl=a&MediaUrl=b`). Its ELEMENTS are
      // not: `formEncodeBody` appends each one through the same `String(v)`-or-throw path, so an
      // object inside an array is exactly as unsendable as an object at the top. Checking only
      // the array itself let `{name: ["a", {x: 1}]}` past the builder and left the throw to the
      // planner — after auth resolution, where the activity's catch treats it as
      // INTEGRATION_TRANSIENT and sanitizes this message away (and retries a read three times).
      // Reachable from a `type: "string[]"` field bound to run data that yields objects.
      const values: unknown[] = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (v !== null && typeof v === "object") {
          throw new Error(
            `Integration ${provider}/${action}: form-encoded actions can't send a nested value for '${key}' — flatten it in the catalog (e.g. Stripe's metadata[key] as its own field).`,
          );
        }
      }
    }
  }

  return {
    method: act.method,
    path: qs ? `${path}?${qs}` : path,
    // `{}` instead of nothing where the provider's spec requires a body (see `alwaysSendBody`).
    // Applied here, at the end, so it can't mask an empty-field bug earlier in assembly: every
    // field has already had its chance to write, and this only fills a body that stayed absent.
    body: body === undefined && act.alwaysSendBody ? {} : body,
    headers,
  };
}
