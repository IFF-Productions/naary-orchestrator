import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDef } from "@naary/dsl";

const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();
vi.mock("@naary/db", () => ({
  // #904: this spec has no renamed workflows, so the alias resolver is the identity. A spec
  // that DOES exercise aliases stubs it to return the live key (see workflow-key-alias.spec.ts).
  resolveWorkflowKey: async (_t: string, k: string) => k,
  getPrisma: () => ({
    graphDefinition: { findFirst, create, update },
  }),
}));

import { GraphsService } from "../src/graphs/graphs.service";

/**
 * Save-time ownership check for a formTrigger's `logoAssetId`.
 *
 * The zod schema only checks the id's SHAPE — a uuid. Ownership needs a database lookup, so it lives
 * in the save path. Without it, a tenant could paste an id learned from another workspace's public
 * form (asset ids are visible in the served definition of any public form) and serve that image as
 * their own: cross-tenant hotlinking of a file we host and pay to serve.
 *
 * Rejecting at SAVE rather than dropping on read is deliberate. An author who pasted the wrong id has
 * made a mistake worth being told about; silently showing no logo would leave them re-uploading and
 * wondering why nothing changed.
 */
const LOGO = "9f3a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b";

function formGraph(branding: unknown): GraphDef {
  return {
    startNodeId: "form",
    nodes: [
      {
        id: "form",
        type: "formTrigger",
        config: { fields: [], branding } as never,
      },
      { id: "end", type: "end" },
    ],
    edges: [{ from: "form", to: "end" }],
  };
}

function makeService(ownedBy: ReturnType<typeof vi.fn>) {
  return new GraphsService(undefined, undefined, undefined, {
    ownedBy,
  } as never);
}

beforeEach(() => {
  findFirst.mockReset();
  create.mockReset();
  update.mockReset();
  // No prior version → the upsert takes the create path.
  findFirst.mockResolvedValue(null);
  create.mockResolvedValue({ version: 1, contentHash: "h", name: "n" });
});

describe("logoAssetId ownership at save time", () => {
  it("saves when the asset belongs to this tenant AND environment", async () => {
    const ownedBy = vi.fn().mockResolvedValue(true);
    await makeService(ownedBy).upsert(
      "t-1",
      "e-1",
      "wk",
      "My form",
      formGraph({ logoAssetId: LOGO }),
    );
    expect(ownedBy).toHaveBeenCalledWith(LOGO, "t-1", "e-1");
    expect(create).toHaveBeenCalled();
  });

  it("REFUSES to save an asset id owned by someone else", async () => {
    const ownedBy = vi.fn().mockResolvedValue(false);
    await expect(
      makeService(ownedBy).upsert(
        "t-1",
        "e-1",
        "wk",
        "My form",
        formGraph({ logoAssetId: LOGO }),
      ),
    ).rejects.toThrow(BadRequestException);
    // And nothing is persisted.
    expect(create).not.toHaveBeenCalled();
  });

  it("names the offending id, so the author can see which one is wrong", async () => {
    const ownedBy = vi.fn().mockResolvedValue(false);
    await expect(
      makeService(ownedBy).upsert(
        "t-1",
        "e-1",
        "wk",
        "My form",
        formGraph({ logoAssetId: LOGO }),
      ),
    ).rejects.toThrow(new RegExp(LOGO));
  });

  /** The check must be env-scoped too: a sandbox logo isn't a prod logo. */
  it("passes the SAVE environment to the check, not a default", async () => {
    const ownedBy = vi.fn().mockResolvedValue(true);
    await makeService(ownedBy).upsert(
      "t-1",
      "e-prod",
      "wk",
      "My form",
      formGraph({ logoAssetId: LOGO }),
    );
    expect(ownedBy).toHaveBeenCalledWith(LOGO, "t-1", "e-prod");
  });

  it("does no lookup when no logo is set", async () => {
    const ownedBy = vi.fn().mockResolvedValue(true);
    await makeService(ownedBy).upsert(
      "t-1",
      "e-1",
      "wk",
      "My form",
      formGraph({ accentColor: "#3355ff" }),
    );
    expect(ownedBy).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalled();
  });

  it("does no lookup for a graph with no formTrigger at all", async () => {
    const ownedBy = vi.fn().mockResolvedValue(true);
    await makeService(ownedBy).upsert("t-1", "e-1", "wk", "My form", {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "end", type: "end" },
      ],
      edges: [{ from: "s", to: "end" }],
    });
    expect(ownedBy).not.toHaveBeenCalled();
  });

  /**
   * A graph can carry more than one formTrigger — only one is the ENTRY, but a draft can hold others,
   * and a node that isn't the entry today can become it tomorrow. Checking only the entry would let a
   * foreign id ride along until it was live.
   */
  it("checks EVERY formTrigger's logo, not just the entry node's", async () => {
    const other = "11111111-2222-3333-4444-555555555555";
    const ownedBy = vi.fn().mockResolvedValue(true);
    await makeService(ownedBy).upsert("t-1", "e-1", "wk", "My form", {
      startNodeId: "form",
      nodes: [
        {
          id: "form",
          type: "formTrigger",
          config: { fields: [], branding: { logoAssetId: LOGO } } as never,
        },
        {
          id: "form2",
          type: "formTrigger",
          config: { fields: [], branding: { logoAssetId: other } } as never,
        },
        { id: "end", type: "end" },
      ],
      edges: [{ from: "form", to: "end" }],
    });
    expect(ownedBy).toHaveBeenCalledTimes(2);
    expect(ownedBy).toHaveBeenCalledWith(LOGO, "t-1", "e-1");
    expect(ownedBy).toHaveBeenCalledWith(other, "t-1", "e-1");
  });

  it("dedupes a logo reused across nodes to one lookup", async () => {
    const ownedBy = vi.fn().mockResolvedValue(true);
    await makeService(ownedBy).upsert("t-1", "e-1", "wk", "My form", {
      startNodeId: "form",
      nodes: [
        {
          id: "form",
          type: "formTrigger",
          config: { fields: [], branding: { logoAssetId: LOGO } } as never,
        },
        {
          id: "form2",
          type: "formTrigger",
          config: { fields: [], branding: { logoAssetId: LOGO } } as never,
        },
        { id: "end", type: "end" },
      ],
      edges: [{ from: "form", to: "end" }],
    });
    expect(ownedBy).toHaveBeenCalledTimes(1);
  });

  /**
   * FAILS CLOSED when the verifier isn't wired — the correction to an earlier version of this code that
   * skipped the check and justified it with "a foreign id resolves to a 404". That justification was
   * false: `GET /forms/assets/:id` is deliberately NOT tenant-scoped, so an unverified foreign id is
   * served SUCCESSFULLY. Skipping would have left cross-tenant hotlinking open on every DI-less save
   * path (scripts, seeds, the CLI).
   */
  it("REFUSES to save a logo when the asset service isn't wired", async () => {
    await expect(
      new GraphsService().upsert(
        "t-1",
        "e-1",
        "wk",
        "My form",
        formGraph({ logoAssetId: LOGO }),
      ),
    ).rejects.toThrow(/not wired/i);
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * ...but the gate only trips when a logo is actually present, so the many bare
   * `new GraphsService()` constructions (tests, CLI, seeds) keep saving ordinary graphs untouched.
   */
  it("still saves a logo-less graph with no asset service wired", async () => {
    await new GraphsService().upsert("t-1", "e-1", "wk", "My form", {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "end", type: "end" },
      ],
      edges: [{ from: "s", to: "end" }],
    });
    expect(create).toHaveBeenCalled();
  });
});
