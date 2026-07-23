import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/** Coerce a possibly-array header value to its first string, or undefined. */
function firstStr(v: unknown): string | undefined {
  if (typeof v === "string" && v) return v;
  if (Array.isArray(v) && typeof v[0] === "string" && v[0]) return v[0];
  return undefined;
}

/**
 * Resolve the REAL client IP from trusted, non-spoofable proxy headers, or null to fall back to the
 * base tracker. Order (see the guard doc for why each is trustworthy in our topology):
 *   1. `CF-Connecting-IP` — Cloudflare OVERWRITES any client value.
 *   2. `X-Real-IP` — nginx sets it via `$remote_addr` (REPLACES, not appends).
 * We deliberately do NOT read `X-Forwarded-For`: nginx builds it with `$proxy_add_x_forwarded_for`,
 * which APPENDS to the client-supplied value, so its leftmost entry is attacker-controlled — keying
 * on it would hand out unlimited fresh buckets (worse than the bug we're fixing).
 */
export function resolveClientIp(req: {
  headers?: Record<string, unknown>;
}): string | null {
  const h = req.headers ?? {};
  return firstStr(h["cf-connecting-ip"]) ?? firstStr(h["x-real-ip"]) ?? null;
}

/**
 * ThrottlerGuard keyed on the real client IP, not the proxy's. The API always sits behind nginx (and
 * cloudflared in prod), so the default `getTracker` (`req.ip`) collapses EVERY request into one
 * bucket — the proxy container's IP — defeating the global limiter AND the per-route `@Throttle` on
 * the public form/chat endpoints (#596). Registered as the global `APP_GUARD` (replacing the default
 * ThrottlerGuard), so it fixes both at once — the same per-tracker-override precedent as the v1
 * ApiTokenThrottlerGuard.
 *
 * ⚠️ LOAD-BEARING ASSUMPTION: `CF-Connecting-IP` is trustworthy only because ingress is
 * cloudflared-tunnel-only (the origin isn't publicly reachable, so nobody can hit nginx bypassing
 * Cloudflare). If nginx is ever exposed directly, it MUST strip a client-supplied `CF-Connecting-IP`
 * or this becomes an IP-spoofing bypass.
 *
 * NB the throttler store is in-memory/per-replica, so a 2× API scale doubles the effective limit — a
 * separate concern (a shared store), intentionally NOT addressed here.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return resolveClientIp(req) ?? super.getTracker(req);
  }
}
