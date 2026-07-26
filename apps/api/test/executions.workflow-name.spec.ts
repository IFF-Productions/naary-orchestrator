import { beforeEach, describe, expect, it, vi } from "vitest";

const executionFindMany = vi.fn();
const graphFindMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    execution: { findMany: executionFindMany },
    graphDefinition: { findMany: graphFindMany },
  }),
}));

import { ExecutionsService } from "../src/executions/executions.service";

/**
 * Run lists showed the workflow SLUG (`workflowKey`) — an implementation detail the operator never
 * chose. They now carry the display `name`, resolved from GraphDefinition.
 *
 * Resolved rather than snapshotted onto the Execution row: a run records the stable KEY (what the
 * trigger referenced), while the name is editable. Snapshotting would show the old name after a
 * rename — and a rename is exactly when someone goes looking at that workflow's runs.
 */
function makeService(): ExecutionsService {
  const service = new ExecutionsService(
    {} as never,
    {
      defaultEnvId: async () => "env-test",
      resolveEnvId: async () => "env-test",
    } as never,
  );
  (service as unknown as { client: unknown }).client = { workflow: {} };
  return service;
}

function run(workflowId: string, workflowKey: string | null, envId: string) {
  return {
    workflowId,
    tenantId: "t-1",
    workflowKey,
    environmentId: envId,
    status: "completed", // terminal → no Temporal reconcile
    costUsd: null,
    createdAt: new Date("2026-07-26T10:00:00Z"),
    finishedAt: null,
    failureKind: null,
    archivedAt: null,
    graphVersion: null,
  };
}

beforeEach(() => {
  executionFindMany.mockReset();
  graphFindMany.mockReset();
  graphFindMany.mockResolvedValue([]);
});

describe("workflow name on a run page", () => {
  it("resolves the name for each run", async () => {
    executionFindMany.mockResolvedValue([run("r1", "refund-triage", "env-1")]);
    graphFindMany.mockResolvedValue([
      {
        workflowKey: "refund-triage",
        environmentId: "env-1",
        name: "Refund triage",
      },
    ]);

    const page = await makeService().listPage("t-1");
    expect(page.items[0].workflowName).toBe("Refund triage");
    // The key is still there — it's what the API, CLI and triggers reference.
    expect(page.items[0].workflowKey).toBe("refund-triage");
  });

  /**
   * ONE query for the whole page. `toRunSummary` runs per row via `Promise.all(page.map(…))`, so a
   * lookup there would be a 50-query page — and the Runs screen pages 50 at a time, repeatedly. The
   * failure mode is invisible: it just gets slower as the tenant grows.
   */
  it("issues a single batched lookup for a whole page", async () => {
    executionFindMany.mockResolvedValue([
      run("r1", "refund-triage", "env-1"),
      run("r2", "invoice-sync", "env-1"),
      run("r3", "refund-triage", "env-1"),
    ]);
    graphFindMany.mockResolvedValue([
      { workflowKey: "refund-triage", environmentId: "env-1", name: "Refunds" },
      { workflowKey: "invoice-sync", environmentId: "env-1", name: "Invoices" },
    ]);

    const page = await makeService().listPage("t-1");

    expect(graphFindMany).toHaveBeenCalledTimes(1);
    // Distinct keys only.
    expect(
      [...graphFindMany.mock.calls[0][0].where.workflowKey.in].sort(),
    ).toEqual(["invoice-sync", "refund-triage"]);
    expect(page.items.map((i) => i.workflowName)).toEqual([
      "Refunds",
      "Invoices",
      "Refunds",
    ]);
  });

  /**
   * The subtle one. The SAME workflowKey exists independently per environment (copy-on-promote), so a
   * lookup keyed on the key alone would show a SANDBOX name on a PROD run — a wrong label that reads
   * as authoritative.
   */
  it("does not leak another environment's name for the same key", async () => {
    executionFindMany.mockResolvedValue([run("r1", "shared-key", "env-prod")]);
    graphFindMany.mockResolvedValue([
      {
        workflowKey: "shared-key",
        environmentId: "env-sandbox",
        name: "Sandbox draft",
      },
      {
        workflowKey: "shared-key",
        environmentId: "env-prod",
        name: "Production flow",
      },
    ]);

    const page = await makeService().listPage("t-1");
    expect(page.items[0].workflowName).toBe("Production flow");
  });

  /** The name is editable, so the CURRENT (highest-version) one is what a run should read as. */
  it("takes the latest version's name", async () => {
    executionFindMany.mockResolvedValue([run("r1", "wk", "env-1")]);
    // The query orders version DESC, so the first row per (env, key) is current.
    graphFindMany.mockResolvedValue([
      { workflowKey: "wk", environmentId: "env-1", name: "Renamed" },
      { workflowKey: "wk", environmentId: "env-1", name: "Original" },
    ]);
    const page = await makeService().listPage("t-1");
    expect(page.items[0].workflowName).toBe("Renamed");
    expect(graphFindMany.mock.calls[0][0].orderBy).toEqual([
      { workflowKey: "asc" },
      { version: "desc" },
    ]);
  });

  it("is null for a deleted workflow, so the UI falls back to the key", async () => {
    executionFindMany.mockResolvedValue([run("r1", "gone", "env-1")]);
    const page = await makeService().listPage("t-1");
    expect(page.items[0].workflowName).toBeNull();
    expect(page.items[0].workflowKey).toBe("gone");
  });

  /** `Execution.workflowKey` is nullable ("null for pre-migration rows") — those must not be queried
   *  for an empty key, and must resolve to null rather than to some arbitrary workflow. */
  it("skips a pre-migration run with no key entirely", async () => {
    executionFindMany.mockResolvedValue([run("r1", null, "env-1")]);
    const page = await makeService().listPage("t-1");
    expect(page.items[0].workflowName).toBeNull();
    expect(graphFindMany).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the tenant", async () => {
    executionFindMany.mockResolvedValue([run("r1", "wk", "env-1")]);
    await makeService().listPage("t-1");
    expect(graphFindMany.mock.calls[0][0].where.tenantId).toBe("t-1");
  });
});
