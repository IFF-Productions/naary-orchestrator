import type { NextFunction, Request, Response } from "express";

/**
 * CORS for the ANONYMOUS public ingress — `GET|POST /forms/:id` and `/chat/:id` — so a tenant can
 * embed a form/chat NATIVELY (their own JS calls our API cross-origin), not just via an iframe
 * (docs/design/EMBEDDED-PUBLIC-PAGES.md, Slice 3). These endpoints have NO cookies/credentials, so
 * `Access-Control-Allow-Origin: *` leaks nothing (we never set Allow-Credentials) — CORS here is
 * ENABLEMENT, not a security control. The real protection stays with Turnstile (+ its hostname
 * allowlist), the per-IP / per-endpoint rate limits, and the tenant budget cap — all origin-
 * independent, and none of which CORS affects. Runs BEFORE the app's own `enableCors` allowlist,
 * which still governs every authenticated route.
 *
 * (Per-tenant origin RESTRICTION is a documented follow-up; it would be a soft, browser-only,
 * spoofable control — bots ignore CORS — so it adds product control, not security.)
 */

/** The public embed ingress paths: `/forms/:id` and `/chat/:id` (the API sees paths without the
 *  nginx `/api` prefix). Matches the single-segment id only — NOT the authed admin list routes. */
export function isPublicEmbedPath(path: string): boolean {
  return /^\/(forms|chat)\/[^/]+\/?$/.test(path);
}

export function publicCors(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isPublicEmbedPath(req.path)) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "content-type");
    res.header("Access-Control-Max-Age", "86400");
    res.header("Vary", "Origin");
    // Answer the preflight here (anonymous route, nothing to auth) so it never falls through to the
    // app's allowlist enableCors (which would omit the header for a foreign origin → browser blocks).
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
  }
  next();
}
