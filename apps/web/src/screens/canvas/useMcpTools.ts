/**
 * The tools an MCP connection's server offers, fetched once per connection and shared across every
 * control that asks.
 *
 * Why FETCH rather than pin the schema onto the node: the names are only needed while authoring,
 * when the browser is online anyway, and a pinned copy would need its own key on the `mcpTool`
 * config — which has to pass the typed-DSL zod schema and the drift guard, and would then go stale
 * against the server with nothing to notice. Nothing here is stored in the graph: what gets stored
 * is the name the author picked, exactly as if they had typed it.
 *
 * Failure is not an error state to recover from — it degrades to an empty list, and every control
 * built on it falls back to free text. An unreachable MCP server must never make a node uneditable.
 */
import { useEffect, useState } from "react";
import type { McpToolSummary } from "@naary/dsl";
import { api, HttpError } from "../../lib/api";
import { useWorkspace } from "../../workspace/WorkspaceProvider";

export interface McpToolsState {
  tools: McpToolSummary[];
  loading: boolean;
  /** Why the list is empty, when it's empty because the fetch failed. Shown, never thrown. */
  error?: string;
  /** Ask again — a server that was down, or a connection that was just authorized. */
  reload: () => void;
}

/**
 * Module-level cache keyed by tenant+connection, holding the in-flight PROMISE (not just the
 * result), so the inspector's several controls and a re-opened panel share one request instead of
 * each firing their own. Rejections are cached too — deliberately: a server that just refused is
 * not worth re-asking on every keystroke-triggered render. `reload()` drops the entry.
 */
const cache = new Map<string, Promise<McpToolSummary[]>>();

function keyOf(tenantId: string, connectionId: string): string {
  return `${tenantId}\0${connectionId}`;
}

export function useMcpTools(connectionId: string | undefined): McpToolsState {
  const { activeId: tenantId } = useWorkspace();
  const [tools, setTools] = useState<McpToolSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Bumped by reload() to re-run the effect after the cache entry is dropped.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!tenantId || !connectionId) {
      setTools([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    const key = keyOf(tenantId, connectionId);
    let pending = cache.get(key);
    if (!pending) {
      pending = api.listMcpTools(tenantId, connectionId);
      cache.set(key, pending);
    }
    // `cancelled` so a fast connection switch can't let the earlier server's tools land on the
    // later connection's control — which would offer names the chosen server doesn't have.
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    pending.then(
      (list) => {
        if (cancelled) return;
        setTools(list);
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setTools([]);
        // The SERVER's wording when it gave one ("this connection needs to be authorized",
        // "…has no Server URL") — that names what to fix. `HttpError.message` is the bare
        // "GET /path → 503", which tells an author nothing they can act on.
        setError(
          (e instanceof HttpError ? e.serverMessage : undefined) ??
            (e instanceof Error
              ? e.message
              : "Couldn't list this server's tools."),
        );
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId, connectionId, nonce]);

  return {
    tools,
    loading,
    error,
    reload: () => {
      if (tenantId && connectionId) cache.delete(keyOf(tenantId, connectionId));
      setNonce((n) => n + 1);
    },
  };
}
