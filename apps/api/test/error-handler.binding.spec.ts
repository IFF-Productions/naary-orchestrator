import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();
vi.mock("@naary/db", () => ({
  // #904: this spec has no renamed workflows, so the alias resolver is the identity. A spec
  // that DOES exercise aliases stubs it to return the live key (see workflow-key-alias.spec.ts).
  resolveWorkflowKey: async (_t: string, k: string) => k,
  getPrisma: () => ({
    errorHandler: { findUnique, upsert, deleteMany },
    // graphDefinition unused here but present so the service constructs cleanly
    graphDefinition: {},
  }),
}));

import { GraphsService } from "../src/graphs/graphs.service";

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
  deleteMany.mockReset();
});

// Env-scoped (slice-6 cleanup): every binding op keys on (tenant, env, workflowKey) — a
// sandbox binding is invisible to prod and vice versa.
describe("GraphsService error-handler binding", () => {
  it("getErrorHandler returns the bound key, or null when unset — env-scoped", async () => {
    findUnique.mockResolvedValueOnce({ errorWorkflowKey: "on-error" });
    expect(await new GraphsService().getErrorHandler("t1", "e1", "wf")).toBe(
      "on-error",
    );
    expect(findUnique.mock.calls[0][0].where).toEqual({
      tenantId_environmentId_workflowKey: {
        tenantId: "t1",
        environmentId: "e1",
        workflowKey: "wf",
      },
    });
    findUnique.mockResolvedValueOnce(null);
    expect(
      await new GraphsService().getErrorHandler("t1", "e1", "wf"),
    ).toBeNull();
  });

  it("setErrorHandler upserts a binding stamped with the env", async () => {
    await new GraphsService().setErrorHandler("t1", "e1", "wf", "on-error");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_environmentId_workflowKey: {
            tenantId: "t1",
            environmentId: "e1",
            workflowKey: "wf",
          },
        },
        create: {
          tenantId: "t1",
          environmentId: "e1",
          workflowKey: "wf",
          errorWorkflowKey: "on-error",
        },
        update: { errorWorkflowKey: "on-error" },
      }),
    );
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("setErrorHandler(null) clears only THIS env's binding", async () => {
    await new GraphsService().setErrorHandler("t1", "e1", "wf", null);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", environmentId: "e1", workflowKey: "wf" },
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});

// RBAC G1: the error-handler routes are view/edit-gated for a user-facing actor;
// the run-start read (no actor) stays ungated.
import { ForbiddenException } from "@nestjs/common";
import type { Principal } from "../src/auth/tenant.decorator";
import type { PermissionsService } from "../src/permissions/permissions.service";

describe("GraphsService error-handler G1 gates", () => {
  const member: Principal = { tenantId: "t1", userId: "u-1", role: "member" };

  it("getErrorHandler asserts `view` for an actor; setErrorHandler asserts `edit`", async () => {
    const assertCan = vi.fn().mockRejectedValue(new ForbiddenException("no"));
    const svc = new GraphsService({
      assertCan,
    } as unknown as PermissionsService);
    await expect(
      svc.getErrorHandler("t1", "e1", "wf", member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.setErrorHandler("t1", "e1", "wf", "on-error", member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertCan).toHaveBeenNthCalledWith(1, member, "view", "wf", "e1");
    expect(assertCan).toHaveBeenNthCalledWith(2, member, "edit", "wf", "e1");
    expect(upsert).not.toHaveBeenCalled(); // denial persisted nothing
  });

  it("the internal (actor-less) read is unchanged — no permissions consulted", async () => {
    const assertCan = vi.fn();
    const svc = new GraphsService({
      assertCan,
    } as unknown as PermissionsService);
    findUnique.mockResolvedValue(null);
    await svc.getErrorHandler("t1", "e1", "wf");
    expect(assertCan).not.toHaveBeenCalled();
  });
});
