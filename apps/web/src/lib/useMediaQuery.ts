import { useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query and re-render only when it flips (not on every
 * resize pixel). Backed by `matchMedia` via useSyncExternalStore so it's SSR-safe
 * and tear-free. Returns the current match.
 *
 * Breakpoints mirror the Naary design comp exactly: phone `< 720px`, and the
 * icon-rail threshold `< 1080px` (see AppShell).
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(query).matches
        : false,
    // Server snapshot: no query matches (SSR renders the mobile-first / base branch — e.g.
    // both PHONE and DESKTOP read false). The client re-evaluates on hydration.
    () => false,
  );
}

/** `< 720px` — sidebar becomes a slide-in drawer + a hamburger appears. */
export const PHONE_QUERY = "(max-width: 719px)";
/** `< 1080px` — sidebar auto-collapses to the 70px icon rail (tablet). */
export const BELOW_RAIL_QUERY = "(max-width: 1079px)";
/** `>= 1080px` — the topbar search box is shown. */
export const DESKTOP_QUERY = "(min-width: 1080px)";
