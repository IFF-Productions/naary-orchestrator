import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PollState cursor keying (env-scoped-schedules slice): the cursor row is keyed by the
 * 4-part (tenantId, environmentId, workflowKey, nodeId) composite. A legacy in-flight run
 * (started before the cutover) carries no environmentId in its PollMeta — the deps resolve
 * the tenant's DEFAULT env in-activity (the 6b readChannels precedent), so the old cursor
 * (backfilled to the default env by the migration) keeps working mid-cutover.
 */

const findUnique = vi.fn();
const upsert = vi.fn();
const getDefaultEnvironmentId = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ pollState: { findUnique, upsert } }),
  getDefaultEnvironmentId: (tenantId: string) =>
    getDefaultEnvironmentId(tenantId),
}));

import { __pollDeps } from "../src/temporal/activities";

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue({ lastKey: "k1" });
  upsert.mockReset().mockResolvedValue(undefined);
  getDefaultEnvironmentId.mockReset().mockResolvedValue("e-default");
});

describe("__pollDeps cursor keying", () => {
  it("readCursor keys on the 4-part composite when the meta carries an env", async () => {
    const out = await __pollDeps.readCursor({
      tenantId: "t1",
      environmentId: "e-sandbox",
      workflowKey: "wf",
      nodeId: "poll",
    });

    expect(out).toBe("k1");
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_environmentId_workflowKey_nodeId: {
          tenantId: "t1",
          environmentId: "e-sandbox",
          workflowKey: "wf",
          nodeId: "poll",
        },
      },
    });
    expect(getDefaultEnvironmentId).not.toHaveBeenCalled();
  });

  it("readCursor falls back to the DEFAULT env for a legacy meta (no environmentId)", async () => {
    await __pollDeps.readCursor({
      tenantId: "t1",
      workflowKey: "wf",
      nodeId: "poll",
    });

    expect(getDefaultEnvironmentId).toHaveBeenCalledWith("t1");
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_environmentId_workflowKey_nodeId: {
          tenantId: "t1",
          environmentId: "e-default",
          workflowKey: "wf",
          nodeId: "poll",
        },
      },
    });
  });

  it("writeCursor upserts under the 4-part key, creating an env-scoped row", async () => {
    await __pollDeps.writeCursor(
      {
        tenantId: "t1",
        environmentId: "e-sandbox",
        workflowKey: "wf",
        nodeId: "poll",
      },
      "k2",
    );

    expect(upsert).toHaveBeenCalledWith({
      where: {
        tenantId_environmentId_workflowKey_nodeId: {
          tenantId: "t1",
          environmentId: "e-sandbox",
          workflowKey: "wf",
          nodeId: "poll",
        },
      },
      create: {
        tenantId: "t1",
        environmentId: "e-sandbox",
        workflowKey: "wf",
        nodeId: "poll",
        lastKey: "k2",
      },
      update: { lastKey: "k2" },
    });
  });

  it("writeCursor falls back to the DEFAULT env for a legacy meta", async () => {
    await __pollDeps.writeCursor(
      { tenantId: "t1", workflowKey: "wf", nodeId: "poll" },
      "k2",
    );

    expect(getDefaultEnvironmentId).toHaveBeenCalledWith("t1");
    expect(upsert.mock.calls[0][0].create.environmentId).toBe("e-default");
  });
});
