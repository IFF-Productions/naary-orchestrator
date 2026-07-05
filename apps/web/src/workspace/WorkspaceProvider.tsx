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
  /** Failed to load the workspace list (network/server). */
  error?: string;
  /** Switch the active workspace (persists + re-scopes subsequent requests). */
  setActive: (id: string) => void;
  /** Create a new workspace and switch to it. Throws on failure (caller surfaces it). */
  create: () => Promise<Workspace>;
  /** Re-fetch the workspace list. */
  refresh: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceState | undefined>(undefined);

/** Pick the active workspace: keep the persisted one if still valid, else the first. */
function resolveActive(list: Workspace[]): string | null {
  if (list.length === 0) return null;
  const persisted = getActiveWorkspace();
  if (persisted && list.some((w) => w.tenantId === persisted)) return persisted;
  return list[0].tenantId;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

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
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
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

  const create = useCallback(async (): Promise<Workspace> => {
    const ws = await api.createWorkspace();
    await load();
    setActive(ws.tenantId);
    return ws;
  }, [load, setActive]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const value: WorkspaceState = {
    loading,
    workspaces,
    activeId,
    needsWorkspace: !loading && !error && workspaces.length === 0,
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
