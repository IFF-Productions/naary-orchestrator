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

describe("GraphsService error-handler binding", () => {
  it("getErrorHandler returns the bound key, or null when unset", async () => {
    findUnique.mockResolvedValueOnce({ errorWorkflowKey: "on-error" });
    expect(await new GraphsService().getErrorHandler("t1", "wf")).toBe(
      "on-error",
    );
    findUnique.mockResolvedValueOnce(null);
    expect(await new GraphsService().getErrorHandler("t1", "wf")).toBeNull();
  });

  it("setErrorHandler upserts a binding", async () => {
    await new GraphsService().setErrorHandler("t1", "wf", "on-error");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_workflowKey: { tenantId: "t1", workflowKey: "wf" } },
        create: {
          tenantId: "t1",
          workflowKey: "wf",
          errorWorkflowKey: "on-error",
        },
        update: { errorWorkflowKey: "on-error" },
      }),
    );
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("setErrorHandler(null) clears the binding", async () => {
    await new GraphsService().setErrorHandler("t1", "wf", null);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", workflowKey: "wf" },
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});
