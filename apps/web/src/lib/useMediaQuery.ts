import { useSyncExternalStore } from "react";

// One MediaQueryList per distinct query, reused across renders/components. useSyncExternalStore
// calls getSnapshot on every render, so creating a fresh MQL each time would churn objects AND
// desync the snapshot's MQL from the subscribed one. The cache keeps them the same instance.
const mqlCache = new Map<string, MediaQueryList>();
function getMql(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  let mql = mqlCache.get(query);
  if (!mql) {
    mql = window.matchMedia(query);
    mqlCache.set(query, mql);
  }
  return mql;
}

/**
 * Subscribe to a CSS media query and re-render only when it flips (not on every
 * resize pixel). Backed by `matchMedia` via useSyncExternalStore so it's SSR-safe
 * and tear-free. Returns the current match.
 *
 * Breakpoints mirror the Naary redesign shell exactly: phone `<= 640px`, the
 * drawer threshold `<= 1024px`, and desktop `> 1024px` (see AppShell).
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = getMql(query);
      if (!mql) return () => {};
      // Prefer the modern API; fall back to the deprecated addListener/removeListener for
      // older Safari and some matchMedia polyfills (test envs) that lack addEventListener.
      if (mql.addEventListener) {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    },
    () => getMql(query)?.matches ?? false,
    // Server snapshot: no query matches (SSR renders the mobile-first / base branch — e.g.
    // both PHONE and DESKTOP read false). The client re-evaluates on hydration.
    () => false,
  );
}

/** `<= 640px` — phone: table rows render as stacked cards; tightest chrome. */
export const PHONE_QUERY = "(max-width: 640px)";
/**
 * `<= 1024px` — the shell nav collapses to a hamburger slide-out drawer and the
 * context bar wraps (workspace + variant move into the drawer). Covers phone +
 * tablet as one range; the old tablet icon-rail is gone.
 */
export const BELOW_RAIL_QUERY = "(max-width: 1024px)";
/** Alias of {@link BELOW_RAIL_QUERY} — reads clearer at the shell's drawer call sites. */
export const BELOW_DRAWER_QUERY = "(max-width: 1024px)";
/** `> 1024px` — desktop: the full five-mode rail (with manual collapse) is shown. */
export const DESKTOP_QUERY = "(min-width: 1025px)";
