import type { ExecutionContext } from "@nestjs/common";
import type { ThrottlerGetTrackerFunction } from "@nestjs/throttler";

/**
 * A SECOND rate-limit dimension for the anonymous public submit endpoints (`POST /forms/:formId`,
 * `POST /chat/:chatId`) AND the public webhook ingress (`POST /hooks/:endpointId`,
 * `POST /hooks/resume/:workflowId`), keyed PER ENDPOINT rather than per client IP (#616). The
 * per-IP `default` throttler (#618) doesn't bound a DISTRIBUTED flood — many IPs each stay under
 * their own limit while together hammering one endpoint. This per-endpoint bucket caps a single
 * endpoint's total rate regardless of how many IPs it comes from; for forms/chat it layers under
 * Turnstile (which stops bots) + the tenant budget cap (the cost backstop), and for webhooks under
 * the HMAC signature gate (an unsigned request is a cheap 401 — but 401s at flood rate still cost
 * an event-loop turn each, and VALID floods start workflows, so the cap bounds both).
 *
 * Wired as a named `public-endpoint` throttler whose per-throttler `getTracker`/`skipIf` the guard
 * honors over the ClientIpThrottlerGuard's method — so `default` still keys on the client IP and only
 * this throttler keys on the endpoint id, and it applies ONLY to the public submit routes.
 *
 * NB the throttler store is in-memory/per-replica, so a 2× API scale doubles the effective limit — a
 * separate concern (a shared store), same as the per-IP limiter.
 */

/** Endpoint-wide requests allowed per minute (across ALL client IPs). Generous enough for a busy
 *  legitimate form/chat/webhook, tight enough that a distributed flood is bounded. Tunable. */
export const PUBLIC_ENDPOINT_LIMIT = 120;
export const PUBLIC_ENDPOINT_TTL_MS = 60_000;

/** The request surface the helpers below read. `originalUrl` is Express's untouched
 *  request path — needed because param NAMES alone can't identify the hooks ingress:
 *  the authenticated webhook MANAGEMENT routes (`tenants/:id/webhooks/:endpointId`,
 *  e.g. rotate-secret) reuse `endpointId`, and the run-ops routes reuse `workflowId`. */
export interface ThrottledReq {
  method?: string;
  originalUrl?: string;
  params?: Record<string, unknown>;
}

/** Pure: is this request a POST to a public form/chat submit route (carries a formId/chatId param)? */
export function isPublicSubmitReq(req: ThrottledReq): boolean {
  const id = req.params?.formId ?? req.params?.chatId;
  return req.method === "POST" && typeof id === "string" && id.length > 0;
}

/** Pure: is this request public webhook ingress — `POST /hooks/:endpointId` (external event) or
 *  `POST /hooks/resume/:workflowId` (wait-webhook resume)? Both are @Public (HMAC/token-authed
 *  inside the handler), so both are floodable by anyone who knows — or guesses — a URL. The
 *  `/hooks/` path prefix is part of the test (see ThrottledReq doc). */
export function isHooksIngressReq(req: ThrottledReq): boolean {
  if (req.method !== "POST") return false;
  const path = (req.originalUrl ?? "").split("?")[0];
  if (!path.startsWith("/hooks/")) return false;
  const id = req.params?.endpointId ?? req.params?.workflowId;
  return typeof id === "string" && id.length > 0;
}

/** Pure: the per-endpoint bucket key (formId/chatId/webhook endpointId/resume workflowId).
 *  Only meaningful for a request one of the matchers above accepted. Ids are cuid-like and
 *  come from disjoint tables, so one flat `endpoint:` prefix cannot collide across kinds. */
export function publicEndpointKey(req: {
  params?: Record<string, unknown>;
}): string {
  const id =
    req.params?.formId ??
    req.params?.chatId ??
    req.params?.endpointId ??
    req.params?.workflowId;
  return `endpoint:${typeof id === "string" ? id : "unknown"}`;
}

/** Guard `skipIf`: skip the per-endpoint throttler for everything EXCEPT a public form/chat
 *  submit or public webhook ingress. */
export function skipUnlessPublicSubmit(context: ExecutionContext): boolean {
  if (context.getType() !== "http") return true;
  const req = context.switchToHttp().getRequest<ThrottledReq>();
  return !isPublicSubmitReq(req) && !isHooksIngressReq(req);
}

/** Guard `getTracker` for the per-endpoint throttler → the endpoint id (called only when not skipped). */
export const publicEndpointTracker: ThrottlerGetTrackerFunction = (req) =>
  publicEndpointKey(req as { params?: Record<string, unknown> });
