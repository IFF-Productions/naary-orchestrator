/**
 * Build with AI, EDIT mode: the decisions that follow from `?key=`.
 *
 * Two of them are #874 in a new place — the save must land as the next VERSION of the bound
 * workflow (not a slugified fork that orphans its run history, schedules and webhook URLs), and a
 * draft that can't be shown to descend from what's saved now must not be published silently.
 */
import { describe, expect, it } from "vitest";
import type { GraphDef } from "@naary/dsl";
import {
  EDIT_KEY_PARAM,
  type EditTarget,
  isBindingPending,
  openArgsFor,
  parseEditKey,
  renameNotice,
  saveTargetFor,
  staleWarning,
} from "../src/screens/app/build-ai/edit-target";

const GRAPH: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "start", to: "end" }],
};

const TARGET: EditTarget = {
  workflowKey: "nightly-report",
  name: "Nightly report",
  baseVersion: 3,
};

describe("parseEditKey", () => {
  it("reads the workflow key out of ?key=", () => {
    expect(parseEditKey(new URLSearchParams("key=nightly-report"))).toBe(
      "nightly-report",
    );
    expect(EDIT_KEY_PARAM).toBe("key");
  });

  it("is null when absent, blank, or longer than the server accepts", () => {
    expect(parseEditKey(new URLSearchParams(""))).toBeNull();
    expect(parseEditKey(new URLSearchParams("key="))).toBeNull();
    expect(parseEditKey(new URLSearchParams("key=%20%20"))).toBeNull();
    // OpenSessionDto caps workflowKey at 200 — fail here rather than 400 mid-turn.
    expect(
      parseEditKey(new URLSearchParams(`key=${"a".repeat(201)}`)),
    ).toBeNull();
    expect(parseEditKey(new URLSearchParams(`key=${"a".repeat(200)}`))).toBe(
      "a".repeat(200),
    );
  });

  it("trims surrounding whitespace", () => {
    expect(parseEditKey(new URLSearchParams("key=%20nightly%20"))).toBe(
      "nightly",
    );
  });
});

describe("openArgsFor", () => {
  it("sends the workflowKey (which is what makes the server seed the draft) and the name as title", () => {
    expect(openArgsFor(TARGET)).toEqual({
      workflowKey: "nightly-report",
      title: "Nightly report",
    });
  });

  it("is UNDEFINED with no target, so a from-scratch build's request body is unchanged", () => {
    // Strictly undefined, not {}: the client does `opts ?? {}`, so this is the only value that
    // reproduces today's argument-less openBuilderSession() byte for byte.
    expect(openArgsFor(null)).toBeUndefined();
  });
});

describe("isBindingPending", () => {
  it("is true while ?key= is set and the binding hasn't resolved — no turn may be sent", () => {
    // The destructive window: openArgsFor(null) would open an UNBOUND session, making the first
    // turn a from-scratch create and the save a slugified fork of the user's workflow.
    expect(isBindingPending("nightly-report", null, null)).toBe(true);
  });

  it("is false once the target is known", () => {
    expect(isBindingPending("nightly-report", TARGET, null)).toBe(false);
  });

  it("is false for a from-scratch build (no ?key= to wait for)", () => {
    expect(isBindingPending(null, null, null)).toBe(false);
  });

  it("is false when the read FAILED — the binding is established, just unverified", () => {
    expect(isBindingPending("nightly-report", null, "couldn't load it")).toBe(
      false,
    );
  });
});

describe("saveTargetFor", () => {
  it("saves to the BOUND KEY, so POST /graphs mints the next version of that workflow", () => {
    expect(
      saveTargetFor(TARGET, { name: "Nightly report", graph: GRAPH }),
    ).toEqual({ workflowKey: "nightly-report", name: "Nightly report" });
  });

  it("keeps the bound key even when the draft's name would slugify to something else (#874)", () => {
    // The exact fork: slugify("Nightly Report v2") is "nightly-report-v2", a NEW workflow —
    // leaving the original's run history, schedules and webhook URLs behind.
    const save = saveTargetFor(TARGET, {
      name: "Nightly Report v2",
      graph: GRAPH,
    });
    expect(save.workflowKey).toBe("nightly-report");
    expect(save.name).toBe("Nightly Report v2");
  });

  it("falls back to the saved name when the draft's is blank", () => {
    expect(saveTargetFor(TARGET, { name: "   ", graph: GRAPH }).name).toBe(
      "Nightly report",
    );
  });

  it("unbound: slugifies the draft name, exactly as before", () => {
    expect(saveTargetFor(null, { name: "My New Flow", graph: GRAPH })).toEqual({
      workflowKey: "my-new-flow",
      name: "My New Flow",
    });
  });
});

describe("staleWarning", () => {
  it("is null when the workflow is still at the version the draft descends from", () => {
    expect(staleWarning(TARGET, { version: 3 })).toBeNull();
  });

  it("warns when the workflow moved on, naming both versions and what Save would publish", () => {
    const w = staleWarning(TARGET, { version: 5 });
    expect(w).toContain("v3");
    expect(w).toContain("v5");
    expect(w).toContain("v6");
  });

  it("treats an UNKNOWN base as stale — a resumed session's draft may be days old", () => {
    // The session row doesn't record which version it seeded from, so "no evidence of drift"
    // and "evidence of no drift" are different things and only the latter may save silently.
    const w = staleWarning({ ...TARGET, baseVersion: null }, { version: 3 });
    expect(w).not.toBeNull();
    expect(w).toContain("earlier snapshot");
  });

  it("warns that saving would RE-CREATE a workflow that no longer exists", () => {
    const w = staleWarning(TARGET, null);
    expect(w).toContain("no longer exists");
    expect(w).toContain("run history");
  });
});

describe("renameNotice", () => {
  it("is null while the draft keeps the saved name (including whitespace-only drift)", () => {
    expect(renameNotice(TARGET, "Nightly report")).toBeNull();
    expect(renameNotice(TARGET, " Nightly report ")).toBeNull();
    expect(renameNotice(TARGET, null)).toBeNull();
    expect(renameNotice(TARGET, "  ")).toBeNull();
  });

  it("names the new name when the draft renamed the workflow", () => {
    expect(renameNotice(TARGET, "Nightly digest")).toContain("Nightly digest");
  });
});
