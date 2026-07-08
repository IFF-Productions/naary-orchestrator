import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Product variant (design docs/design/PRODUCT-VARIANTS.md). "builder" = the full canvas (power
 * users); "simple" = describe-in-English + a friendly step list (non-developers). ONE engine —
 * a Simple automation is a normal graph. Per-user preference, stored client-side (a DB-backed
 * pref is a later slice). Defaults to "builder" so existing users are unaffected until they opt in.
 */
export type Mode = "builder" | "simple";

interface ModeContextValue {
  mode: Mode;
  setMode: (m: Mode) => void;
  toggleMode: () => void;
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

  const setMode = useCallback((m: Mode) => setModeState(m), []);
  const toggleMode = useCallback(
    () => setModeState((m) => (m === "builder" ? "simple" : "builder")),
    [],
  );

  const value = useMemo(
    () => ({ mode, setMode, toggleMode }),
    [mode, setMode, toggleMode],
  );
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error("useMode must be used within ModeProvider");
  return ctx;
}
