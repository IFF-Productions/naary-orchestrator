/**
 * The SQL node editor's schema cache (#1004).
 *
 * This is the LOAD-BEARING half of the caching story. The editor must not re-introspect per
 * keystroke, and a request-per-render would do exactly that: `ConfigPanel` re-renders on every
 * character typed into the SQL box, and it REMOUNTS every time the user selects a different node.
 * So the cache is a module-level Map keyed by `connectionId`, which survives both — component
 * state would not.
 *
 * Invalidation:
 *  - `ttlMs` (default 5 min) bounds staleness, matching the API's own TTL.
 *  - `refresh()` clears the entry and refetches with `refresh: true`, so the SERVER cache is
 *    replaced too. That is the real answer to "someone dropped a column five minutes ago": a TTL
 *    alone leaves the editor confidently completing a column that no longer exists, and the user
 *    who just ran the migration is precisely the person who knows to press the button.
 *  - Switching the node's connection switches the key, so a different database is never a stale hit.
 *
 * An in-flight promise is cached too, so N simultaneous mounts on the same connection make ONE
 * request rather than N.
 */
import { useCallback, useEffect, useReducer } from "react";
import type { SqlSchemaSummary } from "@naary/dsl";
import { api } from "../lib/api";

interface Entry {
  at: number;
  summary?: SqlSchemaSummary;
  error?: string;
  inflight?: Promise<void>;
}

const CACHE = new Map<string, Entry>();
const DEFAULT_TTL_MS = 5 * 60_000;

/** Test/story seam — drop everything the cache knows. */
export function __clearSqlSchemaCache(): void {
  CACHE.clear();
}

export interface SqlSchemaState {
  schema: SqlSchemaSummary | null;
  loading: boolean;
  /** A user-facing message. Introspection failing must never block authoring, so this is shown
   *  as a hint next to the field, not as a blocking error. */
  error: string | null;
  refresh: () => void;
}

export function useSqlSchema(
  connectionId: string | undefined,
  opts: { ttlMs?: number } = {},
): SqlSchemaState {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const id = connectionId?.trim() ?? "";
  // Re-render when the shared cache changes under us (the cache is module state, not React state).
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const load = useCallback(
    (forceRefresh: boolean) => {
      if (!id) return;
      const existing = CACHE.get(id);
      if (!forceRefresh) {
        // A request already in flight for this connection: join it rather than issuing a second.
        if (existing?.inflight) return;
        if (existing && Date.now() - existing.at < ttlMs) return;
      }
      const entry: Entry = { at: Date.now() };
      CACHE.set(id, entry);
      entry.inflight = api
        .introspectSqlSchema(id, forceRefresh)
        .then((summary) => {
          entry.summary = summary;
        })
        .catch((e: unknown) => {
          entry.error =
            e instanceof Error ? e.message : "Could not read the schema.";
        })
        .finally(() => {
          entry.inflight = undefined;
          entry.at = Date.now();
          bump();
        });
      bump();
    },
    [id, ttlMs],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const entry = id ? CACHE.get(id) : undefined;
  const refresh = useCallback(() => load(true), [load]);
  return {
    schema: entry?.summary ?? null,
    loading: !!entry?.inflight,
    error: entry?.error ?? null,
    refresh,
  };
}
