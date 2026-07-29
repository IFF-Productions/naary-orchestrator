/**
 * "Test connection" (#701) — ask the provider whether a saved connection's token actually works.
 *
 * The gap this closes (docs/integrations/VERIFICATION.md §7 gap 1): a model/CLI provider KEY is
 * validated on save, but a `custom`/PAT/OAuth **connection** was encrypted, stored and reported
 * `connected` without anyone ever asking the provider. The user found out at runtime, as a 401 on
 * a node.
 *
 * Two properties make this trustworthy rather than theatre:
 *
 *  1. **It composes the request through the same code path as the `integration` node** —
 *     `planIntegrationCall` from `@naary/dsl`, which owns the auth-header scheme (Bearer / HTTP
 *     Basic / custom header), the `baseUrl` resolution and the header merge order. A pass therefore
 *     proves the header scheme, baseUrl and token the node will really use. A drift test
 *     (`apps/worker/test/integration-request.drift.spec.ts`) pins the activity's emitted request to
 *     this same function so the two cannot diverge.
 *  2. **It can only ever issue a non-write, zero-required-field GET**, chosen from the catalog's
 *     own `write` flag + `method` + `fields[].required` (`pickConnectionTestAction`). There is no
 *     caller-supplied action and no probe table in this service: a provider that needs a specific
 *     probe declares it on its catalog ACTION (`probe`), which narrows that choice but can never
 *     widen it past the gate. A provider with nothing safe to call reports `unknown` with the reason
 *     — never a guessed argument, never something that mutates.
 *
 * Secrets: the token is resolved here, held in memory for the one call, and never returned, logged
 * or echoed in the response (CLAUDE.md Tier-1 rule 4). Egress goes through the SSRF-hardened
 * `safeFetch` + `assertEgressAllowed`, exactly as the activity does.
 */
import { Injectable, NotFoundException } from "@nestjs/common";
import {
  BlockedEgressError,
  ConnectionService,
  MissingConnectionTokenError,
  NeedsReauthError,
  assertEgressAllowed,
  resolveAuthHeader,
  safeFetch,
} from "@naary/connections";
import type { ConnectionStatus } from "@naary/connections";
import {
  getIntegrationProvider,
  pickConnectionTestAction,
  planIntegrationCall,
} from "@naary/dsl";

/**
 * How much of a provider's response body to read for the error excerpt. We display 200 chars;
 * reading a few KB leaves room for the redaction pass to see a whole credential (so it can't be
 * cut in half) while keeping a hostile or merely verbose response from being buffered in full.
 */
const BODY_EXCERPT_READ_LIMIT = 8 * 1024;

/**
 * Read AT MOST `limit` bytes of a response body, then stop and discard the rest. `res.text()`
 * would buffer everything first — unacceptable for an external host whose response size we do
 * not control. Never throws: an excerpt is a diagnostic nicety, so a stream error degrades to "".
 */
async function readCapped(res: Response, limit: number): Promise<string> {
  const body = res.body;
  if (!body) return await res.text().catch(() => "");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return "";
  } finally {
    // Stop the transfer rather than draining a body we have decided not to read.
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(joined.subarray(0, limit));
}

/** How long we give a provider to answer a probe. Well under any HTTP client timeout — this is a
 *  synchronous request/response for a user staring at a button, not a workflow step. */
const TEST_TIMEOUT_MS = 10_000;

/** Outcome of a connection test. `unknown` means we declined to probe, not that the token is bad. */
export type ConnectionTestOutcome = "ok" | "failed" | "unknown";

export interface ConnectionTestResult {
  /** True only when the provider answered 2xx. `unknown` is NOT ok. */
  ok: boolean;
  status: ConnectionTestOutcome;
  /** The provider's HTTP status, when a call was actually made. */
  httpStatus: number | null;
  /** `provider.action` we called, e.g. `calendly.get_me`. Null when nothing safe existed. */
  checkedAction: string | null;
  /** The connection's status after the test, or null when the test didn't change it. */
  connectionStatus: ConnectionStatus | null;
  /** Human-readable explanation. Never contains the token. */
  message: string;
}

/**
 * Swappable I/O seam (same pattern as the worker's `__httpDeps` and this app's
 * `__mcpRegistryDeps`/`__genDeps`) so a test can point the probe at a local in-process HTTP server
 * — with the SSRF predicate relaxed for 127.0.0.1 — instead of a real provider. The DEFAULTS are
 * the hardened real thing: `safeFetch` (per-hop redirect validation + IP pinning) behind
 * `assertEgressAllowed` (https-only, no private/reserved addresses).
 */
export const __connTestDeps = {
  resolveAuthHeader: (
    tenantId: string,
    connectionId: string,
  ): Promise<Record<string, string>> =>
    resolveAuthHeader(tenantId, connectionId),
  assertEgressAllowed: (url: string): Promise<URL> => assertEgressAllowed(url),
  fetch: (url: string, init: RequestInit): Promise<Response> =>
    safeFetch(url, init as never) as unknown as Promise<Response>,
};

@Injectable()
export class ConnectionTestService {
  constructor(private readonly connections: ConnectionService) {}

  /**
   * Probe `connectionId` against `providerKey`'s cheapest safe read.
   *
   * `providerKey` is REQUIRED and comes from the caller. A `Connection` row has no provider
   * column — a `custom` connection is provider-agnostic by construction, and the catalog provider
   * is chosen at the `integration` NODE — so the caller (who is looking at a provider in the UI)
   * is the only party that knows which API this token is for. Inferring it from `Connection.type`
   * would be worse than useless: the only inferable type, `github`, is one of the providers with
   * no zero-argument read.
   */
  async test(
    tenantId: string,
    connectionId: string,
    providerKey: string,
  ): Promise<ConnectionTestResult> {
    const provider = getIntegrationProvider(providerKey);
    if (!provider) {
      return unknownResult(
        null,
        `Unknown integration provider '${providerKey}'.`,
      );
    }
    const conn = await this.connections.getById(tenantId, connectionId);
    if (!conn) {
      // A 404, not an `unknown` result: `unknown` means "we declined to probe a real connection",
      // which is a verdict about the PROVIDER. A bad id is a bad request path, and the route
      // advertises 404 — matching the sibling connection routes (e.g. OAuth start).
      throw new NotFoundException(`Unknown connection '${connectionId}'`);
    }

    // What is safe to call? Decided from the catalog BEFORE anything else, so a provider we can't
    // probe never gets as far as resolving a secret or opening a socket.
    //
    // The connection's `authMode` goes in because one provider can need TWO probes: a GitHub PAT
    // gets 200 from `/user` and 403 from `/installation/repositories`, and a GitHub App installation
    // token gets exactly the reverse (verified live, #835). Probing an App connection with `/user`
    // would report a perfectly good connection as broken — worse than reporting nothing.
    const probe = pickConnectionTestAction(providerKey, {
      authMode: conn.authMode,
    });
    if (probe.kind === "unknown") {
      return unknownResult(null, probe.reason);
    }
    const checkedAction = `${providerKey}.${probe.action}`;

    // Base URL: the catalog's static base, or the connection's Server URL for the 6 providers with
    // none (mattermost, deepl, shopify, mailchimp, zendesk, jira). A missing Server URL gets its
    // OWN clear message — otherwise the probe would hit a relative/garbage URL and report a
    // baffling 404 or "invalid URL" as if the token were at fault.
    let baseUrl = provider.baseUrl ?? null;
    if (provider.baseUrlFromConnection) {
      baseUrl = conn.serverUrl?.trim() ? conn.serverUrl.trim() : null;
      if (!baseUrl) {
        // A config gap, not a bad credential — flag the connection as `error` (never
        // `needs_reauth`: re-authorizing would not fix a missing URL).
        await this.connections.setStatus(tenantId, connectionId, "error");
        return {
          ok: false,
          status: "failed",
          httpStatus: null,
          checkedAction,
          connectionStatus: "error",
          message:
            `${provider.label} has no fixed API base URL, so this connection needs a Server URL ` +
            `(e.g. ${serverUrlHint(providerKey)}). Edit the connection and set it, then test again.`,
        };
      }
    }

    let httpStatus: number | null = null;
    try {
      // Token resolved HERE and used in-memory only — never returned, logged, or put in the
      // response (Tier-1 rule 4). `authMode` decides Basic-vs-Bearer / custom-header vs Bearer,
      // so an OAuth connection is probed over the header path it will really use.
      const authHeaders = await __connTestDeps.resolveAuthHeader(
        tenantId,
        connectionId,
      );
      const plan = planIntegrationCall({
        provider: providerKey,
        action: probe.action,
        // A zero-required-field action by construction: no user input to supply, and every
        // optional field is dropped by the builder. So this can only be the bare read.
        fields: {},
        baseUrl: baseUrl!,
        authHeaders,
        authMode: conn.authMode,
      });
      const checked = await __connTestDeps.assertEgressAllowed(plan.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await __connTestDeps.fetch(String(checked), {
          method: plan.method,
          headers: plan.headers,
          ...(plan.body === undefined ? {} : { body: plan.body }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      httpStatus = res.status;
      // Drain the body so the connection is released, and keep a short excerpt for the message —
      // the provider's own error text ("Invalid API key") is the most useful thing we can show.
      // Capped hard: a response body is untrusted and can be huge.
      //
      // Then SCRUB the credential out of it. Some providers echo the offending token back in an
      // auth error ("Invalid token: sk-abc123…"), and this excerpt goes into an API response body —
      // which is exactly how a secret ends up in a browser console, a Sentry breadcrumb, or a
      // support screenshot. Tier-1 rule 4 says a credential never crosses this boundary, and
      // "the provider put it there, not us" is not an exemption.
      // Both forms of the credential: the RESOLVER's (`Bearer <raw>`) and the PLAN's, which may have
      // rewritten it to `Basic <base64>` or moved it into a custom header — a provider could echo
      // either. Only the auth header names are read from the plan, so a non-secret header's value
      // (e.g. an Accept type) is never scrubbed out of the excerpt.
      const authNames =
        typeof provider.authScheme === "object"
          ? ["Authorization", provider.authScheme.header]
          : ["Authorization"];
      const secretValues = [
        ...Object.values(authHeaders),
        ...authNames.map((k) => plan.headers[k]).filter(Boolean),
      ];
      // REDACT THEN SLICE, not the other way round: slicing first can cut a credential in half and
      // leave the surviving prefix in the message, which the redaction pass would then no longer
      // recognise.
      //
      // The read itself is BOUNDED (readCapped): `res.text()` buffers the entire body first, so a
      // provider returning a huge error page would cost us that memory before any cap applied —
      // and this is a request to an external host we don't control. We only ever show 200 chars,
      // so a few KB is all we need; anything past that is discarded without being buffered.
      const excerpt = redactToken(
        await readCapped(res, BODY_EXCERPT_READ_LIMIT),
        secretValues,
      ).slice(0, 200);

      if (res.ok) {
        await this.connections.setStatus(tenantId, connectionId, "connected");
        return {
          ok: true,
          status: "ok",
          httpStatus,
          checkedAction,
          connectionStatus: "connected",
          message: `${provider.label} answered ${res.status} to ${checkedAction} — this connection works.`,
        };
      }
      // 401/403 = the credential is the problem → `needs_reauth`, which is what the Integrations
      // screen surfaces as "reconnect". Anything else (404/5xx/429) is `error`: the token may be
      // fine and the provider or our base URL is not.
      const next: ConnectionStatus =
        res.status === 401 || res.status === 403 ? "needs_reauth" : "error";
      await this.connections.setStatus(tenantId, connectionId, next);
      return {
        ok: false,
        status: "failed",
        httpStatus,
        checkedAction,
        connectionStatus: next,
        message:
          `${provider.label} rejected ${checkedAction} with ${res.status}` +
          (excerpt ? `: ${excerpt}` : ".") +
          (next === "needs_reauth"
            ? " Reconnect this connection with a valid token."
            : ""),
      };
    } catch (e) {
      // Typed pre-flight failures get their own message; everything else is a network/DNS/timeout
      // fault. `e.message` from our own errors is safe (no token); an unknown error's message is
      // NOT echoed, so a fetch error carrying a URL with a query-string credential can't leak.
      const { status, message } = classifyThrown(e, provider.label);
      await this.connections.setStatus(tenantId, connectionId, status);
      return {
        ok: false,
        status: "failed",
        httpStatus,
        checkedAction,
        connectionStatus: status,
        message,
      };
    }
  }
}

/**
 * Remove the resolved credential from a provider's response text before it can reach the API
 * response body.
 *
 * Scrubs every auth header VALUE the resolver produced plus the bare token inside it (the value is
 * `Bearer <token>` / `Basic <b64>` / a custom-header form, and a provider would echo the token, not
 * the whole header). Short values are skipped: a 1–7 character "token" is almost certainly a
 * placeholder in a test, and scrubbing it would mangle unrelated text.
 */
function redactToken(text: string, secretValues: string[]): string {
  let out = text;
  for (const value of secretValues) {
    // Both the whole header value and the bare token inside it: a provider echoes the token, not
    // the header. Values under 8 chars are test placeholders — scrubbing them would mangle text.
    for (const c of [value, value.replace(/^\S+\s+/, "")]) {
      if (c.length < 8) continue;
      out = out.split(c).join("[redacted]");
    }
  }
  return out;
}

/** `unknown` — we declined to probe. The connection's status is deliberately left ALONE: we
 *  learned nothing about the token, so overwriting `connected` would be a lie in either direction. */
function unknownResult(
  checkedAction: string | null,
  message: string,
): ConnectionTestResult {
  return {
    ok: false,
    status: "unknown",
    httpStatus: null,
    checkedAction,
    connectionStatus: null,
    message,
  };
}

function classifyThrown(
  e: unknown,
  providerLabel: string,
): { status: ConnectionStatus; message: string } {
  if (e instanceof NeedsReauthError) {
    return {
      status: "needs_reauth",
      message:
        "This connection's stored authorization is no longer valid — reconnect it.",
    };
  }
  if (e instanceof MissingConnectionTokenError) {
    return {
      status: "error",
      message:
        "This connection has no stored token yet. Add a token (or finish the OAuth consent) and test again.",
    };
  }
  if (e instanceof BlockedEgressError) {
    return {
      status: "error",
      message: `Blocked by the egress policy (${e.message}) — the API base must be a public https host.`,
    };
  }
  const aborted =
    e instanceof Error &&
    (e.name === "AbortError" || e.name === "TimeoutError");
  return {
    status: "error",
    message: aborted
      ? `${providerLabel} did not answer within ${TEST_TIMEOUT_MS / 1000}s.`
      : `Could not reach ${providerLabel} (network error).`,
  };
}

/** Example Server URL per baseUrl-less provider, so the "set a Server URL" error is actionable.
 *  Display text only — never used to build a request. */
function serverUrlHint(providerKey: string): string {
  switch (providerKey) {
    case "jira":
      return "https://your-site.atlassian.net";
    case "zendesk":
      return "https://your-subdomain.zendesk.com/api/v2";
    case "shopify":
      return "https://your-shop.myshopify.com/admin/api/2024-01";
    case "deepl":
      return "https://api-free.deepl.com or https://api.deepl.com";
    case "mailchimp":
      return "https://<dc>.api.mailchimp.com/3.0";
    case "mattermost":
      return "https://your-mattermost.example.com";
    default:
      return "your provider's API base URL";
  }
}
