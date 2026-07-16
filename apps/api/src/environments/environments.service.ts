import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";

export interface EnvironmentView {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
}

/** The default env's slug/name (holds all pre-environments data). */
const DEFAULT_SLUG = "prod";
const DEFAULT_NAME = "Production";
/** Header/URL-safe slug: lowercase alphanumeric + hyphens, starts alphanumeric, ≤32 chars. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function view(row: {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
}): EnvironmentView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isDefault: row.isDefault,
  };
}

/**
 * Per-tenant environments (design docs/design/ENVIRONMENTS.md), Slice 1: entity + management only.
 * The default "Production" env is created LAZILY (race-safe upsert on the unique slug) so there's no
 * backfill across implicit tenants. `resolveEnvId` is the compatibility shim later slices call to map
 * an optional env selection to a concrete id, defaulting to the tenant's default env.
 */
@Injectable()
export class EnvironmentsService {
  /** Ensure the tenant has its default env; return it. Idempotent + concurrency-safe (upsert on
   *  the (tenantId, slug) unique). */
  async ensureDefault(tenantId: string): Promise<EnvironmentView> {
    // READ-FIRST: in steady state the default already exists, so this is a single indexed read
    // (the (tenantId, slug) unique). Only the first-ever access for a tenant writes — so this is
    // cheap enough to sit on a per-request resolution path. (The old unconditional upsert wrote
    // on EVERY call via `update`.)
    const existing = await getPrisma().environment.findUnique({
      where: { tenantId_slug: { tenantId, slug: DEFAULT_SLUG } },
    });
    if (existing) {
      // Repair only the inconsistent case: a prod-slug row that somehow lost isDefault (manual
      // edit / partial write) must never become deletable or reorder in list(). No write in the
      // common (already-default) case, so steady state stays a single read.
      if (!existing.isDefault) {
        const fixed = await getPrisma().environment.update({
          where: { id: existing.id },
          data: { isDefault: true },
        });
        return view(fixed);
      }
      return view(existing);
    }
    // Create-if-missing, race-safe: a concurrent create is absorbed by the unique (upsert with an
    // empty update → no write when it already exists).
    const row = await getPrisma().environment.upsert({
      where: { tenantId_slug: { tenantId, slug: DEFAULT_SLUG } },
      create: {
        tenantId,
        name: DEFAULT_NAME,
        slug: DEFAULT_SLUG,
        isDefault: true,
      },
      update: {},
    });
    return view(row);
  }

  /** The tenant's default environment id (lazily created). Used by env-scoped call sites that
   *  don't yet resolve a selected env — the compatibility shim's default target (design §5). */
  async defaultEnvId(tenantId: string): Promise<string> {
    return (await this.ensureDefault(tenantId)).id;
  }

  /** Is `envId` the tenant's DEFAULT env? Deferred tenant-wide side-effects (schedule teardown/
   *  sync/pause, cross-table deletes, pins) only fire in the default env until their tables are
   *  env-scoped — so a non-default (sandbox) action never touches prod's shared resources. */
  async isDefaultEnv(tenantId: string, envId: string): Promise<boolean> {
    return envId === (await this.defaultEnvId(tenantId));
  }

  /** All environments for the tenant (default guaranteed present), default first then by name. */
  async list(tenantId: string): Promise<EnvironmentView[]> {
    await this.ensureDefault(tenantId);
    const rows = await getPrisma().environment.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
    return rows.map(view);
  }

  /** Create a new (non-default) environment. Slug is validated + unique per tenant. */
  async create(
    tenantId: string,
    input: { name: string; slug: string },
  ): Promise<EnvironmentView> {
    const name = input.name?.trim();
    const slug = input.slug?.trim().toLowerCase();
    if (!name) throw new BadRequestException("Environment name is required.");
    if (!slug || !SLUG_RE.test(slug)) {
      throw new BadRequestException(
        "Slug must be lowercase letters/numbers/hyphens, starting alphanumeric (≤32 chars).",
      );
    }
    await this.ensureDefault(tenantId);
    const existing = await getPrisma().environment.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
    });
    if (existing) {
      throw new BadRequestException(`An environment '${slug}' already exists.`);
    }
    try {
      const row = await getPrisma().environment.create({
        data: { tenantId, name, slug, isDefault: false },
      });
      return view(row);
    } catch (e) {
      // The pre-check has a TOCTOU race — two concurrent creates can both pass it, then one hits
      // the (tenantId, slug) unique (Prisma P2002). Surface a clean 400, not the generic 500 the
      // global filter turns a non-HttpException into.
      if (
        e &&
        typeof e === "object" &&
        (e as { code?: string }).code === "P2002"
      ) {
        throw new BadRequestException(
          `An environment '${slug}' already exists.`,
        );
      }
      throw e;
    }
  }

  /** Rename an environment (display name only — the slug is stable). */
  async rename(
    tenantId: string,
    id: string,
    name: string,
  ): Promise<EnvironmentView> {
    const trimmed = name?.trim();
    if (!trimmed)
      throw new BadRequestException("Environment name is required.");
    // Tenant-SCOPED write (updateMany with {id, tenantId}, not update by id) so the write itself
    // can't touch another tenant's row — no read-then-write TOCTOU. count 0 ⇒ not ours / gone.
    const { count } = await getPrisma().environment.updateMany({
      where: { id, tenantId },
      data: { name: trimmed },
    });
    if (count === 0) throw new NotFoundException("Environment not found.");
    const updated = await getPrisma().environment.findFirst({
      where: { id, tenantId },
    });
    // Deleted between the updateMany and the re-read (or otherwise gone) — 404, not a 500 from a
    // non-null assertion.
    if (!updated) throw new NotFoundException("Environment not found.");
    return view(updated);
  }

  /** Delete an environment. Refused for the default env (it's the migration + shim target). */
  async remove(tenantId: string, id: string): Promise<void> {
    const row = await getPrisma().environment.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new NotFoundException("Environment not found.");
    if (row.isDefault) {
      throw new BadRequestException(
        "The default environment can't be deleted.",
      );
    }
    // Since Slice 4/5 several env-scoped tables (graphs, activations, webhook/form/chat endpoints,
    // credentials, connections) hold ON DELETE RESTRICT FKs to Environment, so deleting a non-empty
    // env raises a Prisma P2003 at the DB. Catch it and surface a clean 409 instead of the global
    // filter's generic 500 — the RESTRICT is the real backstop; this is the friendly message.
    // Tenant-SCOPED delete (deleteMany with {id, tenantId}) so the write can't reach another
    // tenant's row even if the id check above raced. count 0 ⇒ deleted concurrently after the read
    // → 404, consistent with treating an unknown env as not-found (not a silent success).
    let count: number;
    try {
      ({ count } = await getPrisma().environment.deleteMany({
        where: { id, tenantId },
      }));
    } catch (e) {
      if (
        e &&
        typeof e === "object" &&
        (e as { code?: string }).code === "P2003"
      ) {
        throw new ConflictException(
          "This environment still holds workflows, credentials, connections, or trigger " +
            "endpoints. Remove them (or promote/migrate elsewhere) before deleting it.",
        );
      }
      throw e;
    }
    if (count === 0) throw new NotFoundException("Environment not found.");
  }

  /**
   * Compatibility shim (design §5): map an optional env selection (id or slug, e.g. from
   * `X-Environment-Id`) to a concrete environment id, defaulting to the tenant's default env when
   * absent. Later slices call this everywhere a query becomes env-scoped, so a caller that sends no
   * env keeps landing in the default (byte-identical to pre-environments behavior). Throws if a
   * SPECIFIED env doesn't belong to the tenant (never silently falls back — that would cross envs).
   */
  async resolveEnvId(tenantId: string, sel?: string | null): Promise<string> {
    // Normalize first — a copy/pasted X-Environment-Id often carries surrounding whitespace.
    const raw = sel?.trim();
    if (!raw) return (await this.ensureDefault(tenantId)).id;
    // DETERMINISTIC: try an exact id match FIRST, then the (lowercased) slug — never an ambiguous
    // OR. Slugs can't collide with ids anyway (a uuid is 36 chars, past the 32-char slug cap), but
    // resolving id-then-slug removes any doubt about which wins.
    const byId = await getPrisma().environment.findFirst({
      where: { tenantId, id: raw },
    });
    if (byId) return byId.id;
    const slug = raw.toLowerCase();
    const bySlug = await getPrisma().environment.findFirst({
      where: { tenantId, slug },
    });
    if (bySlug) return bySlug.id;
    // A caller can select the default env by slug (e.g. `X-Environment-Id: prod`) BEFORE any call
    // has lazily created it — resolve that to the (now-created) default instead of 404ing.
    if (slug === DEFAULT_SLUG) {
      return (await this.ensureDefault(tenantId)).id;
    }
    throw new NotFoundException(`Unknown environment '${raw}'.`);
  }
}
