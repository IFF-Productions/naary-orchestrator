import { describe, expect, it } from "vitest";
import { INTEGRATION_CATALOG, getIntegrationAction } from "@naary/dsl";
import {
  defaultConfigFor,
  NODE_DESCRIPTION,
  NODE_KINDS,
  nodeDisplayDescription,
  nodeDisplayLabel,
} from "../src/lib/graph-model";

describe("nodeDisplayLabel (custom name overrides the derived label)", () => {
  it("uses a trimmed config __name when set, else the derived type label", () => {
    expect(nodeDisplayLabel("agent", { __name: "  Classify ticket " })).toBe(
      "Classify ticket",
    );
    // Blank/whitespace or absent __name → the derived label, not an empty title.
    expect(nodeDisplayLabel("agent", { __name: "   " })).toBe(
      nodeDisplayLabel("agent"),
    );
    expect(nodeDisplayLabel("agent")).toBeTruthy();
    // A custom name overrides even the provider-derived integration label.
    expect(
      nodeDisplayLabel("integration", {
        provider: "github",
        __name: "Open issue",
      }),
    ).toBe("Open issue");
  });
});

describe("node registry (simpler-UX metadata)", () => {
  it("every node kind has a non-empty, plain-language description", () => {
    for (const k of NODE_KINDS) {
      expect(k.description, k.type).toBeTruthy();
      expect(k.description.length, k.type).toBeGreaterThan(10);
    }
  });

  it("NODE_DESCRIPTION covers every kind in the palette", () => {
    // A NodeType may have MULTIPLE palette tiles (e.g. `integration` → GitHub + Jira),
    // so NODE_DESCRIPTION (keyed by type) holds one of them; the palette renders each
    // tile's own `description`. Assert every type resolves to a real description.
    const byType = new Set(NODE_KINDS.map((k) => k.type));
    for (const type of byType) {
      const descs = NODE_KINDS.filter((k) => k.type === type).map(
        (k) => k.description,
      );
      expect(descs, type).toContain(NODE_DESCRIPTION[type]);
    }
  });

  it("defaultConfigFor returns a FRESH clone (canvas edits can't mutate the registry)", () => {
    const a = defaultConfigFor("agent");
    expect(a).toMatchObject({ provider: "anthropic" });
    // mutate the returned copy; the registry default must be untouched
    (a as Record<string, unknown>).provider = "mutated";
    expect(defaultConfigFor("agent")).toMatchObject({ provider: "anthropic" });
  });

  it("nodes without config default to undefined (e.g. start/end)", () => {
    expect(defaultConfigFor("start")).toBeUndefined();
    expect(defaultConfigFor("end")).toBeUndefined();
  });

  it("integration tiles are DERIVED from the catalog — every provider is reachable (#688)", () => {
    // The palette used to HAND-LIST four integration tiles, which left every other shipped
    // provider unreachable from the canvas (the /app/catalog derivation reads NODE_KINDS, so
    // it was gated by the same hand-list). Adding a provider to INTEGRATION_CATALOG must now
    // yield a tile with NO web-side edit — assert set equality, not just the count, so a
    // duplicated tile can't mask a missing one.
    const tiles = NODE_KINDS.filter((k) => k.type === "integration");
    const tileProviders = tiles.map((k) =>
      String(k.defaultConfig?.provider ?? ""),
    );
    expect(tiles.length).toBe(Object.keys(INTEGRATION_CATALOG).length);
    expect([...tileProviders].sort()).toEqual(
      Object.keys(INTEGRATION_CATALOG).sort(),
    );
    // No duplicate tiles, and each tile's label matches the provider's catalog label.
    expect(new Set(tileProviders).size).toBe(tileProviders.length);
    for (const k of tiles) {
      const key = String(k.defaultConfig?.provider ?? "");
      expect(k.label, key).toBe(INTEGRATION_CATALOG[key].label);
      expect(k.group, key).toBe("Integrations");
      expect(k.description.length, key).toBeGreaterThan(10);
    }
  });

  it("every integration tile's default action really exists on its provider", () => {
    for (const k of NODE_KINDS.filter((k) => k.type === "integration")) {
      const provider = String(k.defaultConfig?.provider ?? "");
      const action = String(k.defaultConfig?.action ?? "");
      expect(
        getIntegrationAction(provider, action),
        `${provider}.${action}`,
      ).toBeTruthy();
      // The tile presets an empty connection + fields the config panel then fills in.
      expect(k.defaultConfig?.connectionId, provider).toBe("");
      expect(k.defaultConfig?.fields, provider).toEqual({});
    }
  });

  it("the four original tiles keep their exact label/description/default action", () => {
    // Pinned verbatim: these four predate the derivation and their hand-written copy is
    // better than the catalog's generic wording, and their default action is the common
    // WRITE (the catalog's first action is a read). Nothing may shift for existing users.
    const byProvider = new Map(
      NODE_KINDS.filter((k) => k.type === "integration").map((k) => [
        String(k.defaultConfig?.provider ?? ""),
        k,
      ]),
    );
    const expected: Record<
      string,
      { label: string; description: string; action: string }
    > = {
      github: {
        label: "GitHub",
        description: "Act on GitHub issues — create, comment, label, or read.",
        action: "create_issue",
      },
      jira: {
        label: "Jira",
        description:
          "Manage Jira tickets — create, comment, transition, or read.",
        action: "create_issue",
      },
      slack: {
        label: "Slack",
        description:
          "Post to Slack — send a message, reply in a thread, or react.",
        action: "post_message",
      },
      notion: {
        label: "Notion",
        description:
          "Read/write Notion — query a database, create a page, append blocks.",
        action: "create_page",
      },
    };
    for (const [provider, want] of Object.entries(expected)) {
      const tile = byProvider.get(provider);
      expect(tile, provider).toBeTruthy();
      expect(tile?.label).toBe(want.label);
      expect(tile?.description).toBe(want.description);
      expect(tile?.defaultConfig?.action).toBe(want.action);
    }
    // GitHub stays FIRST: defaultConfigFor("integration") resolves the first tile.
    expect(defaultConfigFor("integration")).toMatchObject({
      provider: "github",
      action: "create_issue",
    });
    // …and the curated head keeps the original four at the top of the group.
    expect(
      NODE_KINDS.filter((k) => k.type === "integration")
        .slice(0, 4)
        .map((k) => k.defaultConfig?.provider),
    ).toEqual(["github", "jira", "slack", "notion"]);
  });

  it("nodeDisplayDescription is provider-aware for integration nodes", () => {
    // NODE_DESCRIPTION is keyed by node TYPE, so with ~34 integration tiles it collapses to
    // whichever tile is last — rendering it verbatim describes the wrong provider.
    expect(nodeDisplayDescription("integration", { provider: "github" })).toBe(
      "Act on GitHub issues — create, comment, label, or read.",
    );
    expect(nodeDisplayDescription("integration", { provider: "stripe" })).toBe(
      INTEGRATION_CATALOG.stripe.description,
    );
    // Unknown / missing provider still yields a real sentence, never undefined.
    expect(
      nodeDisplayDescription("integration", { provider: "nope" }).length,
    ).toBeGreaterThan(10);
    expect(nodeDisplayDescription("integration").length).toBeGreaterThan(10);
    // Non-integration types fall through to the registry description.
    expect(nodeDisplayDescription("agent")).toBe(NODE_DESCRIPTION.agent);
  });

  it("common data/action nodes ship with working example config (no blank first field)", () => {
    for (const type of [
      "agent",
      "httpRequest",
      "sqlQuery",
      "rssRead",
      "wait",
      "humanApproval",
    ] as const) {
      const cfg = defaultConfigFor(type);
      expect(cfg, type).toBeTruthy();
      expect(Object.keys(cfg ?? {}).length, type).toBeGreaterThan(0);
    }
  });
});
