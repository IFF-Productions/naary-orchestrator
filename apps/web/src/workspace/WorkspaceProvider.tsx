/**
 * Workspace context: resolves the caller's workspaces (GET /me/workspaces), picks the
 * active one, and publishes it to the API client as the `X-Workspace-Id` header so every
 * subsequent request is scoped to it. Mounted inside RequireAuth (so a session/token
 * already exists). Gates the app on load, and surfaces the "no workspace yet" state so a
 * fresh signup lands on a create-workspace screen instead of a 401 loop (design §8).
 */
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  AccessNotAllowedError,
  type Workspace,
  api,
  getActiveWorkspace,
  setActiveWorkspace,
} from "../lib/api";

export interface WorkspaceState {
  /** Initial resolution finished (success or error). */
  loading: boolean;
  workspaces: Workspace[];
  /** The active workspace id (sent as X-Workspace-Id), or null before one is chosen. */
  activeId: string | null;
  /** Authenticated but belongs to no workspace → show the create screen. */
  needsWorkspace: boolean;
  /** Signed in, but the server's access allowlist rejected this user → show NotAvailable. */
  accessDenied: boolean;
  /** Failed to load the workspace list (network/server). */
  error?: string;
  /** Switch the active workspace (persists + re-scopes subsequent requests). */
  setActive: (id: string) => void;
  /** Create a new workspace (optionally named) and switch to it. Throws on failure. */
  create: (name?: string) => Promise<Workspace>;
  /** Re-fetch the workspace list. */
  refresh: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceState | undefined>(undefined);

/**
 * Pick the active workspace: keep the persisted one if still valid AND non-archived, else the
 * first non-archived. Archived workspaces are still IN the list (the server never drops them —
 * dropping would empty the list and strand the user on the create screen), so only when EVERY
 * workspace is archived do we fall back to the full list.
 */
function resolveActive(list: Workspace[]): string | null {
  if (list.length === 0) return null;
  const live = list.filter((w) => !w.archived);
  const pool = live.length > 0 ? live : list;
  const persisted = getActiveWorkspace();
  if (persisted && pool.some((w) => w.tenantId === persisted)) return persisted;
  return pool[0].tenantId;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [accessDenied, setAccessDenied] = useState(false);

  const load = useCallback(async (): Promise<Workspace[]> => {
    const list = await api.getMyWorkspaces();
    const next = resolveActive(list);
    // Publish to the API client BEFORE children render/fetch so requests carry the header.
    setActiveWorkspace(next);
    setWorkspaces(list);
    setActiveId(next);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await load();
      } catch (e) {
        if (cancelled) return;
        // A rejected user is a distinct state (NotAvailable screen), not a load error.
        if (e instanceof AccessNotAllowedError) setAccessDenied(true);
        else setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const setActive = useCallback((id: string) => {
    setActiveWorkspace(id);
    setActiveId(id);
  }, []);

  const create = useCallback(
    async (name?: string): Promise<Workspace> => {
      const ws = await api.createWorkspace(name);
      await load();
      setActive(ws.tenantId);
      return ws;
    },
    [load, setActive],
  );

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const value: WorkspaceState = {
    loading,
    workspaces,
    activeId,
    needsWorkspace:
      !loading && !error && !accessDenied && workspaces.length === 0,
    accessDenied,
    error,
    setActive,
    create,
    refresh,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {/* Remount the subtree on workspace switch so every screen re-fetches under the new
          scope — avoids stale, other-workspace data lingering after a switch. */}
      <div key={activeId ?? "none"} style={{ display: "contents" }}>
        {children}
      </div>
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext);
  if (!ctx)
    throw new Error("useWorkspace must be used within <WorkspaceProvider>");
  return ctx;
}
