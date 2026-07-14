import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ userPreference: { findUnique, upsert } }),
}));

import { PreferencesService } from "../src/preferences/preferences.service";

const svc = new PreferencesService();

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
});

describe("PreferencesService — dashboard layout", () => {
  it("returns null mode + dashboard for an API-token principal (no uid)", async () => {
    expect(await svc.get(undefined)).toEqual({ mode: null, dashboard: null });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("sanitizes the stored dashboard (drops junk, clamps span, dedupes ids)", async () => {
    findUnique.mockResolvedValue({
      mode: "builder",
      dashboard: [
        { id: "metrics", hidden: false, span: 12 },
        { id: "charts", hidden: true, span: 7 }, // 7 → clamped to 12
        { id: "metrics", hidden: false, span: 4 }, // duplicate id → dropped
        { nope: true }, // no id → dropped
        "garbage", // not an object → dropped
      ],
    });
    const out = await svc.get("u1");
    expect(out.mode).toBe("builder");
    expect(out.dashboard).toEqual([
      { id: "metrics", hidden: false, span: 12 },
      { id: "charts", hidden: true, span: 12 },
    ]);
  });

  it("a mode-only save does NOT write (or clobber) the dashboard column", async () => {
    upsert.mockResolvedValue({ mode: "simple", dashboard: null });
    await svc.save("u1", { mode: "simple" });
    const arg = upsert.mock.calls[0][0];
    expect(arg.update).toEqual({ mode: "simple" });
    expect(arg.update).not.toHaveProperty("dashboard");
  });

  it("a dashboard-only save does NOT write (or clobber) the mode column", async () => {
    upsert.mockResolvedValue({
      mode: "builder",
      dashboard: [{ id: "metrics", hidden: false, span: 12 }],
    });
    await svc.save("u1", {
      dashboard: [{ id: "metrics", hidden: false, span: 12 }],
    });
    const arg = upsert.mock.calls[0][0];
    expect(arg.update).not.toHaveProperty("mode");
    expect(arg.update.dashboard).toEqual([
      { id: "metrics", hidden: false, span: 12 },
    ]);
  });

  it("does not persist an invalid/empty dashboard (reset happens client-side)", async () => {
    upsert.mockResolvedValue({ mode: null, dashboard: null });
    await svc.save("u1", { dashboard: [] });
    const arg = upsert.mock.calls[0][0];
    // empty → sanitizes to null → skipped, so the column is left untouched.
    expect(arg.update).not.toHaveProperty("dashboard");
  });
});
