import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "./auth/AuthProvider";
import { api } from "./lib/api";

/**
 * Product variant (design docs/design/PRODUCT-VARIANTS.md). "builder" = the full canvas (power
 * users); "simple" = describe-in-English + a friendly step list (non-developers). ONE engine —
 * a Simple automation is a normal graph. Defaults to "builder" so existing users are unaffected
 * until they opt in.
 *
 * Persistence is two-tier: localStorage is the instant, offline cache (no first-paint flash);
 * the server (`/me/preferences`, keyed to the Firebase uid) is the cross-device source of truth.
 * `setMode` writes both (server write is fire-and-forget); `<ModeSync>` reconciles server→client
 * once the user is authenticated. API-token / signed-out sessions degrade to localStorage-only.
 */
export type Mode = "builder" | "simple";

function isMode(v: unknown): v is Mode {
  return v === "builder" || v === "simple";
}

interface ModeContextValue {
  mode: Mode;
  /** User action: updates state + localStorage AND persists to the server. */
  setMode: (m: Mode) => void;
  toggleMode: () => void;
  /** Server→client: updates state + localStorage WITHOUT re-persisting (used by ModeSync). */
  hydrate: (m: Mode) => void;
}

const ModeContext = createContext<ModeContextValue | null>(null);
const STORAGE_KEY = "naary-mode";

function initialMode(): Mode {
  return localStorage.getItem(STORAGE_KEY) === "simple" ? "simple" : "builder";
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(initialMode);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    // Persist across devices. Fire-and-forget: localStorage already holds it, so a failed
    // write (offline, or an API-token principal with no uid) is a no-op, not a regression.
    void api.savePreferences(m).catch(() => undefined);
  }, []);

  const toggleMode = useCallback(
    () => setMode(mode === "builder" ? "simple" : "builder"),
    [mode, setMode],
  );

  // Adopt the server value without echoing it back as a write (avoids a redundant PUT loop).
  const hydrate = useCallback((m: Mode) => setModeState(m), []);

  const value = useMemo(
    () => ({ mode, setMode, toggleMode, hydrate }),
    [mode, setMode, toggleMode, hydrate],
  );
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

/**
 * Reconciles the server preference into the client once authenticated. Must render INSIDE
 * AuthProvider (for useAuth) and ModeProvider (for useMode) — mount it in the AuthProvider
 * subtree. Renders nothing. The server is the source of truth on load, so a preference set on
 * another device wins over this device's stale localStorage.
 */
export function ModeSync() {
  const { ready, authenticated } = useAuth();
  const { mode, hydrate } = useMode();

  useEffect(() => {
    if (!ready || !authenticated) return;
    let live = true;
    void api
      .getPreferences()
      .then((p) => {
        // null = user never chose → keep whatever localStorage/default is showing.
        if (live && isMode(p.mode) && p.mode !== mode) hydrate(p.mode);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Run when auth resolves; `mode`/`hydrate` are intentionally excluded so a later local
    // toggle doesn't re-trigger a server fetch that would clobber the user's fresh choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated]);

  return null;
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error("useMode must be used within ModeProvider");
  return ctx;
}
