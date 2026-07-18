import { beforeEach, describe, expect, it, vi } from "vitest";

const companyMembership = { findUnique: vi.fn() };
const tenantSettings = { findUnique: vi.fn() };
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ companyMembership, tenantSettings }),
}));

import { CompaniesController } from "../src/companies/companies.controller";
import { CompanyService } from "../src/companies/company.service";
import type { ExecutionsService } from "../src/executions/executions.service";
import type { GraphsService } from "../src/graphs/graphs.service";
import type { EnvironmentsService } from "../src/environments/environments.service";

const listPage = vi.fn();
const graphList = vi.fn();
const defaultEnvId = vi.fn();

function make(): CompanyService {
  return new CompanyService(
    { listPage } as unknown as ExecutionsService,
    { list: graphList } as unknown as GraphsService,
    { defaultEnvId } as unknown as EnvironmentsService,
  );
}

beforeEach(() => {
  companyMembership.findUnique.mockReset().mockResolvedValue({ role: "admin" });
  tenantSettings.findUnique.mockReset().mockResolvedValue({ companyId: "c-1" });
  listPage.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  graphList.mockReset().mockResolvedValue([]);
  defaultEnvId.mockReset().mockResolvedValue("env-default");
});

// §4: assertCompanyMember FIRST, then the attached-to-THIS-company equality check, before ANY
// read of the target workspace. These call-order tests are the §4 privacy invariant.
describe("CompanyService cross-workspace visibility (slice 3)", () => {
  it("rejects a NON-member before touching tenantSettings or the target's data", async () => {
    companyMembership.findUnique.mockResolvedValue(null);
    await expect(
      make().listWorkspaceRuns("u-1", "c-1", "t-victim"),
    ).rejects.toThrow(/not a member/);
    expect(tenantSettings.findUnique).not.toHaveBeenCalled();
    expect(listPage).not.toHaveBeenCalled();
  });

  it("404s when the workspace is NOT attached to this company (no data read)", async () => {
    tenantSettings.findUnique.mockResolvedValue({ companyId: "c-OTHER" });
    await expect(make().listWorkspaceRuns("u-1", "c-1", "t-2")).rejects.toThrow(
      /not attached/,
    );
    expect(listPage).not.toHaveBeenCalled();

    tenantSettings.findUnique.mockResolvedValue(null); // workspace has no settings row at all
    await expect(
      make().listWorkspaceWorkflows("u-1", "c-1", "t-2"),
    ).rejects.toThrow(/not attached/);
    expect(graphList).not.toHaveBeenCalled();
  });

  it("delegates runs to listPage with the TARGET tenant + passthrough paging", async () => {
    const page = { items: [{ workflowId: "wf-1" }], nextCursor: "cur" };
    listPage.mockResolvedValue(page);
    const out = await make().listWorkspaceRuns("u-1", "c-1", "t-2", {
      limit: 25,
      cursor: "abc",
    });
    expect(out).toBe(page);
    expect(listPage).toHaveBeenCalledWith("t-2", { limit: 25, cursor: "abc" });
  });

  it("delegates workflows to graphs.list with the target's DEFAULT env", async () => {
    await make().listWorkspaceWorkflows("u-1", "c-1", "t-2");
    expect(defaultEnvId).toHaveBeenCalledWith("t-2");
    expect(graphList).toHaveBeenCalledWith("t-2", "env-default");
  });
});

describe("CompaniesController slice-3 routes", () => {
  function controller() {
    const svc = {
      listWorkspaceRuns: vi
        .fn()
        .mockResolvedValue({ items: [], nextCursor: null }),
      listWorkspaceWorkflows: vi.fn().mockResolvedValue([]),
    };
    return {
      c: new CompaniesController(svc as unknown as CompanyService),
      svc,
    };
  }

  it("403s an API-token principal (no uid) without touching the service", async () => {
    const { c, svc } = controller();
    await expect(
      c.workspaceRuns({ tenantId: "t-1" } as never, "c-1", "t-2"),
    ).rejects.toThrow(/signed-in user/);
    expect(svc.listWorkspaceRuns).not.toHaveBeenCalled();
  });

  it("parses limit and forwards cursor", async () => {
    const { c, svc } = controller();
    await c.workspaceRuns(
      { userId: "u-1" } as never,
      "c-1",
      "t-2",
      "10",
      "cur",
    );
    expect(svc.listWorkspaceRuns).toHaveBeenCalledWith("u-1", "c-1", "t-2", {
      limit: 10,
      cursor: "cur",
    });
  });

  it("drops a garbage ?limit (NaN never reaches Prisma) and trims/empties the cursor", async () => {
    const { c, svc } = controller();
    await c.workspaceRuns(
      { userId: "u-1" } as never,
      "c-1",
      "t-2",
      "abc",
      "  cur  ",
    );
    expect(svc.listWorkspaceRuns).toHaveBeenCalledWith("u-1", "c-1", "t-2", {
      limit: undefined,
      cursor: "cur",
    });
    await c.workspaceRuns({ userId: "u-1" } as never, "c-1", "t-2", "5", "   ");
    expect(svc.listWorkspaceRuns).toHaveBeenLastCalledWith(
      "u-1",
      "c-1",
      "t-2",
      { limit: 5, cursor: undefined },
    );
  });
});
