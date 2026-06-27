import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

export interface SettingsView {
  displayName: string | null;
  defaultModel: string | null;
}

/** Per-tenant settings (one row per tenant). Returns empty defaults when unset. */
@Injectable()
export class SettingsService {
  async get(tenantId: string): Promise<SettingsView> {
    const row = await getPrisma().tenantSettings.findUnique({
      where: { tenantId },
    });
    return {
      displayName: row?.displayName ?? null,
      defaultModel: row?.defaultModel ?? null,
    };
  }

  async save(
    tenantId: string,
    patch: { displayName?: string | null; defaultModel?: string | null },
  ): Promise<SettingsView> {
    const row = await getPrisma().tenantSettings.upsert({
      where: { tenantId },
      create: {
        tenantId,
        displayName: patch.displayName ?? null,
        defaultModel: patch.defaultModel ?? null,
      },
      update: {
        displayName: patch.displayName,
        defaultModel: patch.defaultModel,
      },
    });
    return { displayName: row.displayName, defaultModel: row.defaultModel };
  }
}
