import type { ExecutionContext } from "@nestjs/common";
import type { ThrottlerGetTrackerFunction } from "@nestjs/throttler";

/**
 * A SECOND rate-limit dimension for the anonymous public submit endpoints (`POST /forms/:formId`,
 * `POST /chat/:chatId`), keyed PER ENDPOINT (formId/chatId) rather than per client IP (#616). The
 * per-IP `default` throttler (#618) doesn't bound a DISTRIBUTED flood — many IPs each stay under
 * their own limit while together hammering one form. This per-endpoint bucket caps a single hosted
 * form/chat's total submit rate regardless of how many IPs it comes from; it layers under Turnstile
 * (which stops bots) + the tenant budget cap (the cost backstop).
 *
 * Wired as a named `public-endpoint` throttler whose per-throttler `getTracker`/`skipIf` the guard
 * honors over the ClientIpThrottlerGuard's method — so `default` still keys on the client IP and only
 * this throttler keys on the endpoint id, and it applies ONLY to the public submit routes.
 *
 * NB the throttler store is in-memory/per-replica, so a 2× API scale doubles the effective limit — a
 * separate concern (a shared store), same as the per-IP limiter.
 */

/** Endpoint-wide submits allowed per minute (across ALL client IPs). Generous enough for a busy
 *  legitimate form/chat, tight enough that a distributed flood is bounded. Tunable. */
export const PUBLIC_ENDPOINT_LIMIT = 120;
export const PUBLIC_ENDPOINT_TTL_MS = 60_000;

/** Pure: is this request a POST to a public form/chat submit route (carries a formId/chatId param)? */
export function isPublicSubmitReq(req: {
  method?: string;
  params?: Record<string, unknown>;
}): boolean {
  const id = req.params?.formId ?? req.params?.chatId;
  return req.method === "POST" && typeof id === "string" && id.length > 0;
}

/** Pure: the per-endpoint bucket key (formId/chatId). Only meaningful for a public submit request. */
export function publicEndpointKey(req: {
  params?: Record<string, unknown>;
}): string {
  const id = req.params?.formId ?? req.params?.chatId;
  return `endpoint:${typeof id === "string" ? id : "unknown"}`;
}

/** Guard `skipIf`: skip the per-endpoint throttler for everything EXCEPT a public form/chat submit. */
export function skipUnlessPublicSubmit(context: ExecutionContext): boolean {
  if (context.getType() !== "http") return true;
  return !isPublicSubmitReq(context.switchToHttp().getRequest());
}

/** Guard `getTracker` for the per-endpoint throttler → the endpoint id (called only when not skipped). */
export const publicEndpointTracker: ThrottlerGetTrackerFunction = (req) =>
  publicEndpointKey(req as { params?: Record<string, unknown> });
