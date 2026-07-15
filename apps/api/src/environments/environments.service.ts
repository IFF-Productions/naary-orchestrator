import {
  BadRequestException,
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
    const row = await getPrisma().environment.upsert({
      where: { tenantId_slug: { tenantId, slug: DEFAULT_SLUG } },
      create: {
        tenantId,
        name: DEFAULT_NAME,
        slug: DEFAULT_SLUG,
        isDefault: true,
      },
      update: {}, // exists → leave as-is
    });
    return view(row);
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
    const row = await getPrisma().environment.create({
      data: { tenantId, name, slug, isDefault: false },
    });
    return view(row);
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
    const row = await getPrisma().environment.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new NotFoundException("Environment not found.");
    const updated = await getPrisma().environment.update({
      where: { id },
      data: { name: trimmed },
    });
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
    // NOTE (Slice 1): once workflows/runs are env-scoped, also refuse (or cascade) when the env
    // still holds data. Today nothing is env-scoped, so a plain delete is safe.
    await getPrisma().environment.delete({ where: { id } });
  }

  /**
   * Compatibility shim (design §5): map an optional env selection (id or slug, e.g. from
   * `X-Environment-Id`) to a concrete environment id, defaulting to the tenant's default env when
   * absent. Later slices call this everywhere a query becomes env-scoped, so a caller that sends no
   * env keeps landing in the default (byte-identical to pre-environments behavior). Throws if a
   * SPECIFIED env doesn't belong to the tenant (never silently falls back — that would cross envs).
   */
  async resolveEnvId(tenantId: string, sel?: string | null): Promise<string> {
    if (!sel) return (await this.ensureDefault(tenantId)).id;
    const row = await getPrisma().environment.findFirst({
      where: { tenantId, OR: [{ id: sel }, { slug: sel.toLowerCase() }] },
    });
    if (!row) {
      throw new NotFoundException(`Unknown environment '${sel}'.`);
    }
    return row.id;
  }
}
