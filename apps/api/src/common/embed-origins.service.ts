import { Injectable, Logger } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { parsePublicEmbedPath } from "./public-cors";

/** How long a resolved (or empty) allowlist is reused before re-reading Postgres. Short enough that
 *  editing the list in Settings takes effect ~immediately, long enough that a burst of embed hits
 *  costs one query, not one per request. */
const TTL_MS = 30_000;
/** Hard cap so a flood of unknown/garbage ids can't grow the map without bound. */
const MAX_ENTRIES = 5_000;

/**
 * Resolves a public embed path (`/forms/:id`, `/chat/:id`) → the tenant's allowed embed HOSTNAMES,
 * for the per-tenant CORS narrowing in public-cors.ts (#617).
 *
 * The list is the SAME `TurnstileConfig.allowedHostnames` the Turnstile solved-hostname check uses:
 * one "domains you serve these pages from" list per (tenant, environment), not two competing ones
 * (issue #617 explicitly asks for them unified). An empty list — including "no Turnstile row at
 * all", which is every tenant today — means UNRESTRICTED, so existing embeds keep working.
 *
 * Reads Prisma directly rather than going through FormService/ChatService/TurnstileConfigService:
 * this runs as EXPRESS middleware ahead of Nest's router (so it can answer preflights), it needs
 * only two id lookups, and importing those modules here would close an import cycle
 * (FormsModule/ChatModule already depend on TurnstileConfigModule).
 *
 * NEVER returns tenant/env/workflow ids — only hostnames, which the middleware uses to decide
 * whether to echo the caller's own Origin. Nothing tenant-identifying can leak into a response.
 */
@Injectable()
export class EmbedOriginsService {
  private readonly logger = new Logger(EmbedOriginsService.name);
  private readonly cache = new Map<string, { at: number; hosts: string[] }>();

  /** Allowed embed hostnames for a public embed path; `[]` = unrestricted (unknown id, no config,
   *  or an empty list). Never throws — a DB failure resolves to `[]` (fail-permissive, logged). */
  async allowedHostnamesForPath(path: string): Promise<string[]> {
    const parsed = parsePublicEmbedPath(path);
    if (!parsed) return [];
    const key = `${parsed.kind}:${parsed.id}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.hosts;
    let hosts: string[] = [];
    try {
      hosts = await this.load(parsed.kind, parsed.id);
    } catch (err) {
      // Fail-permissive: this is enablement, not protection (see public-cors.ts). Don't cache a
      // failure — retry on the next request.
      this.logger.warn(
        `embed-origin lookup failed for ${parsed.kind}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
    if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { at: Date.now(), hosts });
    return hosts;
  }

  /** Drop the memoized allowlists (called after a config write so an edit applies at once). */
  invalidate(): void {
    this.cache.clear();
  }

  private async load(kind: "form" | "chat", id: string): Promise<string[]> {
    const prisma = getPrisma();
    const endpoint =
      kind === "form"
        ? await prisma.formEndpoint.findUnique({
            where: { id },
            select: { tenantId: true, environmentId: true },
          })
        : await prisma.chatEndpoint.findUnique({
            where: { id },
            select: { tenantId: true, environmentId: true },
          });
    if (!endpoint) return []; // unknown id — the route will 404 anyway
    const cfg = await prisma.turnstileConfig.findUnique({
      where: {
        tenantId_environmentId: {
          tenantId: endpoint.tenantId,
          environmentId: endpoint.environmentId,
        },
      },
      select: { allowedHostnames: true },
    });
    return cfg?.allowedHostnames ?? [];
  }
}
