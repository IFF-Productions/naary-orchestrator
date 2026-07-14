import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

/** The experience variant (design PRODUCT-VARIANTS.md). Kept as a string union so a
 *  future variant is an additive change, not a schema migration. */
export type PreferenceMode = "builder" | "simple";
const VALID_MODES: readonly PreferenceMode[] = ["builder", "simple"];

/** One widget's placement in the customizable Overview (order is the array position). */
export interface DashboardItem {
  id: string;
  hidden: boolean;
  /** 12-col grid span (4 = third, 6 = half, 12 = full). */
  span: number;
}

export interface PreferenceView {
  /** null = user has never chosen → the client falls back to its default. */
  mode: PreferenceMode | null;
  /** null = never customized → the client uses its default layout. */
  dashboard: DashboardItem[] | null;
}

/** A patch: a key present (even null) is written; an ABSENT key is left untouched, so a
 *  mode save can't clobber the dashboard layout and vice-versa. */
export interface PreferencePatch {
  mode?: PreferenceMode | null;
  dashboard?: DashboardItem[] | null;
}

/**
 * Per-USER preferences (one row per Firebase uid) — personal and cross-workspace, so
 * they follow the user across devices. API-token principals have no uid; callers pass
 * `userId = undefined` for those and get/save both no-op to `{ mode: null }` (they stay
 * on client-side localStorage, unchanged from before this slice).
 */
@Injectable()
export class PreferencesService {
  async get(userId: string | undefined): Promise<PreferenceView> {
    if (!userId) return { mode: null, dashboard: null };
    const row = await getPrisma().userPreference.findUnique({
      where: { userId },
    });
    return {
      mode: this.narrow(row?.mode),
      dashboard: sanitizeDashboard(row?.dashboard),
    };
  }

  async save(
    userId: string | undefined,
    patch: PreferencePatch,
  ): Promise<PreferenceView> {
    // No uid (API token) → nothing to persist; report null so the client keeps localStorage.
    if (!userId) return { mode: null, dashboard: null };
    // Only write keys the caller actually sent — an absent key stays as-is (a mode save
    // must not wipe the dashboard layout, and vice-versa). We only ever persist a valid,
    // non-empty layout; a null/invalid dashboard is a no-op (reset = save the default).
    const data: { mode?: PreferenceMode | null; dashboard?: DashboardItem[] } =
      {};
    if (patch.mode !== undefined) data.mode = patch.mode;
    if (patch.dashboard !== undefined) {
      const clean = sanitizeDashboard(patch.dashboard);
      if (clean) data.dashboard = clean;
    }
    // `as never`: a DashboardItem[] is a valid Prisma Json value at runtime, but the
    // interface isn't structurally assignable to Prisma's InputJsonValue index type.
    const row = await getPrisma().userPreference.upsert({
      where: { userId },
      create: { userId, ...data } as never,
      update: data as never,
    });
    return {
      mode: this.narrow(row.mode),
      dashboard: sanitizeDashboard(row.dashboard),
    };
  }

  /** Guard against stale/invalid values ever leaking out of the DB. */
  private narrow(value: string | null | undefined): PreferenceMode | null {
    return VALID_MODES.includes(value as PreferenceMode)
      ? (value as PreferenceMode)
      : null;
  }
}

/** Coerce an unknown (DB Json or request body) into a clean DashboardItem[], dropping
 *  anything malformed. Returns null for a non-array / empty result so callers fall back
 *  to the default layout. Never throws. */
function sanitizeDashboard(value: unknown): DashboardItem[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: DashboardItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || seen.has(r.id)) continue;
    const span = [4, 6, 8, 12].includes(r.span as number)
      ? (r.span as number)
      : 12;
    out.push({ id: r.id, hidden: r.hidden === true, span });
    seen.add(r.id);
  }
  return out.length > 0 ? out : null;
}
