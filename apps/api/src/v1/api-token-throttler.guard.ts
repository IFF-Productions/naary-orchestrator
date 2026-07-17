import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * Rate-limit guard for the public /api/v1 surface, keyed PER API TOKEN (not per IP).
 *
 * Why per-token: v1 callers are scripts / CI behind shared egress IPs, so the global per-IP
 * throttler (app.module — kept as an additive backstop) is both too loose (one tenant floods a
 * shared IP's budget) and too tight (unrelated tenants on the same IP collide). Keying on the
 * token gives each caller its own bucket.
 *
 * Why hash the token, not resolve its id: `getTracker` only needs the raw Authorization header,
 * which is on the request regardless of guard order — so this needs NO DB lookup and does NOT
 * depend on AuthGuard having run first (both are global APP_GUARDs with unspecified relative order).
 * We bucket on a sha256 of the token, never the raw secret. Non-`nry_` callers fall back to the
 * base per-IP tracker (defends against an attacker rotating garbage token strings for a fresh
 * bucket each request — the per-IP floor catches that before auth rejects them).
 */
@Injectable()
export class ApiTokenThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const auth = (req.headers as Record<string, unknown> | undefined)
      ?.authorization;
    if (typeof auth === "string") {
      const match = /^Bearer\s+(nry_\S+)/i.exec(auth);
      if (match) {
        return `tok:${createHash("sha256").update(match[1]).digest("hex")}`;
      }
    }
    // Not an API-token call → the default per-IP tracker.
    return super.getTracker(req);
  }
}
