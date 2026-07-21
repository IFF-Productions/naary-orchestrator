/**
 * Feature-flags context (#491): fetches this workspace's flags (GET /me/flags) once and
 * exposes them to the app via {@link useFlag}. Mounted INSIDE the workspace subtree (below
 * WorkspaceProvider's `key={activeId}` remount), so switching workspace re-fetches under the
 * new tenant scope — flags are evaluated server-side keyed on tenantId.
 *
 * FAIL-SAFE: unlike WorkspaceProvider, this NEVER gates app render on its fetch. While loading,
 * and on any error, every flag resolves to its SAFE CODE DEFAULT ({@link WEB_FLAG_DEFAULTS}) —
 * the same value the server serves when the flag provider (Flagsmith) is unconfigured/unreachable.
 * A flags outage therefore reproduces "provider not wired" behavior, never a blank screen.
 */
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "../lib/api";

/**
 * SAFE code defaults, mirrored from the server catalog (`@naary/flags` FLAG_CATALOG). Kept as a
 * small web-local copy on purpose — the server package pulls the OpenFeature *server* SDK, which
 * has no place in the browser bundle. KEEP IN SYNC: add a flag here when you add it there, with
 * the SAME default. A kill-switch (a flag that hides a shipped feature) defaults `true`.
 */
export const WEB_FLAG_DEFAULTS = {
  "chat-rag": false,
  "new-canvas-inspector": false,
  "canvas-import-tools": true,
} as const;

/** Known flag keys — `useFlag` is typed to these so a typo is a compile error. */
export type FlagKey = keyof typeof WEB_FLAG_DEFAULTS;

/**
 * Resolve the effective flag map: the fetched values LAYERED OVER the code defaults. `fetched`
 * is null while loading or after a failed fetch → pure defaults (fail-safe). A known key absent
 * from `fetched` also falls back to its default; unknown fetched keys are ignored. Pure +
 * exported so the fail-safe behavior is unit-tested without rendering.
 */
export function resolveFlags(
  fetched: Record<string, boolean> | null,
): Record<FlagKey, boolean> {
  const out = { ...WEB_FLAG_DEFAULTS } as Record<FlagKey, boolean>;
  if (fetched) {
    for (const k of Object.keys(WEB_FLAG_DEFAULTS) as FlagKey[]) {
      if (typeof fetched[k] === "boolean") out[k] = fetched[k];
    }
  }
  return out;
}

const FlagsContext = createContext<Record<FlagKey, boolean> | undefined>(
  undefined,
);

export function FlagsProvider({ children }: { children: ReactNode }) {
  // Start on defaults so the very first render (and SSR-less hydration) is already safe.
  const [fetched, setFetched] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const flags = await api.getFlags();
        if (!cancelled) setFetched(flags);
      } catch {
        // Fail-safe: keep defaults. A flags outage must never break the app (or log noise —
        // the server already logs its own evaluation failures).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Memoize the resolved map so the context value is referentially STABLE across unrelated
  // parent re-renders — a fresh object each render would re-render every useFlag consumer
  // (React context compares by reference). Only a real fetch result flips the reference.
  const value = useMemo(() => resolveFlags(fetched), [fetched]);

  return (
    <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>
  );
}

/**
 * Read a single feature flag. Returns the SAFE default when used outside a FlagsProvider (e.g.
 * a Storybook story or a pre-workspace screen) — a missing provider degrades to defaults, it is
 * not an error, so a gated feature behaves exactly as it would with the flag provider down.
 */
export function useFlag(key: FlagKey): boolean {
  const ctx = useContext(FlagsContext);
  return (ctx ?? WEB_FLAG_DEFAULTS)[key];
}
