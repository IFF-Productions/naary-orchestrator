import { useSyncExternalStore } from "react";
import { getActiveEnvironment, subscribeActiveEnvironment } from "./api";

/**
 * The active environment slug/id, re-rendering the component when it changes. Backed by the api
 * client's env store via useSyncExternalStore (tear-free), so switching environments updates the
 * whole UI live instead of forcing a full page reload. `null` → no env selected (server default).
 */
export function useActiveEnvironment(): string | null {
  return useSyncExternalStore(
    subscribeActiveEnvironment,
    getActiveEnvironment,
    () => null, // SSR/first snapshot: none selected
  );
}
