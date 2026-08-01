/**
 * Authoring-time SQL schema introspection (#1004) — "what tables and columns does this connection
 * have?", so the `sqlQuery` / `sqlExec` editor can autocomplete them.
 *
 * WHY THIS IS ON THE CONTROL PLANE, not in an activity. CLAUDE.md Tier-1 §3 puts side effects in
 * activities; that rule is about WORKFLOW execution. This is an authoring affordance — the canvas
 * needs the answer live, while a user is typing, with no run in flight. The precedent is the
 * sibling `ConnectionTestService` (control-plane egress to a tenant-configured host) and the
 * existing `POST /introspect/{openapi,graphql}` routes on this very controller.
 *
 * WHY `information_schema` AND NOT `prisma db pull`: see packages/sql/src/schema.ts. In short,
 * Prisma would put an engine binary in the API image to get back a DSL we would then parse into
 * the table/column list we could just have SELECTed. Reusing `SqlEngineAdapter.runReadOnly`
 * inherits the read-only enforcement, the SSRF connect-pinning (#597) and the in-memory-only DSN
 * handling that were already built and audited for the node.
 *
 * SECRETS (Tier-1 §4). The DSN is resolved INSIDE `introspect()` and never leaves it: it is not a
 * parameter (so no `@Traced` span attribute can carry it), it is never logged, and it is never in
 * a response — including error responses, which is the subtle one: `pg`/`mysql2`/`tedious`
 * connection errors put the host, port and sometimes the user in `e.message`. Driver messages are
 * therefore mapped to a fixed set of our own strings, exactly as the worker activity does.
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  BlockedEgressError,
  MissingConnectionTokenError,
  NeedsReauthError,
  resolveDbConnection,
  resolvePinnedHost,
} from "@naary/connections";
import {
  type SqlSchemaSummary,
  buildSchemaQuery,
  dsnHost,
  getAdapter,
  summarizeSchemaRows,
} from "@naary/sql";

/**
 * How long a query gets. A catalog scan on a big database is not instant, but this is a person
 * waiting on an editor, not a workflow step — the node's own 30s default is the right order.
 */
const INTROSPECT_TIMEOUT_MS = 20_000;

/**
 * Server-side cache TTL.
 *
 * CACHING, and how it is invalidated (the question #1004 asks explicitly):
 *  - The load-bearing half is CLIENT-side: the editor caches by `connectionId`, so typing in the
 *    SQL box never refetches. Without that, no server cache would stop per-keystroke traffic.
 *  - This server cache exists for the OTHER pressure: several editors/tabs on the same connection
 *    hammering the tenant database. Keyed `tenantId:connectionId`, and PER API INSTANCE — behind a
 *    rolling deploy or multiple containers there is no global coherence, which is fine for a TTL
 *    cache of a display list, but is stated rather than implied.
 *  - Invalidation is explicit, not just temporal: `refresh: true` bypasses AND replaces the entry.
 *    That is wired to a Refresh button in the editor, because a TTL alone does NOT answer the real
 *    failure mode — autocompleting a column that was dropped five minutes ago. A user who just
 *    migrated their database needs a way to say so, and 5 minutes of staleness is the worst case
 *    for everyone who has not.
 */
const CACHE_TTL_MS = 5 * 60_000;

/** Bound the cache itself — one entry per connection, but a tenant can have many connections. */
const CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  at: number;
  summary: SqlSchemaSummary;
}

/**
 * Swappable I/O seam (the house pattern — cf. the worker's `__sqlDeps` and this app's
 * `__connTestDeps`) so tests exercise the real service against a fake database. Defaults are the
 * hardened real thing.
 */
export const __sqlIntrospectDeps = {
  resolveDbConnection,
  resolvePinnedHost,
  getAdapter,
  now: () => Date.now(),
};

@Injectable()
export class SqlSchemaService {
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * List the tables + columns `connectionId` can see. Returns a summary even when the credential
   * can only see part of the database (or none of it) — a partial schema must degrade to
   * "autocomplete what we can see", never an error that blocks authoring.
   */
  async introspect(
    tenantId: string,
    connectionId: string,
    opts: { refresh?: boolean } = {},
  ): Promise<SqlSchemaSummary> {
    if (typeof connectionId !== "string" || connectionId.trim() === "") {
      throw new BadRequestException("A connectionId is required.");
    }
    const key = `${tenantId}:${connectionId}`;
    if (!opts.refresh) {
      const hit = this.cache.get(key);
      if (hit && __sqlIntrospectDeps.now() - hit.at < CACHE_TTL_MS) {
        return hit.summary;
      }
    }

    let summary: SqlSchemaSummary;
    try {
      // The DSN is born and dies inside this block. Nothing below puts it in a variable that
      // outlives the call, in a log line, or in a thrown message.
      const { engine, dsn } = await __sqlIntrospectDeps.resolveDbConnection(
        tenantId,
        connectionId,
      );
      const host = dsnHost(dsn);
      // Same SSRF pre-flight the node does: resolve once, reject private/reserved, then pin the
      // driver's socket to the address we checked so DNS cannot answer differently at connect time.
      const pinnedHost = host
        ? await __sqlIntrospectDeps.resolvePinnedHost(host)
        : undefined;
      const { rows } = await __sqlIntrospectDeps
        .getAdapter(engine)
        .runReadOnly(dsn, buildSchemaQuery(engine), [], {
          timeoutMs: INTROSPECT_TIMEOUT_MS,
          pinnedHost,
        });
      summary = summarizeSchemaRows(rows);
    } catch (e) {
      throw this.toSafeError(e);
    }

    // A credential with no visible objects is NOT an error: every engine's catalog is
    // privilege-filtered, so this is the "you can see nothing here" case. Say so, and let the
    // user carry on writing SQL by hand.
    if (summary.tables.length === 0 && !summary.note) {
      summary = {
        ...summary,
        note:
          "No tables were visible to this connection's credential. You can still write SQL by " +
          "hand — autocomplete just has nothing to offer.",
      };
    }

    this.remember(key, summary);
    return summary;
  }

  private remember(key: string, summary: SqlSchemaSummary): void {
    // Cheap bound: drop the oldest insertion when full (Map preserves insertion order).
    if (this.cache.size >= CACHE_MAX_ENTRIES && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(key);
    this.cache.set(key, { at: __sqlIntrospectDeps.now(), summary });
  }

  /**
   * Map a thrown error to a user-facing exception with a message WE wrote.
   *
   * `e.message` is never echoed for anything but our own typed errors: a `pg`/`mysql2`/`tedious`
   * failure carries the host and port (and `ECONNREFUSED …` style detail) that would then land in
   * a browser console, a Sentry breadcrumb or a support screenshot. Tier-1 §4.
   */
  private toSafeError(e: unknown): Error {
    if (e instanceof BlockedEgressError) {
      return new BadRequestException(
        "That database host isn't allowed — it must be a public host (private/reserved addresses are blocked).",
      );
    }
    if (e instanceof MissingConnectionTokenError) {
      return new BadRequestException(
        "This connection has no stored connection string yet. Add one, then try again.",
      );
    }
    if (e instanceof NeedsReauthError) {
      return new BadRequestException(
        "This connection's stored credential is no longer valid — reconnect it.",
      );
    }
    const message = e instanceof Error ? e.message : "";
    // `resolveDbConnection` throws these two by message (it predates typed errors) — they are OUR
    // strings, so they carry no DSN and are safe to reflect.
    if (/^Unknown connection /.test(message)) {
      return new NotFoundException(message);
    }
    if (/is not a SQL database connection$/.test(message)) {
      return new BadRequestException(
        "That connection is not a SQL database connection.",
      );
    }
    return new ServiceUnavailableException(
      "Could not read the schema from that database (it may be unreachable, or the credential may " +
        "lack permission). Check the connection and try again.",
    );
  }
}
