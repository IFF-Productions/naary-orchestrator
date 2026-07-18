import { beforeEach, describe, expect, it, vi } from "vitest";

const apiToken = { findMany: vi.fn() };
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ apiToken }),
}));

import { ApiTokenService } from "../src/auth/api-token.service";

const svc = new ApiTokenService();

describe("ApiTokenService.list (G2: additive groupCount for the Restricted badge)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps the relation _count to a flat groupCount and keeps metadata fields", async () => {
    const created = new Date("2026-07-01T00:00:00Z");
    apiToken.findMany.mockResolvedValue([
      {
        id: "tok-1",
        label: "ci",
        createdAt: created,
        lastUsedAt: null,
        _count: { groupMemberships: 2 },
      },
      {
        id: "tok-2",
        label: "mcp",
        createdAt: created,
        lastUsedAt: created,
        _count: { groupMemberships: 0 },
      },
    ]);
    const rows = await svc.list("t-1");
    expect(rows).toEqual([
      {
        id: "tok-1",
        label: "ci",
        createdAt: created,
        lastUsedAt: null,
        groupCount: 2,
      },
      {
        id: "tok-2",
        label: "mcp",
        createdAt: created,
        lastUsedAt: created,
        groupCount: 0,
      },
    ]);
  });

  it("stays a single batched query (the _count rides the same findMany) and never selects the hash", async () => {
    apiToken.findMany.mockResolvedValue([]);
    await svc.list("t-1");
    expect(apiToken.findMany).toHaveBeenCalledTimes(1);
    const arg = apiToken.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: "t-1" });
    expect(arg.select._count).toEqual({ select: { groupMemberships: true } });
    expect(arg.select.tokenHash).toBeUndefined();
  });
});
