import { describe, expect, it } from "vitest";
import type { GraphDef } from "@naary/dsl";
import { moderationGraph } from "@naary/dsl";
import {
  applyMigration,
  formatReport,
  type GraphRow,
  MIGRATION_ACTOR,
  planMigration,
} from "../src/graphs/failing-open-migration";
import type { GraphsService } from "../src/graphs/graphs.service";

/** `moderationGraph` as it shipped BEFORE #1015 — what a tenant who used the template has. */
const LEGACY_MODERATION: GraphDef = {
  ...moderationGraph,
  nodes: moderationGraph.nodes.map((n) =>
    n.id === "classify"
      ? {
          ...n,
          config: {
            provider: "anthropic",
            model: "claude-opus-4-8",
            systemPrompt:
              'Classify the submitted content for policy violations. Respond with a JSON object: { "flagged": boolean, "reason": string }. Flag anything unsafe, spammy, or abusive.',
          },
        }
      : n,
  ),
};

/** A schema-less agent whose prompt mentions JSON — the NOTIFY shape, never migrated. */
const LOOKALIKE: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "judge",
      type: "agent",
      config: {
        systemPrompt: 'Respond with ONLY a JSON object: { "ok": boolean }.',
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "judge" },
    { from: "judge", to: "end" },
  ],
};

/** An ordinary free-text agent — neither migrated nor flagged. */
const INNOCENT: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "draft",
      type: "agent",
      config: { systemPrompt: "Write a short, friendly acknowledgement." },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "draft" },
    { from: "draft", to: "end" },
  ],
};

function row(overrides: Partial<GraphRow> & { graph: GraphDef }): GraphRow {
  return {
    tenantId: "t-1",
    environmentId: "env-prod",
    workflowKey: "content-moderation-gate",
    name: "Content moderation gate",
    version: 4,
    ...overrides,
  };
}

/** A GraphsService stand-in that records every upsert. */
function fakeGraphs(impl?: (args: unknown[]) => { version: number }) {
  const calls: unknown[][] = [];
  const service = {
    upsert: async (...args: unknown[]) => {
      calls.push(args);
      const res = impl?.(args) ?? { version: 5 };
      return { graph: args[4] as GraphDef, contentHash: "hash", ...res };
    },
  } as unknown as GraphsService;
  return { service, calls };
}

describe("planMigration — migrate the exact forks, notify the rest", () => {
  it("plans a migration for an exact fork", () => {
    const plan = planMigration([row({ graph: LEGACY_MODERATION })]);
    expect(plan.migrations).toHaveLength(1);
    expect(plan.flagged).toHaveLength(0);
    expect(plan.migrations[0].templateKey).toBe("moderation");
    expect(plan.migrations[0].agentNodeId).toBe("classify");
  });

  it("FLAGS the lookalike instead of rewriting it", () => {
    const plan = planMigration([
      row({ workflowKey: "my-judge", graph: LOOKALIKE }),
    ]);
    expect(plan.migrations).toHaveLength(0);
    expect(plan.flagged).toHaveLength(1);
    expect(plan.flagged[0].warnings[0]).toContain("judge:");
  });

  it("leaves an ordinary free-text agent alone entirely", () => {
    const plan = planMigration([row({ workflowKey: "ack", graph: INNOCENT })]);
    expect(plan).toMatchObject({ migrations: [], flagged: [], scanned: 1 });
  });

  it("carries the tenant / environment / workflow of each affected row", () => {
    const plan = planMigration([
      row({
        tenantId: "t-a",
        environmentId: "env-1",
        graph: LEGACY_MODERATION,
      }),
      row({
        tenantId: "t-b",
        environmentId: "env-2",
        graph: LEGACY_MODERATION,
      }),
      row({ workflowKey: "my-judge", graph: LOOKALIKE }),
    ]);
    expect(plan.scanned).toBe(3);
    expect(plan.migrations.map((m) => m.row.tenantId)).toEqual(["t-a", "t-b"]);
    expect(plan.migrations.map((m) => m.row.environmentId)).toEqual([
      "env-1",
      "env-2",
    ]);
  });

  it("the version note names the issue, the symptom and the rollback", () => {
    const [m] = planMigration([row({ graph: LEGACY_MODERATION })]).migrations;
    expect(m.saveMessage).toContain("#1016");
    expect(m.saveMessage).toContain("auto-accepted");
    expect(m.saveMessage).toContain("previous version");
  });
});

describe("applyMigration — dry run is the default", () => {
  it("writes NOTHING unless asked", async () => {
    const { service, calls } = fakeGraphs();
    const plan = planMigration([row({ graph: LEGACY_MODERATION })]);
    const report = await applyMigration(service, plan); // no opts at all
    expect(calls).toHaveLength(0);
    expect(report.dryRun).toBe(true);
    expect(report.outcomes[0].written).toBe(false);
    expect(report.outcomes[0].version).toBe(5); // what it WOULD become
  });

  it("--apply writes a NEW version through the ordinary save path, attributed and annotated", async () => {
    const { service, calls } = fakeGraphs();
    const plan = planMigration([row({ graph: LEGACY_MODERATION })]);
    const report = await applyMigration(service, plan, { dryRun: false });

    expect(calls).toHaveLength(1);
    const [tenantId, environmentId, workflowKey, name, graph, actor, msg, by] =
      calls[0];
    expect(tenantId).toBe("t-1");
    expect(environmentId).toBe("env-prod");
    expect(workflowKey).toBe("content-moderation-gate");
    expect(name).toBe("Content moderation gate");
    // No Principal: an actor would trigger an RBAC assert this CLI cannot satisfy.
    expect(actor).toBeUndefined();
    expect(msg).toContain("#1016");
    expect(by).toBe(MIGRATION_ACTOR);

    // The saved graph is the fork PLUS the schema — the one field that was missing.
    const classify = (graph as GraphDef).nodes.find(
      (n) => n.id === "classify",
    )!;
    expect(
      (classify.config as { outputSchema: { properties: object } }).outputSchema
        .properties,
    ).toHaveProperty("flagged");

    expect(report.outcomes[0]).toMatchObject({ version: 5, written: true });
  });

  it("IDEMPOTENT: a second run over the already-migrated graph plans nothing", () => {
    const plan = planMigration([row({ graph: LEGACY_MODERATION })]);
    const migrated = plan.migrations[0].graph;
    expect(planMigration([row({ graph: migrated })]).migrations).toHaveLength(
      0,
    );
  });

  it("IDEMPOTENT backstop: an unchanged content hash returns the same version, reported as UNCHANGED", async () => {
    // What `upsert` does when the graph is byte-identical to the latest row.
    const { service } = fakeGraphs(() => ({ version: 4 }));
    const plan = planMigration([row({ graph: LEGACY_MODERATION })]);
    const report = await applyMigration(service, plan, { dryRun: false });
    expect(report.outcomes[0].written).toBe(false);
    expect(formatReport(report).join("\n")).toContain("UNCHANGED");
  });

  it("one failing workflow does not abort the sweep", async () => {
    let n = 0;
    const service = {
      upsert: async () => {
        n += 1;
        if (n === 1) throw new Error("Invalid node config — httpRequest: url");
        return { graph: {} as GraphDef, contentHash: "h", version: 5 };
      },
    } as unknown as GraphsService;

    const plan = planMigration([
      row({ tenantId: "t-a", graph: LEGACY_MODERATION }),
      row({ tenantId: "t-b", graph: LEGACY_MODERATION }),
    ]);
    const report = await applyMigration(service, plan, { dryRun: false });
    expect(report.outcomes[0].error).toContain("Invalid node config");
    expect(report.outcomes[1]).toMatchObject({ written: true });
  });
});

describe("formatReport — the blast radius is a fact afterwards", () => {
  it("names every migrated workflow by tenant, environment and key", async () => {
    const plan = planMigration([
      row({
        tenantId: "t-a",
        environmentId: "env-1",
        graph: LEGACY_MODERATION,
      }),
      row({ workflowKey: "my-judge", graph: LOOKALIKE }),
    ]);
    const out = formatReport(await applyMigration(fakeGraphs().service, plan));
    const text = out.join("\n");
    expect(text).toContain("WOULD MIGRATE");
    expect(text).toContain("t-a/env-1/content-moderation-gate v4 → v5");
    expect(text).toContain("FLAGGED ONLY");
    expect(text).toContain("NOT modified");
    expect(text).toContain("2 workflow(s) scanned");
    expect(text).toContain("Re-run with --apply");
  });

  it("says MIGRATED, not WOULD MIGRATE, once it has written", async () => {
    const plan = planMigration([row({ graph: LEGACY_MODERATION })]);
    const report = await applyMigration(fakeGraphs().service, plan, {
      dryRun: false,
    });
    const text = formatReport(report).join("\n");
    expect(text).toContain("MIGRATED");
    expect(text).not.toContain("WOULD MIGRATE");
    expect(text).not.toContain("Re-run with --apply");
  });
});
