// #1138 cause 2 — `GraphsService.upsert` refuses an integration node that cannot run.
//
// The reported product failure was: "anytime there is a 3rd party integration it always does not
// work". `validateGraphConfigs` is deliberately lenient on missing fields so a draft still saves,
// and every per-node zod schema is `.partial()`'d — so a node with no `connectionId`, a missing
// required action field, or an unfillable `<slot>` (#1139) saved cleanly and failed at RUN time,
// long after the author had stopped watching. `validateIntegrationConfig` existed the whole time
// and described itself as the save gate; nothing on the save path called it.
//
// The half of this that needs the most care is the FORGIVENESS rule, not the refusal: blocking
// every incomplete node would mean a user editing one step cannot save because a different step —
// possibly authored months ago, possibly by someone else — is incomplete, and the error would name
// a node they have no reason to care about. So an untouched node is forgiven and a touched one is
// not, which is why half these tests are about what still SAVES.
import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDef } from "@naary/dsl";

const findFirst = vi.fn();
const create = vi.fn();
vi.mock("@naary/db", () => ({
  resolveWorkflowKey: async (_t: string, k: string) => k,
  getPrisma: () => ({ graphDefinition: { findFirst, create } }),
}));

import { GraphsService } from "../src/graphs/graphs.service";

/** A graph whose one integration node carries `config`. */
const graphWith = (config: Record<string, unknown>): GraphDef =>
  ({
    startNodeId: "s",
    nodes: [
      { id: "s", type: "start" },
      { id: "post", type: "integration", config },
      { id: "z", type: "end" },
    ],
    edges: [
      { from: "s", to: "post" },
      { from: "post", to: "z" },
    ],
  }) as unknown as GraphDef;

const COMPLETE = {
  provider: "github",
  action: "create_issue",
  connectionId: "c1",
  fields: { owner: "acme", repo: "widgets", title: "Build broke" },
};

/** What `getLatest` will hand back as the STORED version, or null for a brand-new workflow. */
function storedAs(graph: GraphDef | null) {
  findFirst.mockReset();
  create.mockReset();
  create.mockResolvedValue({ id: "g1", version: 2, contentHash: "h" });
  // `getLatest` and the version lookup both go through findFirst; returning the same row for
  // either is enough here — this spec is about the gate, not about versioning.
  findFirst.mockResolvedValue(
    graph
      ? { id: "g1", version: 1, contentHash: "h0", graph, name: "W" }
      : null,
  );
}

// The gate is an AUTHORING gate, so every test that expects it to fire must pass an actor — and
// an actor makes `upsert` assert `edit`/`canCreate`, so the permission service has to be there.
// Allowing everything keeps this spec about the integration gate; RBAC has its own.
const permissions = {
  assertCan: async () => undefined,
  assertCanCreate: async () => undefined,
} as unknown as ConstructorParameters<typeof GraphsService>[0];

const ACTOR = {
  userId: "u1",
  tenantId: "t1",
  role: "admin",
} as unknown as Parameters<GraphsService["upsert"]>[5];

const svc = () => new GraphsService(permissions);

const save = (graph: GraphDef) =>
  svc().upsert("t1", "e1", "wf", "W", graph, ACTOR);

/** The actor-less form — promote's copy-in, the seeds, the migration CLI. A DEFAULT parameter
 *  would not do: `save(g, undefined)` re-applies the default and silently tests the actor path. */
const saveInternal = (graph: GraphDef) =>
  svc().upsert("t1", "e1", "wf", "W", graph);

beforeEach(() => storedAs(null));

describe("upsert — an integration node that cannot run is refused (#1138)", () => {
  it("refuses a NEW node with no connectionId — the case that produced the bug report", async () => {
    // This is the exact shape an AI-built workflow shipped: everything looks filled in, there is
    // no connection, and the failure arrived at run time as a provider error the author could not
    // connect back to anything they did.
    const err = await save(
      graphWith({ ...COMPLETE, connectionId: undefined }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const body = err.getResponse();
    expect(body.code).toBe("INTEGRATION_CONFIG_INCOMPLETE");
    // The node id must be in the payload, not just prose: the canvas puts the message ON the step,
    // and a toast the user has to map back to a step themselves is barely better than silence.
    expect(body.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual([
      "post",
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a NEW node missing a required action field", async () => {
    // `title` is required by `github.create_issue` and present-but-empty, which the shared
    // validator counts as missing — precisely because `buildIntegrationRequest` would drop it and
    // POST an issue with no title rather than fail.
    const err = await save(
      graphWith({ ...COMPLETE, fields: { ...COMPLETE.fields, title: "" } }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    // Names the field, because "invalid config" sends the author looking through every one.
    expect(String(err.getResponse().message)).toContain("title");
  });

  it("refuses a binding that names no source — an unfinished row is not a value", async () => {
    // The gate's own subtlety, and worth pinning from the save side: a half-drawn binding row used
    // to satisfy "supplied" and then resolve to empty at run time. Here it must not rescue a field
    // that has no static value either.
    const err = await save(
      graphWith({
        ...COMPLETE,
        fields: { owner: "acme", repo: "widgets" },
        fieldBindings: { title: {} },
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(String(err.getResponse().message)).toContain("title");
  });

  it("SAVES a complete node", async () => {
    await expect(save(graphWith(COMPLETE))).resolves.toBeTruthy();
    expect(create).toHaveBeenCalled();
  });
});

describe("upsert — you cannot be blocked by a node you did not touch", () => {
  it("SAVES when the broken node is byte-identical to the stored version", async () => {
    // Someone opens a workflow saved before this gate existed, renames it, presses save. The
    // broken step is not theirs and not what they were doing; refusing here would read as the
    // product breaking, and would strand every pre-existing incomplete workflow.
    const broken = { ...COMPLETE, connectionId: undefined };
    storedAs(graphWith(broken));
    await expect(save(graphWith(broken))).resolves.toBeTruthy();
    expect(create).toHaveBeenCalled();
  });

  it("REFUSES once that same node is edited, even part-way toward correct", async () => {
    // The other half of the rule, and the reason forgiveness is keyed on "unchanged" rather than
    // "pre-existing": a half-finished fix must not save, or the gate would be trivially escaped by
    // touching a broken node twice.
    storedAs(graphWith({ ...COMPLETE, connectionId: undefined }));
    // The edit goes INSIDE `fields`, where a real one does. Setting a top-level `title` would
    // also change the canonical form and pass, but by writing a key the action does not declare —
    // so the test would keep passing if the edit-detection stopped looking at fields at all.
    const err = await save(
      graphWith({
        ...COMPLETE,
        connectionId: undefined,
        fields: { ...COMPLETE.fields, title: "new title" },
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it("SAVES when the stored node differs only in KEY ORDER — the jsonb round-trip", async () => {
    // The defect this whole rule dies of if it is wrong. `graph` is a `jsonb` column, and Postgres
    // does not preserve key order, so the stored copy of an untouched node comes back with its
    // keys rearranged. Under `JSON.stringify` that compares unequal, every node reads as edited,
    // and forgiveness is dead code that nothing else in this file would notice.
    const broken = {
      provider: "github",
      action: "create_issue",
      fields: { owner: "acme", repo: "widgets", title: "T" },
    };
    storedAs(graphWith(broken));
    // Same config, keys emitted in a different order — what the round-trip actually hands back.
    await expect(
      save(
        graphWith({
          fields: { title: "T", repo: "widgets", owner: "acme" },
          action: "create_issue",
          provider: "github",
        }),
      ),
    ).resolves.toBeTruthy();
    expect(create).toHaveBeenCalled();
  });

  it("REFUSES a newly ADDED broken node even when a stored broken one is forgiven", async () => {
    // Both rules at once — the forgiven node must not become cover for a new one.
    const stored = graphWith({ ...COMPLETE, connectionId: undefined });
    storedAs(stored);
    const withNew = {
      ...stored,
      nodes: [
        ...stored.nodes,
        {
          id: "post2",
          type: "integration",
          config: { ...COMPLETE, connectionId: undefined },
        },
      ],
    } as unknown as GraphDef;
    const err = await save(withNew).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(
      err.getResponse().nodes.map((n: { nodeId: string }) => n.nodeId),
    ).toEqual(["post2"]);
  });
});

describe("upsert — copy-in is not authoring", () => {
  it("SAVES a broken node for an ACTOR-LESS caller (promote, seeds, migration CLI)", async () => {
    // A first promote into prod finds nothing stored there, so every node reads as new and the
    // ordinary rule would refuse the whole workflow — one a tenant may have been running in
    // sandbox for months, on the one side of the boundary that cannot fix it. These callers copy
    // a graph this instance already accepted; the author is who the gate is for, and they were
    // stopped at authoring time.
    await expect(
      saveInternal(graphWith({ ...COMPLETE, connectionId: undefined })),
    ).resolves.toBeTruthy();
    expect(create).toHaveBeenCalled();
  });
});
