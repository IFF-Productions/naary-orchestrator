import { BadRequestException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { V1WorkflowsController } from "../src/v1/v1-workflows.controller";

/**
 * The v1 workflows controller is thin glue over GraphsService — its job is (1) call the SAME service
 * the SPA uses and (2) map the internal result into a v1-OWNED response. These tests pin the DTO seam
 * (§5) and the two behaviours that aren't pure mapping: the top-level graph guard (400, not a 500),
 * and the DEFAULT-ENV-ONLY schedule side-effects that keep API-imported triggers firing.
 */

const graphs = {
  list: vi.fn(),
  getLatestNamed: vi.fn(),
  upsert: vi.fn(),
  deleteWorkflow: vi.fn(),
  promote: vi.fn(),
  listPromotions: vi.fn(),
};
const environments = { resolveEnvId: vi.fn(), isDefaultEnv: vi.fn() };
const schedules = {
  syncPollSchedule: vi.fn(),
  syncCronSchedule: vi.fn(),
  teardownForWorkflow: vi.fn(),
};

const GRAPH = { nodes: [], edges: [], startNodeId: "start" };

let ctrl: V1WorkflowsController;
beforeEach(() => {
  vi.clearAllMocks();
  environments.resolveEnvId.mockResolvedValue("env-1");
  environments.isDefaultEnv.mockResolvedValue(true);
  schedules.syncPollSchedule.mockResolvedValue(undefined);
  schedules.syncCronSchedule.mockResolvedValue(undefined);
  schedules.teardownForWorkflow.mockResolvedValue(undefined);
  ctrl = new V1WorkflowsController(
    graphs as never,
    environments as never,
    schedules as never,
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
  it("upserts and maps the saved snapshot to the v1 shape", async () => {
    graphs.upsert.mockResolvedValue({ version: 5, contentHash: "sha-abc" });

    const out = await ctrl.put(
      "t-1",
      "triage",
      { name: "Triage", graph: GRAPH },
      undefined,
    );

    expect(graphs.upsert).toHaveBeenCalledWith(
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

  it("syncs poll+cron schedules ONLY in the default env", async () => {
    graphs.upsert.mockResolvedValue({ version: 1, contentHash: "h" });

    // default env → synced
    environments.isDefaultEnv.mockResolvedValue(true);
    await ctrl.put("t-1", "k", { name: "K", graph: GRAPH }, undefined);
    expect(schedules.syncPollSchedule).toHaveBeenCalledWith("t-1", "k", GRAPH);
    expect(schedules.syncCronSchedule).toHaveBeenCalledWith("t-1", "k", GRAPH);

    vi.clearAllMocks();
    environments.resolveEnvId.mockResolvedValue("env-sandbox");
    graphs.upsert.mockResolvedValue({ version: 1, contentHash: "h" });

    // non-default env → NOT synced (would clobber the default/prod copy's triggers)
    environments.isDefaultEnv.mockResolvedValue(false);
    await ctrl.put("t-1", "k", { name: "K", graph: GRAPH }, "sandbox");
    expect(schedules.syncPollSchedule).not.toHaveBeenCalled();
    expect(schedules.syncCronSchedule).not.toHaveBeenCalled();
  });

  it("rejects a malformed graph with 400 (never a 500 inside validateGraph)", async () => {
    await expect(
      ctrl.put("t-1", "k", { name: "K", graph: { not: "a graph" } }, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(graphs.upsert).not.toHaveBeenCalled();
  });
});

describe("V1WorkflowsController.remove", () => {
  it("tears down schedules + passes deleteShared=true in the default env", async () => {
    environments.isDefaultEnv.mockResolvedValue(true);
    graphs.deleteWorkflow.mockResolvedValue(true);

    const out = await ctrl.remove("t-1", "k", undefined);

    expect(schedules.teardownForWorkflow).toHaveBeenCalledWith("t-1", "k");
    expect(graphs.deleteWorkflow).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "k",
      true,
    );
    expect(out).toEqual({ deleted: true });
  });

  it("does NOT tear down and passes deleteShared=false in a non-default env", async () => {
    environments.resolveEnvId.mockResolvedValue("env-sandbox");
    environments.isDefaultEnv.mockResolvedValue(false);
    graphs.deleteWorkflow.mockResolvedValue(true);

    await ctrl.remove("t-1", "k", "sandbox");

    expect(schedules.teardownForWorkflow).not.toHaveBeenCalled();
    expect(graphs.deleteWorkflow).toHaveBeenCalledWith(
      "t-1",
      "env-sandbox",
      "k",
      false,
    );
  });

  it("404s when nothing was deleted", async () => {
    environments.isDefaultEnv.mockResolvedValue(false);
    graphs.deleteWorkflow.mockResolvedValue(false);
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
