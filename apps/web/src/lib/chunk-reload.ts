/**
 * Stale-chunk recovery. The SPA code-splits every route into hash-named assets. When a new version
 * deploys, a client still running the OLD build holds an `index.html` that points at hashes the
 * server no longer has — so the next lazy route navigation fails to fetch/preload its JS or CSS
 * chunk (Vite: "Unable to preload CSS for …" / "Failed to fetch dynamically imported module").
 *
 * The fix is to reload: a fresh `index.html` names the CURRENT chunks. We handle it in two places —
 * Vite's `vite:preloadError` event (main.tsx) and the router's `errorElement` (a lazy import can
 * reject without firing the preload event) — both routed through `reloadForFreshChunks` so the loop
 * guard is shared.
 */
const RELOAD_AT_KEY = "naary_chunk_reload_at";
const RELOAD_WINDOW_MS = 10_000;

/**
 * Reload to pick up freshly-deployed assets. Rate-limited to once per {@link RELOAD_WINDOW_MS}: if a
 * reload doesn't fix it (a CDN still serving a stale `index.html`, or the client is offline) we must
 * NOT reload-loop — the caller then shows a manual "Reload" affordance instead.
 */
export function reloadForFreshChunks(): void {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_AT_KEY) || 0);
    if (Date.now() - last < RELOAD_WINDOW_MS) return; // just tried — don't loop
    sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
  } catch {
    // sessionStorage can throw (private mode / disabled) — fall through to a best-effort reload.
  }
  window.location.reload();
}

/** True when `error` looks like a failed dynamic-import / asset preload (a stale-chunk deploy). */
export function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /Unable to preload|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    msg,
  );
}
