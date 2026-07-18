/**
 * The caller's effective workflow permissions in the ACTIVE workspace + environment
 * (GET /me/permissions) — the SPA's affordance-gating source (RBAC-GROUPS.md, G2).
 *
 * Fetched ONCE per workspace+environment (module cache): the WorkspaceProvider remounts
 * the whole subtree on a workspace switch and AppShell keys the routed screen by the
 * active environment, so a consuming screen remounts — and re-runs the effect — exactly
 * when the scope changes. Returns null while loading / on error: callers treat null as
 * "don't gate" (the API is the enforcement; a hidden-but-forced request still 403s).
 */
import { useEffect, useState } from "react";
import { api, type EffectivePermissions, getActiveWorkspace } from "./api";
import { useActiveEnvironment } from "./useActiveEnvironment";

const cache = new Map<string, EffectivePermissions>();

/** Drop every cached matrix — call after any group/grant write so the next mount
 *  re-fetches (the Groups screen does). */
export function invalidateMyPermissions(): void {
  cache.clear();
}

export function usePermissions(): EffectivePermissions | null {
  const env = useActiveEnvironment();
  const key = `${getActiveWorkspace() ?? ""}|${env ?? ""}`;
  const [perms, setPerms] = useState<EffectivePermissions | null>(
    () => cache.get(key) ?? null,
  );

  useEffect(() => {
    const hit = cache.get(key);
    if (hit) {
      setPerms(hit);
      return;
    }
    let live = true;
    api
      .getMyPermissions()
      .then((p) => {
        cache.set(key, p);
        if (live) setPerms(p);
      })
      .catch(() => {
        // Unknowable (offline, signed out) — leave null: affordances stay visible,
        // the server still enforces.
        if (live) setPerms(null);
      });
    return () => {
      live = false;
    };
  }, [key]);

  return perms;
}
