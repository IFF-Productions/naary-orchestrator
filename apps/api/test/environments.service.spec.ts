import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const findMany = vi.fn();
const findUnique = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    environment: {
      upsert,
      findMany,
      findUnique,
      findFirst,
      create,
      updateMany,
      deleteMany,
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
    updateMany,
    deleteMany,
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
    // Re-asserts default on an existing prod-slug row (defends a manual/partial edit), but doesn't
    // override a user-renamed name.
    expect(upsert.mock.calls[0][0].update).toEqual({ isDefault: true });
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

  it("rejects a malformed slug (leading hyphen / space / special char)", async () => {
    // NB: uppercase is NOT rejected — create() lowercases the slug first (see the create test).
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

describe("rename", () => {
  it("renames via a TENANT-SCOPED updateMany, then re-reads the row", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findFirst.mockResolvedValue({ ...DEFAULT, name: "Prod (renamed)" });
    const out = await svc.rename("t1", "env-prod", "  Prod (renamed) ");
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: "env-prod", tenantId: "t1" },
      data: { name: "Prod (renamed)" }, // trimmed
    });
    expect(out.name).toBe("Prod (renamed)");
  });

  it("404s when the env isn't the tenant's (updateMany count 0)", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.rename("t1", "nope", "X")).rejects.toThrow(/not found/);
  });

  it("404s (not 500) when the row vanishes between the update and the re-read", async () => {
    updateMany.mockResolvedValue({ count: 1 }); // update succeeded...
    findFirst.mockResolvedValue(null); // ...but a concurrent delete removed it
    await expect(svc.rename("t1", "env-x", "X")).rejects.toThrow(/not found/);
  });

  it("rejects an empty name", async () => {
    await expect(svc.rename("t1", "env-prod", "   ")).rejects.toThrow(
      /name is required/,
    );
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("remove", () => {
  it("refuses to delete the default env", async () => {
    findFirst.mockResolvedValue(DEFAULT);
    await expect(svc.remove("t1", "env-prod")).rejects.toThrow(
      /default environment can't be deleted/,
    );
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("deletes a non-default env with a TENANT-SCOPED deleteMany", async () => {
    findFirst.mockResolvedValue({ ...DEFAULT, id: "env-sb", isDefault: false });
    deleteMany.mockResolvedValue({ count: 1 });
    await svc.remove("t1", "env-sb");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "env-sb", tenantId: "t1" },
    });
  });

  it("404s when the env was deleted concurrently (deleteMany count 0)", async () => {
    findFirst.mockResolvedValue({ ...DEFAULT, id: "env-sb", isDefault: false });
    deleteMany.mockResolvedValue({ count: 0 }); // gone by the time we delete
    await expect(svc.remove("t1", "env-sb")).rejects.toThrow(/not found/);
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

  it("resolves by id FIRST (deterministic), then falls back to slug", async () => {
    // id lookup hits.
    findFirst.mockResolvedValueOnce({ ...DEFAULT, id: "env-sb" });
    expect(await svc.resolveEnvId("t1", "env-sb")).toBe("env-sb");
    expect(findFirst.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      id: "env-sb",
    });
  });

  it("resolves a selected env by slug when the id lookup misses", async () => {
    findFirst
      .mockResolvedValueOnce(null) // id miss
      .mockResolvedValueOnce({ ...DEFAULT, id: "env-sb", slug: "sandbox" }); // slug hit
    expect(await svc.resolveEnvId("t1", "sandbox")).toBe("env-sb");
    expect(findFirst.mock.calls[1][0].where).toEqual({
      tenantId: "t1",
      slug: "sandbox",
    });
  });

  it("TRIMS + lowercases the selection (copy/pasted header whitespace)", async () => {
    findFirst
      .mockResolvedValueOnce(null) // id miss (trimmed "SANDBOX")
      .mockResolvedValueOnce({ ...DEFAULT, id: "env-sb", slug: "sandbox" });
    expect(await svc.resolveEnvId("t1", "  SANDBOX  ")).toBe("env-sb");
    expect(findFirst.mock.calls[0][0].where.id).toBe("SANDBOX"); // trimmed (id match is case-exact)
    expect(findFirst.mock.calls[1][0].where.slug).toBe("sandbox"); // trimmed + lowercased
  });

  it("throws for an env that isn't the tenant's (never silently crosses envs)", async () => {
    findFirst.mockResolvedValue(null); // both id + slug miss
    await expect(svc.resolveEnvId("t1", "someone-elses")).rejects.toThrow(
      /Unknown environment/,
    );
  });

  it("resolves the DEFAULT slug even before the default row exists (lazy-create)", async () => {
    // No row yet for 'prod' → falls back to ensureDefault instead of 404.
    findFirst.mockResolvedValue(null);
    expect(await svc.resolveEnvId("t1", "prod")).toBe("env-prod");
    expect(upsert).toHaveBeenCalledOnce(); // ensureDefault ran
  });
});

describe("create — concurrency", () => {
  it("maps a P2002 unique race to a 400 (not a generic 500)", async () => {
    findUnique.mockResolvedValue(null); // pre-check passes...
    create.mockRejectedValue({ code: "P2002" }); // ...but the insert loses the race
    await expect(
      svc.create("t1", { name: "Sandbox", slug: "sandbox" }),
    ).rejects.toThrow(/already exists/);
  });
});
