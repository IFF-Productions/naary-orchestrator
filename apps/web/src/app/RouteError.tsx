import { useEffect } from "react";
import { useRouteError } from "react-router-dom";
import { isChunkLoadError, reloadForFreshChunks } from "../lib/chunk-reload";

/**
 * Root `errorElement` for the data router. Two cases:
 *  - a **stale-chunk** error (a lazy route's asset 404'd after a new deploy) → reload to fetch the
 *    fresh build (guarded against loops); show a brief "updating" state while it reloads;
 *  - any other render/loader error → a calm, branded fallback with Reload + Go home, instead of
 *    React Router's default developer message.
 */
export function RouteError() {
  const error = useRouteError();
  const chunkError = isChunkLoadError(error);

  useEffect(() => {
    if (chunkError) reloadForFreshChunks();
  }, [chunkError]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 24,
        textAlign: "center",
        background: "var(--bg)",
        color: "var(--ink-2)",
      }}
    >
      <div
        style={{
          fontSize: 16,
          fontWeight: "var(--weight-semibold)",
          color: "var(--ink)",
        }}
      >
        {chunkError
          ? "Updating to the latest version…"
          : "Something went wrong"}
      </div>
      <div style={{ fontSize: 13, maxWidth: 420 }}>
        {chunkError
          ? "A new version was just deployed. Reloading to pick it up — if this hangs, reload manually."
          : "An unexpected error interrupted this page. Reloading usually fixes it."}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
        {!chunkError && (
          <a href="/app" className="btn btn-secondary btn-sm">
            Go home
          </a>
        )}
      </div>
    </div>
  );
}
