import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";

const getBudget = vi.fn();
const create = vi.fn();
const findMany = vi.fn();
const deleteMany = vi.fn();

vi.mock("@naary/usage", () => ({
  getBudget: (...a: unknown[]) => getBudget(...a),
}));
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ formEndpoint: { create, findMany, deleteMany } }),
}));

import { FormService } from "../src/forms/form.service";

beforeEach(() => vi.clearAllMocks());

describe("FormService.createEndpoint", () => {
  it("refuses to register a public form when the tenant has NO budget cap", async () => {
    getBudget.mockResolvedValue(null);
    await expect(
      new FormService().createEndpoint("t-1", "e-1", "contact-form"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled(); // no endpoint row created
  });

  it("registers and returns the public path when a budget cap exists", async () => {
    getBudget.mockResolvedValue({ monthlyCapUsd: 50 });
    create.mockResolvedValue({ id: "f-1" });
    const out = await new FormService().createEndpoint(
      "t-1",
      "e-1",
      "contact-form",
    );
    expect(out).toEqual({ formId: "f-1", formPath: "/forms/f-1" });
    expect(create).toHaveBeenCalledWith({
      data: {
        tenantId: "t-1",
        environmentId: "e-1",
        workflowId: "contact-form",
      },
    });
  });
});
