import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ tenantSettings: { findUnique, upsert } }),
}));

import { SettingsService } from "../src/settings/settings.service";

const svc = new SettingsService();

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
});

describe("SettingsService", () => {
  it("returns empty defaults when no row exists", async () => {
    findUnique.mockResolvedValue(null);
    expect(await svc.get("t-1")).toEqual({
      displayName: null,
      defaultModel: null,
    });
  });

  it("returns stored settings", async () => {
    findUnique.mockResolvedValue({
      tenantId: "t-1",
      displayName: "Acme",
      defaultModel: "claude-opus-4-8",
    });
    expect(await svc.get("t-1")).toEqual({
      displayName: "Acme",
      defaultModel: "claude-opus-4-8",
    });
  });

  it("upserts on save, scoped to the tenant", async () => {
    upsert.mockResolvedValue({ displayName: "Acme", defaultModel: null });
    const v = await svc.save("t-1", {
      displayName: "Acme",
      defaultModel: null,
    });
    expect(v).toEqual({ displayName: "Acme", defaultModel: null });
    expect(upsert.mock.calls[0][0].where).toEqual({ tenantId: "t-1" });
  });
});
