import type { INestApplication } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/**
 * Cache hardening for the whole API (#1038).
 *
 * The Runs page hung on its skeleton because production answered `GET /executions` with a **304
 * Not Modified**. Two defaults combined to make that possible:
 *
 *  - Express's **ETag is on by default**, so every JSON response carried a validator;
 *  - nothing set `Cache-Control`, so the response was *heuristically* cacheable.
 *
 * That is enough for the browser — or the CDN in front of this deployment — to revalidate, and a
 * bare 304 reaching a `fetch()` that expected data is a dead end (the client has no cached copy to
 * substitute). `/executions` is authenticated, per-tenant, environment-scoped and changes with
 * every run: there is nothing here a cache may legitimately reuse.
 *
 * So the fix is at the source — no validator, and an explicit `no-store` — which removes the ETag,
 * the revalidation and the 304 together. The client-side handling that survives a 304 anyway
 * (apps/web/src/lib/api/{http,client}.ts) is defence in depth, not the fix.
 *
 * ## Exemptions
 *
 * `no-store` here is a **default**, not a mandate: it is set at the start of the request, so any
 * handler that deliberately caches simply sets its own value and wins (a later `setHeader`
 * replaces an earlier one, and headers passed to `writeHead` take precedence over both). The
 * handlers that do so today, all of them intentional:
 *
 *  - `GET /forms/assets/:assetId` — anonymous, content-addressed form logos:
 *    `public, max-age=31536000, immutable` plus its own strong ETag and `If-None-Match` → 304
 *    branch (that 304 saves an S3 GetObject on every public page view). Disabling Express's
 *    automatic ETag does NOT affect it — it sets the header itself.
 *  - `GET /executions/:id/nodes/:nodeId/audio` — `private, max-age=300` on synthesized audio.
 *  - The SSE streams (`POST /graphs/generate/stream`, builder turns) — `no-cache` via `writeHead`.
 *
 * Every other public/anonymous route (the form and chat definitions, `/health`, `/metrics`, the
 * OAuth callbacks, the Turnstile config) sets no cache headers today, so `no-store` removes only
 * *incidental* heuristic caching that nobody designed — and those payloads are per-tenant and
 * change when a builder edits a form, which is exactly what must not be served stale.
 */

/** Sets the default `Cache-Control: no-store`. Exported for the spec; wired by applyCacheHardening. */
export function noStoreByDefault(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("cache-control", "no-store");
  next();
}

/** Disable Express's automatic ETag and default every response to `Cache-Control: no-store`. */
export function applyCacheHardening(app: INestApplication): void {
  // No validator ⇒ a client has nothing to send in `If-None-Match` ⇒ no conditional request to
  // answer with a 304. Explicit `res.setHeader("etag", …)` (the form-asset route) is unaffected.
  const httpAdapter = app.getHttpAdapter().getInstance() as {
    set?: (setting: string, value: unknown) => void;
  };
  httpAdapter.set?.("etag", false);
  app.use(noStoreByDefault);
}
