import { BadRequestException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { V1WorkflowsController } from "../src/v1/v1-workflows.controller";

/**
 * The v1 workflows controller is thin glue over GraphsService + the consolidated
 * WorkflowLifecycleService (shared with graphs.controller) — its job is (1) call the SAME services
 * the SPA uses and (2) map the internal result into a v1-OWNED response. These tests pin the DTO seam
 * (§5) and the top-level graph guard (400, not a 500). The DEFAULT-ENV-ONLY schedule side-effects
 * live in WorkflowLifecycleService and are tested in workflow-lifecycle.service.spec.
 */

const graphs = {
  list: vi.fn(),
  getLatestNamed: vi.fn(),
  promote: vi.fn(),
  listPromotions: vi.fn(),
};
const environments = { resolveEnvId: vi.fn(), isDefaultEnv: vi.fn() };
const lifecycle = {
  saveWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
};

const GRAPH = { nodes: [], edges: [], startNodeId: "start" };

let ctrl: V1WorkflowsController;
beforeEach(() => {
  vi.clearAllMocks();
  environments.resolveEnvId.mockResolvedValue("env-1");
  environments.isDefaultEnv.mockResolvedValue(true);
  ctrl = new V1WorkflowsController(
    graphs as never,
    environments as never,
    lifecycle as never,
  );
});

describe("V1WorkflowsController.list", () => {
  it("resolves the env and maps GraphSummary[] to the v1 shape", async () => {
    graphs.list.mockResolvedValue([
      {
        workflowKey: "triage",
        name: "Triage",
        version: 4,
        updatedAt: "2026-07-04T12:00:00.000Z",
        active: true,
      },
    ]);

    const out = await ctrl.list("t-1", "sandbox");

    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", "sandbox");
    expect(graphs.list).toHaveBeenCalledWith("t-1", "env-1");
    expect(out).toEqual([
      {
        workflowKey: "triage",
        name: "Triage",
        version: 4,
        updatedAt: "2026-07-04T12:00:00.000Z",
        active: true,
      },
    ]);
  });
});

describe("V1WorkflowsController.get (export)", () => {
  it("maps the export doc { workflowKey, name, version, graph }", async () => {
    graphs.getLatestNamed.mockResolvedValue({
      workflowKey: "triage",
      name: "Triage",
      version: 4,
      graph: GRAPH,
    });

    const out = await ctrl.get("t-1", "triage", undefined);

    expect(graphs.getLatestNamed).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "triage",
    );
    expect(out).toEqual({
      workflowKey: "triage",
      name: "Triage",
      version: 4,
      graph: GRAPH,
    });
  });

  it("404s when the workflow doesn't exist in the env", async () => {
    graphs.getLatestNamed.mockResolvedValue(null);
    await expect(ctrl.get("t-1", "nope", undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("V1WorkflowsController.put (create/update/import)", () => {
  it("saves via the consolidated lifecycle path and maps the snapshot to the v1 shape", async () => {
    lifecycle.saveWorkflow.mockResolvedValue({
      version: 5,
      contentHash: "sha-abc",
    });

    const out = await ctrl.put(
      "t-1",
      "triage",
      { name: "Triage", graph: GRAPH },
      undefined,
    );

    // The ONE save path (upsert + default-env-only schedule sync) shared with graphs.controller.
    expect(lifecycle.saveWorkflow).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "triage",
      "Triage",
      GRAPH,
    );
    expect(out).toEqual({
      workflowKey: "triage",
      version: 5,
      contentHash: "sha-abc",
    });
  });

  it("rejects a malformed graph with 400 (never a 500 inside validateGraph)", async () => {
    await expect(
      ctrl.put("t-1", "k", { name: "K", graph: { not: "a graph" } }, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lifecycle.saveWorkflow).not.toHaveBeenCalled();
  });
});

describe("V1WorkflowsController.remove", () => {
  it("deletes via the consolidated lifecycle path (teardown + deleteShared gating live there)", async () => {
    lifecycle.deleteWorkflow.mockResolvedValue(true);

    const out = await ctrl.remove("t-1", "k", undefined);

    expect(lifecycle.deleteWorkflow).toHaveBeenCalledWith("t-1", "env-1", "k");
    expect(out).toEqual({ deleted: true });
  });

  it("404s when nothing was deleted", async () => {
    environments.resolveEnvId.mockResolvedValue("env-sandbox");
    lifecycle.deleteWorkflow.mockResolvedValue(false);
    await expect(ctrl.remove("t-1", "gone", "sandbox")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("V1WorkflowsController.promote", () => {
  it("resolves both envs and derives the actor from the principal", async () => {
    environments.resolveEnvId
      .mockResolvedValueOnce("env-active") // from = active env (envSel)
      .mockResolvedValueOnce("env-prod"); // to = body.toEnv
    graphs.promote.mockResolvedValue({
      fromVersion: 5,
      toVersion: 3,
      contentHash: "h",
    });

    const out = await ctrl.promote(
      "t-1",
      "triage",
      { toEnv: "prod", fromVersion: 5 },
      { tenantId: "t-1", subject: "auth0|abc" } as never,
      "uat",
    );

    expect(graphs.promote).toHaveBeenCalledWith(
      "t-1",
      "triage",
      "env-active",
      "env-prod",
      "auth0|abc",
      5,
    );
    expect(out).toEqual({ fromVersion: 5, toVersion: 3, contentHash: "h" });
  });

  it("falls back to 'api-token' when the principal has no subject/userId (nry_ token)", async () => {
    environments.resolveEnvId
      .mockResolvedValueOnce("env-active")
      .mockResolvedValueOnce("env-prod");
    graphs.promote.mockResolvedValue({
      fromVersion: 1,
      toVersion: 1,
      contentHash: "h",
    });

    await ctrl.promote(
      "t-1",
      "triage",
      { toEnv: "prod" },
      { tenantId: "t-1" } as never,
      undefined,
    );

    expect(graphs.promote).toHaveBeenCalledWith(
      "t-1",
      "triage",
      "env-active",
      "env-prod",
      "api-token",
      undefined,
    );
  });
});

describe("V1WorkflowsController.promotions", () => {
  it("maps the lineage rows", async () => {
    graphs.listPromotions.mockResolvedValue([
      {
        fromEnvId: "env-a",
        toEnvId: "env-b",
        fromVersion: 5,
        toVersion: 3,
        actor: "api-token",
        createdAt: "2026-07-04T12:00:00.000Z",
      },
    ]);

    const out = await ctrl.promotions("t-1", "triage");

    expect(graphs.listPromotions).toHaveBeenCalledWith("t-1", "triage");
    expect(out[0]).toEqual({
      fromEnvId: "env-a",
      toEnvId: "env-b",
      fromVersion: 5,
      toVersion: 3,
      actor: "api-token",
      createdAt: "2026-07-04T12:00:00.000Z",
    });
  });
});
