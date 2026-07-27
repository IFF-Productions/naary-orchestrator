/**
 * MCP registry browser (#578) — server-side discovery of public MCP servers.
 *
 * CONTROL-PLANE ONLY (an explicit AC): the registry fetch happens HERE, in the NestJS api, never in
 * workflow or worker code. The worker only ever talks to a saved Connection.
 *
 * DEGRADES TO CURATED (the other explicit AC): any upstream problem — unreachable, slow, non-200,
 * oversized, unparseable, or a body with nothing usable in it — returns the in-repo curated corpus
 * with `source: "curated"`, so discovery keeps working offline instead of 500ing.
 *
 * The upstream response is UNTRUSTED (see registry-sanitize.ts for the threat model). Curated
 * entries always win a URL collision, so a community row can never shadow a vetted one.
 */
import { Injectable } from "@nestjs/common";
import { BlockedEgressError, safeFetch } from "@naary/connections";
import { createLogger } from "@naary/logging";
import { CURATED_AS_OF, CURATED_SERVERS } from "./curated-servers";
import {
  MAX_SERVERS,
  type McpRegistryServer,
  matchesQuery,
  sanitizeRegistryResponse,
} from "./registry-sanitize";
import { mcpRegistryUrl } from "../config";

const log = createLogger({ component: "api" });

/** The public MCP registry's server list. Overridable so a deployment can point at a mirror (or an
 *  internal registry). It is env-configurable, hence it goes through `safeFetch`, not bare fetch. */
export const DEFAULT_REGISTRY_URL =
  "https://registry.modelcontextprotocol.io/v0/servers";

/** Bounds on the upstream call — an unresponsive registry must not hold an api request open, and a
 *  hostile one must not be able to stream us an unbounded body. */
export const REGISTRY_TIMEOUT_MS = 5_000;
export const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
/** How long a successful upstream list is reused. The registry is a slowly-changing catalog, so a
 *  short in-process cache keeps a browsing user from fanning out one upstream call per keystroke. */
export const REGISTRY_CACHE_MS = 60_000;
/** How long a FAILURE is remembered. Without this, a registry outage — the exact degrade path —
 *  would make every keystroke pay the full 5s timeout again AND have us hammer a dead endpoint.
 *  Much shorter than the success TTL so recovery is picked up quickly. */
export const REGISTRY_FAILURE_CACHE_MS = 15_000;

export interface McpRegistryPage {
  servers: McpRegistryServer[];
  /** Where the rows came from. `curated` means the upstream registry was unavailable (or returned
   *  nothing usable) and this is the degraded response — the UI says so. */
  source: "registry" | "curated";
  /** Present only in degraded mode: a short, non-sensitive reason. */
  degradedReason?: string;
  curatedAsOf: string;
}

/** Injectable I/O seam (the house `__xxxDeps` pattern) so tests exercise the mapping + the degrade
 *  path without a network. */
export const __mcpRegistryDeps = {
  fetch: (url: string, init?: RequestInit): Promise<Response> =>
    safeFetch(url, init as never) as unknown as Promise<Response>,
};

@Injectable()
export class McpRegistryService {
  private cache: { at: number; servers: McpRegistryServer[] } | null = null;
  /** Negative cache — see REGISTRY_FAILURE_CACHE_MS. */
  private failure: { at: number; reason: string } | null = null;

  private registryUrl(): string {
    return mcpRegistryUrl() || DEFAULT_REGISTRY_URL;
  }

  /** Browse/search connectable MCP servers. Never throws for an upstream problem. */
  async list(
    opts: { q?: string; limit?: number } = {},
  ): Promise<McpRegistryPage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_SERVERS);
    const q = (opts.q ?? "").slice(0, 200);
    const curated = CURATED_SERVERS.filter((s) => matchesQuery(s, q));

    const upstream = await this.fetchUpstream();
    if (!upstream.ok) {
      return {
        servers: curated.slice(0, limit),
        source: "curated",
        degradedReason: upstream.reason,
        curatedAsOf: CURATED_AS_OF,
      };
    }

    // Curated FIRST (vetted rows lead the list) and winning any transportUrl collision, so a
    // community entry can never impersonate or displace a vetted server.
    const seen = new Set(curated.map((s) => s.transportUrl));
    const community = upstream.servers.filter(
      (s) => matchesQuery(s, q) && !seen.has(s.transportUrl),
    );
    return {
      servers: [...curated, ...community].slice(0, limit),
      source: "registry",
      curatedAsOf: CURATED_AS_OF,
    };
  }

  /** Fetch + sanitize the upstream list (cached). Returns a reason instead of throwing. */
  private async fetchUpstream(): Promise<
    { ok: true; servers: McpRegistryServer[] } | { ok: false; reason: string }
  > {
    const now = Date.now();
    if (this.cache && now - this.cache.at < REGISTRY_CACHE_MS) {
      return { ok: true, servers: this.cache.servers };
    }
    if (this.failure && now - this.failure.at < REGISTRY_FAILURE_CACHE_MS) {
      return { ok: false, reason: this.failure.reason };
    }
    const url = this.registryUrl();
    let res: Response;
    try {
      res = await __mcpRegistryDeps.fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
    } catch (e) {
      // Match by name too — `instanceof` can miss across a module/mock boundary (same caveat as
      // introspect.service.ts).
      const blocked =
        e instanceof BlockedEgressError ||
        (e instanceof Error && e.name === "BlockedEgressError");
      // The URL is an operator-configured constant, so logging it is safe; no tenant data involved.
      log.warn(
        {
          registryUrl: url,
          blocked,
          errorName: e instanceof Error ? e.name : "unknown",
        },
        "MCP registry fetch failed — serving the curated list",
      );
      return this.fail(
        blocked
          ? "the configured registry URL is not a permitted public host"
          : "the MCP registry could not be reached",
      );
    }
    if (!res.ok) {
      log.warn(
        { registryUrl: url, httpStatus: res.status },
        "MCP registry returned a non-200 — serving the curated list",
      );
      return this.fail(`the MCP registry returned ${res.status}`);
    }
    // Refuse an oversized body BEFORE parsing it. content-length is only a hint, so the parsed text
    // is re-checked.
    const advertised = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(advertised) && advertised > MAX_REGISTRY_BYTES) {
      return this.fail("the MCP registry response was too large");
    }
    let body: unknown;
    try {
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > MAX_REGISTRY_BYTES) {
        return this.fail("the MCP registry response was too large");
      }
      body = JSON.parse(text);
    } catch {
      return this.fail("the MCP registry response was not valid JSON");
    }
    const servers = sanitizeRegistryResponse(body);
    if (servers.length === 0) {
      // A well-formed response with no connectable remote server in it is indistinguishable, from
      // the user's point of view, from an outage — degrade rather than show an empty browser.
      return this.fail("the MCP registry returned no connectable servers");
    }
    this.cache = { at: now, servers };
    this.failure = null; // recovered
    return { ok: true, servers };
  }

  /** Record a failure in the negative cache and return it. */
  private fail(reason: string): { ok: false; reason: string } {
    this.failure = { at: Date.now(), reason };
    return { ok: false, reason };
  }

  /** Test seam: drop both the success and failure caches. */
  clearCache(): void {
    this.cache = null;
    this.failure = null;
  }
}
