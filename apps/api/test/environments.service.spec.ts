import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const findMany = vi.fn();
const findUnique = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();
const del = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    environment: {
      upsert,
      findMany,
      findUnique,
      findFirst,
      create,
      update,
      delete: del,
    },
  }),
}));

import { EnvironmentsService } from "../src/environments/environments.service";

const svc = new EnvironmentsService();
const DEFAULT = {
  id: "env-prod",
  name: "Production",
  slug: "prod",
  isDefault: true,
};

beforeEach(() => {
  for (const m of [
    upsert,
    findMany,
    findUnique,
    findFirst,
    create,
    update,
    del,
  ])
    m.mockReset();
  upsert.mockResolvedValue(DEFAULT); // ensureDefault
});

describe("ensureDefault", () => {
  it("upserts the Production default on the (tenantId, slug) unique (race-safe)", async () => {
    const out = await svc.ensureDefault("t1");
    expect(out).toMatchObject({ slug: "prod", isDefault: true });
    expect(upsert.mock.calls[0][0].where).toEqual({
      tenantId_slug: { tenantId: "t1", slug: "prod" },
    });
    expect(upsert.mock.calls[0][0].create.isDefault).toBe(true);
    expect(upsert.mock.calls[0][0].update).toEqual({}); // exists → untouched
  });
});

describe("list", () => {
  it("guarantees the default exists, then returns all envs", async () => {
    findMany.mockResolvedValue([DEFAULT]);
    const out = await svc.list("t1");
    expect(upsert).toHaveBeenCalledOnce(); // ensureDefault ran
    expect(out).toEqual([
      { id: "env-prod", name: "Production", slug: "prod", isDefault: true },
    ]);
  });
});

describe("create", () => {
  it("creates a non-default env with a valid slug", async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({
      id: "env-sb",
      name: "Sandbox",
      slug: "sandbox",
      isDefault: false,
    });
    const out = await svc.create("t1", { name: "Sandbox", slug: "Sandbox" });
    expect(create.mock.calls[0][0].data.slug).toBe("sandbox"); // lowercased
    expect(out).toMatchObject({ slug: "sandbox", isDefault: false });
  });

  it("rejects a bad slug (uppercase/space/leading hyphen)", async () => {
    for (const slug of ["-bad", "with space", "!nope"]) {
      await expect(svc.create("t1", { name: "X", slug })).rejects.toThrow(
        /Slug must be/,
      );
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a duplicate slug", async () => {
    findUnique.mockResolvedValue(DEFAULT);
    await expect(
      svc.create("t1", { name: "Prod2", slug: "prod" }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("remove", () => {
  it("refuses to delete the default env", async () => {
    findFirst.mockResolvedValue(DEFAULT);
    await expect(svc.remove("t1", "env-prod")).rejects.toThrow(
      /default environment can't be deleted/,
    );
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes a non-default env", async () => {
    findFirst.mockResolvedValue({ ...DEFAULT, id: "env-sb", isDefault: false });
    await svc.remove("t1", "env-sb");
    expect(del).toHaveBeenCalledWith({ where: { id: "env-sb" } });
  });

  it("404s an unknown env", async () => {
    findFirst.mockResolvedValue(null);
    await expect(svc.remove("t1", "nope")).rejects.toThrow(/not found/);
  });
});

describe("resolveEnvId (the compatibility shim)", () => {
  it("defaults to the tenant's default env when nothing is selected", async () => {
    expect(await svc.resolveEnvId("t1")).toBe("env-prod");
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("resolves a selected env by id or slug", async () => {
    findFirst.mockResolvedValue({ ...DEFAULT, id: "env-sb", slug: "sandbox" });
    expect(await svc.resolveEnvId("t1", "sandbox")).toBe("env-sb");
    expect(findFirst.mock.calls[0][0].where.OR).toEqual([
      { id: "sandbox" },
      { slug: "sandbox" },
    ]);
  });

  it("throws for an env that isn't the tenant's (never silently crosses envs)", async () => {
    findFirst.mockResolvedValue(null);
    await expect(svc.resolveEnvId("t1", "someone-elses")).rejects.toThrow(
      /Unknown environment/,
    );
  });
});
