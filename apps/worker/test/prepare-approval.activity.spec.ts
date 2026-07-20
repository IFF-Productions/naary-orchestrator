import { beforeEach, describe, expect, it, vi } from "vitest";

// Prisma seam: prepareApproval reads ONLY permission-group display names.
const groupFindMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ permissionGroup: { findMany: groupFindMany } }),
  getDefaultEnvironmentId: async () => "env-default",
  disconnectPrisma: async () => undefined,
}));

import { prepareApproval } from "../src/temporal/activities";

beforeEach(() => {
  groupFindMany.mockReset().mockResolvedValue([]);
});

describe("prepareApproval (Slice 1 pause-side snapshot)", () => {
  it("resolves contextFields expressions against the run ctx (typed + embedded), stamps pausedAt", async () => {
    const before = Date.now();
    const rec = await prepareApproval({
      tenantId: "t-1",
      nodeId: "gate",
      config: {
        slaHours: 48,
        contextFields: {
          Company: "{{ trigger.company }}", // whole token → typed, stringified for display
          Line: "Deal for {{ trigger.company }} ({{ trigger.amount }})",
          Raw: "no tokens here",
          Obj: "{{ trigger.meta }}", // object → JSON
          Missing: "{{ trigger.nope }}", // missing path → ""
        },
      },
      ctx: {
        trigger: { company: "Acme", amount: 1200, meta: { stage: "closing" } },
      },
    });
    expect(rec.nodeId).toBe("gate");
    expect(rec.slaHours).toBe(48);
    expect(Date.parse(rec.pausedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(rec.contextFields).toEqual({
      Company: "Acme",
      Line: "Deal for Acme (1200)",
      Raw: "no tokens here",
      Obj: '{"stage":"closing"}',
      Missing: "",
    });
  });

  it("NEVER resolves $secrets — the ref stays literal (leak-free by construction)", async () => {
    const rec = await prepareApproval({
      tenantId: "t-1",
      nodeId: "gate",
      config: {
        contextFields: {
          Key: "{{ $secrets.API_KEY }}",
          Mixed: "key={{ $secrets.API_KEY }} for {{ trigger.company }}",
        },
      },
      // Even a hostile ctx carrying a $secrets-shaped key must not resolve.
      ctx: { $secrets: { API_KEY: "sk-live-LEAK" }, trigger: { company: "A" } },
    });
    expect(rec.contextFields?.Key).toBe("{{ $secrets.API_KEY }}");
    expect(rec.contextFields?.Mixed).toBe("key={{ $secrets.API_KEY }} for A");
    expect(JSON.stringify(rec)).not.toContain("sk-live-LEAK");
  });

  it("resolves approver group DISPLAY names tenant-scoped; unknown ids keep the id", async () => {
    groupFindMany.mockResolvedValue([{ id: "g-1", name: "finance-leads" }]);
    const rec = await prepareApproval({
      tenantId: "t-1",
      nodeId: "gate",
      config: {
        approvers: {
          emails: ["sam@acme.io", " ", ""],
          groupIds: ["g-1", "g-deleted"],
        },
      },
      ctx: {},
    });
    expect(groupFindMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", id: { in: ["g-1", "g-deleted"] } },
      select: { id: true, name: true },
    });
    expect(rec.approvers).toEqual({
      emails: ["sam@acme.io"], // blank entries dropped
      groups: [
        { id: "g-1", name: "finance-leads" },
        { id: "g-deleted", name: "g-deleted" }, // unknown/deleted → id as name
      ],
    });
  });

  it("emails-only approvers need no group read", async () => {
    const rec = await prepareApproval({
      tenantId: "t-1",
      nodeId: "gate",
      config: { approvers: { emails: ["a@b.co"] } },
      ctx: {},
    });
    expect(groupFindMany).not.toHaveBeenCalled();
    expect(rec.approvers).toEqual({ emails: ["a@b.co"], groups: [] });
  });

  it("carries reminder/escalation display info; omits absent fields entirely", async () => {
    const rec = await prepareApproval({
      tenantId: "t-1",
      nodeId: "gate",
      config: {
        remindAfterHours: [4, 12],
        escalateAfterHours: 20,
        escalateTo: "@ops-oncall",
      },
      ctx: {},
    });
    expect(rec).toMatchObject({
      remindAfterHours: [4, 12],
      escalateAfterHours: 20,
      escalateTo: "@ops-oncall",
    });
    expect(rec.slaHours).toBeUndefined();
    expect(rec.contextFields).toBeUndefined();
    expect(rec.approvers).toBeUndefined();
  });
});
