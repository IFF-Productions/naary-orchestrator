import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();
vi.mock("@naary/db", () => ({
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
