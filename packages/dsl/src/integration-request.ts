/**
 * The ONE composer for an `integration` node's outbound HTTP request (#701).
 *
 * `buildIntegrationRequest` (integrations.ts) turns { provider, action, fields } into a
 * method + path + body. This module adds the part that used to live inline in the worker
 * activity: the **auth-header scheme rewrites** (HTTP Basic, custom header) and the exact
 * **header merge order**. Both are per-provider catalog knowledge that is invisible to a
 * unit test of a single caller and fatal in production if it drifts — so it lives here,
 * once, and every caller composes through it:
 *
 *   - `apps/worker/src/temporal/activities/integration.ts` — the `integration` node.
 *   - `apps/api/src/connections/connection-test.service.ts` — "Test connection" (#701).
 *
 * A test-connection pass therefore proves the *same* header scheme, baseUrl and token the
 * node will use at runtime, rather than a parallel reimplementation that can drift.
 *
 * Pure by construction: `authHeaders` and `authMode` are **inputs**. Secret resolution stays
 * with the caller (in-activity / in-service, CLAUDE.md Tier-1 rule 4) — this module never
 * reads a store, never logs, and never returns the raw token separately from the headers it
 * was asked to place.
 */
import {
  buildIntegrationRequest,
  getIntegrationAction,
  getIntegrationProvider,
  type IntegrationProvider,
} from "./integrations";

/**
 * WHICH HOST does this provider's request go to — the catalog's, or the connection's? (#1110)
 *
 * Lives here, beside `planIntegrationCall`, for the reason this module exists at all: the worker
 * activity and the API's "Test connection" both answer it, and when they answer it differently the
 * credential check probes a DIFFERENT host than the node will call — so a passing test proves
 * nothing and a failing one blames the token. That is precisely how PostHog's regional host went
 * unnoticed: `get_me` was wrong in exactly the same way every action was.
 *
 * Returns `null` for "no host could be resolved", which is a configuration fault; the callers own
 * the message, because the worker must raise a non-retryable failure and the API must return a
 * verdict on the connection.
 */
export function resolveIntegrationBaseUrl(
  provider: IntegrationProvider,
  serverUrl?: string | null,
): string | null {
  if (!provider.baseUrlFromConnection) return provider.baseUrl ?? null;
  // A connection's own host always wins. `defaultBaseUrl` is the fallback for connections made
  // before the provider asked for one (see POSTHOG's note) — most providers have none, and for
  // those a missing Server URL stays the hard error it has always been.
  return serverUrl?.trim() || provider.defaultBaseUrl || null;
}

/**
 * Base64 via whichever encoder the host provides — Node's `Buffer` in the worker/api, the
 * browser's `btoa` in the web bundle.
 *
 * Reached through `globalThis` on purpose: `@naary/dsl` deliberately ships WITHOUT
 * `@types/node` (it's the one package apps/web imports, so it must stay browser-safe and
 * must not be able to reach for `fs`). A bare `Buffer` reference wouldn't typecheck here, and
 * hard-coding one would either break the web bundle or force a Buffer polyfill into it.
 *
 * Both paths must produce the SAME bytes. `btoa` is latin1-only, so a UTF-8 credential (a non-ASCII
 * character in a Jira email, say) would throw there while `Buffer.from(…, "utf8")` succeeded — an
 * auth header that differs by host is exactly the kind of divergence this module exists to prevent.
 * So the `btoa` path UTF-8-encodes first, byte-for-byte matching Node.
 */
const host = globalThis as unknown as {
  Buffer?: { from(s: string, enc: string): { toString(enc: string): string } };
  btoa?: (s: string) => string;
  TextEncoder?: new () => { encode(s: string): Uint8Array };
};

function toBase64(s: string): string {
  if (host.Buffer) return host.Buffer.from(s, "utf8").toString("base64");
  if (host.btoa) {
    if (!host.TextEncoder) return host.btoa(s); // ASCII-only host; nothing better available
    // One latin1 char per UTF-8 BYTE — what btoa expects, and what makes this match Buffer.
    let binary = "";
    for (const byte of new host.TextEncoder().encode(s)) {
      binary += String.fromCharCode(byte);
    }
    return host.btoa(binary);
  }
  throw new Error("no base64 encoder available (neither Buffer nor btoa)");
}

export interface IntegrationCallPlanInput {
  provider: string;
  action: string;
  /** Interpreter-resolved field values (static + bindings). No ctx, no secrets. */
  fields: Record<string, unknown>;
  /** Resolved API base — the catalog's `baseUrl`, or the connection's `serverUrl` for a
   *  `baseUrlFromConnection` provider. A trailing slash is trimmed. */
  baseUrl: string;
  /** Auth headers the CALLER resolved (`{ Authorization: "Bearer <token>" }`). Never mutated. */
  authHeaders: Record<string, string>;
  /** The connection's auth mode. `"oauth"` deliberately SKIPS both scheme rewrites — an OAuth
   *  access token IS a genuine Bearer, so a provider reached over OAuth exercises a different
   *  header path than the same provider reached with a PAT. */
  authMode?: string | null;
}

/** Everything needed to issue the request — nothing provider-specific left to decide. */
export interface IntegrationCallPlan {
  method: string;
  /** Absolute request URL (base + path + query string). */
  url: string;
  /** `path + query string`, as returned by `buildIntegrationRequest`. Log the part BEFORE
   *  `?` only — query-param values can carry run data. */
  path: string;
  headers: Record<string, string>;
  /** JSON-serialized body, or `undefined` for a GET / an action with no body. */
  body?: string;
}

/**
 * Compose the exact HTTP request an `integration` node sends.
 *
 * Header precedence, lowest to highest (a later spread wins):
 *   1. `Accept: application/json`
 *   2. the provider's static headers (e.g. GitHub's api-version)
 *   3. `in: "header"` FIELD values — these can come from run data, so they sit BELOW auth
 *      and below the per-action media type the endpoint depends on
 *   4. the action's own headers (e.g. GitHub's diff media type)
 *   5. the resolved auth headers — spread LAST so nothing can clobber the credential
 * `Content-Type: application/json` is then set for a request that carries a body.
 */

/**
 * Serialize a body as `application/x-www-form-urlencoded` (#707).
 *
 * Needed because Twilio and Stripe accept ONLY this — a JSON body is rejected outright, so their
 * write actions could never succeed while the catalog had no way to say so.
 *
 * An ARRAY becomes repeated keys (`MediaUrl=a&MediaUrl=b`), which is how both APIs express a list.
 *
 * A NESTED object THROWS rather than being flattened or JSON-stringified into a value. A form body
 * has no nesting, so any mapping we invented would be a guess: Stripe wants `metadata[key]=v`,
 * others want `a.b=v`, and a silently wrong encoding produces a 400 from the provider that the
 * author cannot diagnose from the UI — the exact failure mode this change exists to remove. The
 * error names the field and never echoes its value (a body field can carry run data).
 */
function formEncodeBody(
  provider: string,
  action: string,
  body: Record<string, unknown>,
): string {
  // Hand-rolled rather than URLSearchParams: this package is platform-agnostic and also evaluated
  // inside the Temporal workflow sandbox, where a host global is not something to rely on.
  // `encodeURIComponent` + `%20`→`+` matches what URLSearchParams emits for these values.
  const enc = (v: string): string => encodeURIComponent(v).replace(/%20/g, "+");
  const parts: string[] = [];
  const append = (key: string, value: unknown): void => {
    if (value !== null && typeof value === "object") {
      throw new Error(
        `Integration ${provider}/${action}: form-encoded actions can't send a nested value for '${key}' — flatten it in the catalog (e.g. Stripe's metadata[key] as its own field).`,
      );
    }
    parts.push(`${enc(key)}=${enc(String(value))}`);
  };
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) for (const v of value) append(key, v);
    else append(key, value);
  }
  return parts.join("&");
}

export function planIntegrationCall(
  input: IntegrationCallPlanInput,
): IntegrationCallPlan {
  const { provider: providerKey, action: actionKey, fields, baseUrl } = input;
  const provider = getIntegrationProvider(providerKey);
  if (!provider)
    throw new Error(`Unknown integration provider '${providerKey}'`);
  const action = getIntegrationAction(providerKey, actionKey);
  if (!action) {
    throw new Error(`Unknown integration ${providerKey}/${actionKey}`);
  }

  const req = buildIntegrationRequest(providerKey, actionKey, fields);

  // Copy — the caller's authHeaders object is never mutated (it may be reused/logged upstream).
  const authHeaders: Record<string, string> = { ...input.authHeaders };
  const isOauth = input.authMode === "oauth";

  // A "basic"-scheme provider (Jira Cloud, Zendesk, Twilio) with an API TOKEN uses HTTP Basic
  // (`base64(email:token)`): the connection stores `email:token` and the resolver hands it back
  // as `Bearer email:token`, so re-wrap it. An OAuth access token IS a Bearer — pass it through.
  if (
    provider.authScheme === "basic" &&
    !isOauth &&
    authHeaders.Authorization
  ) {
    const raw = authHeaders.Authorization.replace(/^Bearer\s+/i, "");
    authHeaders.Authorization = `Basic ${toBase64(raw)}`;
  }
  // A CUSTOM-HEADER-scheme provider (#655): Shopify (`X-Shopify-Access-Token`), Discord
  // (`Authorization: Bot <token>`), Monday/ClickUp (bare `Authorization`, no prefix), DeepL
  // (`DeepL-Auth-Key `), PagerDuty (`Token token=`). Strip the resolver's `Bearer ` and place
  // the raw token in the declared header with the optional literal prefix. api_token/pat only —
  // an OAuth access token stays a genuine Bearer (mirrors the "basic" guard above).
  if (
    typeof provider.authScheme === "object" &&
    !isOauth &&
    authHeaders.Authorization
  ) {
    const raw = authHeaders.Authorization.replace(/^Bearer\s+/i, "");
    delete authHeaders.Authorization;
    authHeaders[provider.authScheme.header] =
      `${provider.authScheme.prefix ?? ""}${raw}`;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(provider.headers ?? {}),
    ...(req.headers ?? {}),
    ...(action.headers ?? {}),
    ...authHeaders,
  };

  let body: string | undefined;
  if (req.method !== "GET" && req.body !== undefined) {
    if (action.bodyEncoding === "form") {
      body = formEncodeBody(providerKey, actionKey, req.body);
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      body = JSON.stringify(req.body);
      headers["Content-Type"] = "application/json";
    }
  }

  return {
    method: req.method,
    url: `${baseUrl.replace(/\/$/, "")}${req.path}`,
    path: req.path,
    headers,
    ...(body === undefined ? {} : { body }),
  };
}

/**
 * A safe connection-test probe: an **argument-free, non-write GET** from the provider's own
 * catalog entry, or an honest `unknown` (#701, widened in #835).
 *
 * ## The safety gate comes first, and nothing can widen it
 *
 * A candidate must be `write: false`, a `GET`, and have no field the user would have to supply.
 * Everything below only ever CHOOSES among actions that already pass that gate — so a catalog edit
 * cannot turn this into a call that mutates, and a `probe` declaration on a write is inert rather
 * than dangerous.
 *
 * ## Why a declaration exists at all (#835)
 *
 * The original rule — "any zero-argument read" — reached 14 of 38 providers, skipping GitHub, Slack,
 * Jira, Notion, GitLab and Linear, i.e. the popular half. It was skipping them for a real reason
 * (GitHub's cheapest read needs owner/repo), so the fix is in the CATALOG: each provider that has a
 * genuine identity read now declares it with `probe`, which
 *
 *   - PINS the choice (otherwise a later zero-field list action could silently displace it), and
 *   - carries `authModes`, because one provider can need TWO probes. GitHub, verified live: a PAT
 *     gets 200 from `/user` and 403 from `/installation/repositories`; a GitHub App installation
 *     token gets exactly the reverse. Probing an App connection with `/user` would report a healthy
 *     connection as broken — the one outcome worse than not probing.
 *
 * `unknown` stays a first-class answer, and the honest one: Slack's argument-free `auth.test`
 * answers HTTP 200 with `{"ok": false}` for a dead token, Linear and Monday are GraphQL POSTs, and
 * Google Sheets has no identity endpoint on its own host. Those providers say so (the catalog's
 * `unprobeableReason`) instead of being probed with something that would mislead.
 */
export type ConnectionTestProbe =
  | {
      kind: "read";
      /** Catalog action key — safe to name in the API response. */
      action: string;
      method: string;
      /** The action's path TEMPLATE (no placeholders remain: it takes no required fields). */
      pathTemplate: string;
    }
  | { kind: "unknown"; reason: string };

/** A field the user must supply: required, and not injected by the catalog as a `const`. */
const needsUser = (f: { required: boolean; const?: unknown }): boolean =>
  f.required && f.const === undefined;

export interface ConnectionTestProbeOptions {
  /**
   * The connection's `Connection.authMode` (`pat` / `api_token` / `oauth` / `github_app` / …), when
   * the caller knows it. It selects between a provider's auth-mode-specific probes — GitHub's App
   * installation token cannot call `/user`, so passing this is what keeps a working App connection
   * from being reported as broken.
   *
   * Omit it to ask the capability question instead ("could this provider be probed at all?"), which
   * is what the UI does when it decides which providers to offer a Test button for.
   */
  authMode?: string | null;
}

export function pickConnectionTestAction(
  providerKey: string,
  opts: ConnectionTestProbeOptions = {},
): ConnectionTestProbe {
  const provider = getIntegrationProvider(providerKey);
  if (!provider) {
    return {
      kind: "unknown",
      reason: `Unknown integration provider '${providerKey}'.`,
    };
  }
  const authMode = opts.authMode ?? null;
  const unprobeable = (generated: string): ConnectionTestProbe => ({
    kind: "unknown",
    // The catalog's own explanation wins when it has one: for Slack, Linear, Monday, Dropbox,
    // Microsoft Graph and Google Sheets the GENERATED sentence is true but tells the user nothing
    // they can act on (#835).
    reason: provider.unprobeableReason ?? generated,
  });

  // THE SAFETY GATE. Non-write (the call may not change anything), GET (so a mismarked POST-read
  // can't be reached either), and nothing the user would have to supply (there is no one to ask).
  // Everything after this line only chooses among actions that already passed it.
  const candidates = provider.actions.filter(
    (a) => !a.write && a.method === "GET" && !a.fields.some(needsUser),
  );

  // A DECLARED probe wins over an incidental zero-argument read: it pins the choice against a later
  // catalog addition, and it is the only way to express "this one, for this kind of connection".
  const declared = candidates.filter((a) => a.probe);
  const forAuthMode = declared.filter(
    (a) =>
      typeof a.probe === "object" &&
      authMode !== null &&
      a.probe.authModes.includes(authMode),
  );
  const generic = declared.filter((a) => a.probe === true);
  const pick =
    forAuthMode[0] ??
    generic[0] ??
    // No auth mode to match on (the capability question) — any declared probe answers "yes".
    (authMode === null ? declared[0] : undefined) ??
    // Fallback: the pre-#835 rule, which is what the 14 originally-probeable providers still use.
    // Fewest fields wins; Array.prototype.sort is stable, so catalog order breaks ties — the pick
    // is deterministic for a given catalog.
    [...candidates].sort((a, b) => a.fields.length - b.fields.length)[0];

  if (!pick) {
    if (declared.length > 0) {
      return unprobeable(
        `${provider.label} has no credential check for a '${authMode}' connection — its probes are ` +
          `declared for other connection types. Test it with an integration node on a canvas ` +
          `(single-node Test).`,
      );
    }
    const reads = provider.actions.filter((a) => !a.write);
    if (reads.length === 0) {
      return unprobeable(
        `Every ${provider.label} action in the catalog writes, so there is no call that could ` +
          `prove this token without changing data. Test it with an integration node on a canvas ` +
          `(single-node Test) against a scratch target instead.`,
      );
    }
    const cheapest = [...reads].sort(
      (a, b) =>
        a.fields.filter(needsUser).length - b.fields.filter(needsUser).length,
    )[0];
    const need = cheapest.fields
      .filter(needsUser)
      .map((f) => f.key)
      .join(", ");
    return unprobeable(
      `${provider.label} has no zero-argument read action: its cheapest read ` +
        `'${cheapest.key}' still needs ${need || "arguments"}. Test it with an integration node ` +
        `on a canvas (single-node Test), where you can supply those values.`,
    );
  }
  return {
    kind: "read",
    action: pick.key,
    method: pick.method,
    pathTemplate: pick.pathTemplate,
  };
}
