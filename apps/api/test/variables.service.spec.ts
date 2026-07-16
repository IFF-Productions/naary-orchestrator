import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const variable = {
  findMany: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
};

vi.mock("@naary/db", () => ({
  getPrisma: () => ({ variable }),
}));

import { VariablesService } from "../src/variables/variables.service";

const svc = new VariablesService();

beforeEach(() => {
  for (const m of [variable.findMany, variable.upsert, variable.deleteMany])
    m.mockReset();
});

describe("VariablesService.list", () => {
  it("returns the workspace+env variables, key-sorted", async () => {
    variable.findMany.mockResolvedValue([
      { key: "region", value: "eu" },
      { key: "slackChannel", value: "#alerts" },
    ]);

    const out = await svc.list("t-1", "env-prod");

    expect(out).toEqual([
      { key: "region", value: "eu" },
      { key: "slackChannel", value: "#alerts" },
    ]);
    // Scoped to BOTH tenant and environment — a value can differ sandbox vs prod.
    expect(variable.findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", environmentId: "env-prod" },
      orderBy: { key: "asc" },
      select: { key: true, value: true },
    });
  });
});

describe("VariablesService.upsert — key must be a usable {{ $vars.KEY }} identifier", () => {
  it("creates/overwrites for a valid identifier key (trims whitespace)", async () => {
    variable.upsert.mockResolvedValue({
      key: "slackChannel",
      value: "#alerts",
    });

    const out = await svc.upsert(
      "t-1",
      "env-prod",
      "  slackChannel  ",
      "#alerts",
    );

    expect(out).toEqual({ key: "slackChannel", value: "#alerts" });
    expect(variable.upsert).toHaveBeenCalledWith({
      where: {
        tenantId_environmentId_key: {
          tenantId: "t-1",
          environmentId: "env-prod",
          key: "slackChannel", // trimmed
        },
      },
      create: {
        tenantId: "t-1",
        environmentId: "env-prod",
        key: "slackChannel",
        value: "#alerts",
      },
      update: { value: "#alerts" },
      select: { key: true, value: true },
    });
  });

  it.each(["with space", "1leading", "has.dot", "", "   ", "a-b"])(
    "rejects %j with 400 and never touches the DB (would break dot-path resolution)",
    async (badKey) => {
      await expect(
        svc.upsert("t-1", "env-prod", badKey, "v"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(variable.upsert).not.toHaveBeenCalled();
    },
  );

  it("stores an empty-string value when none is provided (not null)", async () => {
    variable.upsert.mockResolvedValue({ key: "flag", value: "" });

    await svc.upsert("t-1", "env-prod", "flag", "");

    expect(variable.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ value: "" }),
        update: { value: "" },
      }),
    );
  });
});

describe("VariablesService.remove", () => {
  it("deletes the scoped key (no-op if absent)", async () => {
    variable.deleteMany.mockResolvedValue({ count: 1 });

    await svc.remove("t-1", "env-prod", "slackChannel");

    expect(variable.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t-1",
        environmentId: "env-prod",
        key: "slackChannel",
      },
    });
  });
});
