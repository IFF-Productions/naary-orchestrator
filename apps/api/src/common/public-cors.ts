import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * CORS for the ANONYMOUS public ingress — `GET|POST /forms/:id` and `/chat/:id` — so a tenant can
 * embed a form/chat NATIVELY (their own JS calls our API cross-origin), not just via an iframe
 * (docs/design/EMBEDDED-PUBLIC-PAGES.md, Slices 3–4). These endpoints have NO cookies/credentials
 * (we never set Allow-Credentials), so CORS here is ENABLEMENT, not a security control. The real
 * protection stays with Turnstile (+ its hostname allowlist), the per-IP / per-endpoint rate limits,
 * and the tenant budget cap — all origin-independent, and none of which CORS affects. Runs BEFORE
 * the app's own `enableCors` allowlist, which still governs every authenticated route.
 *
 * PER-TENANT ORIGIN RESTRICTION (#617). A tenant can now narrow this to their own sites by listing
 * domains in Settings → "Bot protection & embed domains". Semantics:
 *
 *  - CONFIGURED (non-empty list) ⇒ reflect ONLY a matching origin (`Access-Control-Allow-Origin:
 *    <that exact origin>`), never `*`; a foreign origin gets no ACAO header at all, so the browser
 *    blocks the response.
 *  - NOT CONFIGURED (empty list — today's state for every existing tenant) ⇒ `*`, exactly as
 *    before. Nothing breaks for embeds that already work.
 *  - `Vary: Origin` is set on EVERY public-embed response (both branches) so a shared cache can
 *    never serve one origin's ACAO to another.
 *  - the list is the SAME field the Turnstile hostname allowlist uses, so it holds HOSTNAMES —
 *    matching therefore compares the request origin's hostname and ignores scheme/port. That's
 *    deliberate: tightening scheme/port would buy nothing (an `Origin` header is client-supplied
 *    and trivially forged by a non-browser client) while breaking http/localhost embeds.
 *
 * Because it is browser-only and spoofable, this is PRODUCT CONTROL, not security: a bot ignores
 * CORS entirely and still reaches the endpoint, where Turnstile + the rate limits + the budget cap
 * decide. Nothing here may become the only thing between a bot and a workflow start.
 *
 * The response never carries a tenant identifier — we echo back only the caller's OWN origin (or
 * `*`), never a stored value, and never anything derived from the tenant/env/workflow ids.
 */

/** The public embed ingress paths: `/forms/:id` and `/chat/:id` (the API sees paths without the
 *  nginx `/api` prefix). Matches the single-segment id only — NOT the authed admin list routes. */
export function isPublicEmbedPath(path: string): boolean {
  return /^\/(forms|chat)\/[^/]+\/?$/.test(path);
}

/** The kind + opaque id behind a public embed path, or null when the path isn't one. */
export function parsePublicEmbedPath(
  path: string,
): { kind: "form" | "chat"; id: string } | null {
  const m = /^\/(forms|chat)\/([^/]+)\/?$/.exec(path);
  if (!m) return null;
  return { kind: m[1] === "forms" ? "form" : "chat", id: m[2] };
}

/**
 * Resolves the allowed embed HOSTNAMES for a public embed path (empty ⇒ unrestricted). Injected so
 * the middleware stays a pure function of (request, resolver) and unit-testable with no DB. A throw
 * is treated as "unrestricted" (fail-permissive: a DB blip must not break every tenant's live
 * embeds — and per the framing above, this is not a security gate).
 */
export type EmbedOriginResolver = (path: string) => Promise<string[]>;

/** The request's `Origin` header (first value if duplicated), or undefined. */
function originHeader(req: Request): string | undefined {
  const raw = (req.headers as Record<string, string | string[] | undefined>)
    ?.origin;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  // "null" is what a browser sends for an opaque origin (sandboxed iframe, file://) — never matchable.
  return trimmed && trimmed !== "null" ? trimmed : undefined;
}

/** The lowercased hostname of an `Origin` value, or null when it isn't a usable http(s) origin. */
export function originHostname(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Is this origin allowed by a (non-empty) hostname allowlist? Exact hostname match, no wildcards —
 *  the same matching rule as the Turnstile solved-hostname check that shares the list. */
export function originAllowed(
  origin: string | undefined,
  allowedHostnames: string[],
): boolean {
  if (!origin) return false;
  const host = originHostname(origin);
  return host !== null && allowedHostnames.includes(host);
}

/** The invariant headers for a public-embed response (everything except ACAO). */
function baseHeaders(res: Response): void {
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "content-type");
  res.header("Access-Control-Max-Age", "86400");
  // Set whether or not the origin is allowed, so a cache keys on the origin either way.
  res.header("Vary", "Origin");
}

/** Answer the preflight here (anonymous route, nothing to auth) so it never falls through to the
 *  app's allowlist enableCors (which would omit the header for a foreign origin → browser blocks). */
function finish(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

/**
 * Build the public-embed CORS middleware. With NO resolver this is exactly the pre-#617 permissive
 * behaviour, and fully synchronous; with one, a tenant's configured domains narrow it.
 */
export function makePublicCors(resolve?: EmbedOriginResolver): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isPublicEmbedPath(req.path)) {
      next();
      return;
    }
    baseHeaders(res);
    if (!resolve) {
      res.header("Access-Control-Allow-Origin", "*");
      finish(req, res, next);
      return;
    }
    void (async () => {
      let allowed: string[] = [];
      try {
        allowed = await resolve(req.path);
      } catch {
        allowed = []; // fail-permissive — see EmbedOriginResolver
      }
      if (allowed.length === 0) {
        res.header("Access-Control-Allow-Origin", "*");
      } else {
        const origin = originHeader(req);
        if (origin && originAllowed(origin, allowed)) {
          // Reflect the caller's OWN origin (never a stored one — no tenant data leaves here).
          res.header("Access-Control-Allow-Origin", origin);
        }
        // else: no ACAO → the browser blocks the response. The request itself still executes;
        // Turnstile / rate limits / budget are what actually protect it.
      }
      finish(req, res, next);
    })();
  };
}

/** Default (permissive) instance — for callers/tests that don't need per-tenant narrowing. */
export const publicCors: RequestHandler = makePublicCors();
