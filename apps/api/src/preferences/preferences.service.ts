import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

/** The experience variant (design PRODUCT-VARIANTS.md). Kept as a string union so a
 *  future variant is an additive change, not a schema migration. */
export type PreferenceMode = "builder" | "simple";
const VALID_MODES: readonly PreferenceMode[] = ["builder", "simple"];

export interface PreferenceView {
  /** null = user has never chosen → the client falls back to its default. */
  mode: PreferenceMode | null;
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
    if (!userId) return { mode: null };
    const row = await getPrisma().userPreference.findUnique({
      where: { userId },
    });
    return { mode: this.narrow(row?.mode) };
  }

  async save(
    userId: string | undefined,
    mode: PreferenceMode | null,
  ): Promise<PreferenceView> {
    // No uid (API token) → nothing to persist; report null so the client keeps localStorage.
    if (!userId) return { mode: null };
    const row = await getPrisma().userPreference.upsert({
      where: { userId },
      create: { userId, mode },
      update: { mode },
    });
    return { mode: this.narrow(row.mode) };
  }

  /** Guard against stale/invalid values ever leaking out of the DB. */
  private narrow(value: string | null | undefined): PreferenceMode | null {
    return VALID_MODES.includes(value as PreferenceMode)
      ? (value as PreferenceMode)
      : null;
  }
}
