import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MembershipService } from "../src/membership/membership.service";
import { WorkspacesController } from "../src/membership/workspaces.controller";

const listForUser = vi.fn();
const ensureMembership = vi.fn();
function makeController(): WorkspacesController {
  return new WorkspacesController({
    listForUser,
    ensureMembership,
  } as unknown as MembershipService);
}

beforeEach(() => {
  listForUser.mockReset();
  ensureMembership.mockReset().mockResolvedValue(undefined);
});

describe("WorkspacesController", () => {
  it("returns the user's memberships (Firebase subject present)", async () => {
    listForUser.mockResolvedValue([
      { tenantId: "t1", role: "owner" },
      { tenantId: "t2", role: "member" },
    ]);
    const res = await makeController().list({
      tenantId: "t1",
      subject: "user-9",
    });
    expect(res).toEqual([
      { tenantId: "t1", role: "owner" },
      { tenantId: "t2", role: "member" },
    ]);
    expect(ensureMembership).not.toHaveBeenCalled();
  });

  it("lazily backfills an owner membership on first login of a claim user", async () => {
    listForUser
      .mockResolvedValueOnce([]) // none yet
      .mockResolvedValueOnce([{ tenantId: "t-claim", role: "owner" }]);
    const res = await makeController().list({
      tenantId: "t-claim",
      subject: "user-9",
    });
    expect(ensureMembership).toHaveBeenCalledWith("user-9", "t-claim", "owner");
    expect(res).toEqual([{ tenantId: "t-claim", role: "owner" }]);
  });

  it("synthesizes the single workspace for an API-token principal (no subject, no persist)", async () => {
    const res = await makeController().list({ tenantId: "t-token" });
    expect(res).toEqual([{ tenantId: "t-token", role: "owner" }]);
    expect(listForUser).not.toHaveBeenCalled();
    expect(ensureMembership).not.toHaveBeenCalled();
  });
});
