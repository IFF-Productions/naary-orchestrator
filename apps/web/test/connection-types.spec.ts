import { describe, expect, it } from "vitest";
import {
  connectionTypeLabel,
  integrationsTabFor,
  requiredConnectionTypes,
} from "../src/lib/connection-types";

/**
 * The canvas's "needs a connection" lint. Reported from a real graph: a `codeAgent` node with no
 * `mode` set was marked broken and could not be fixed, because the inspector only renders the
 * connection picker under `mode === "write"`. The error pointed at a control the UI was hiding.
 */
describe("requiredConnectionTypes", () => {
  it("asks a READ-mode codeAgent for nothing — the default, and it clones no repo", () => {
    expect(requiredConnectionTypes({ type: "codeAgent" })).toBeNull();
    expect(
      requiredConnectionTypes({ type: "codeAgent", config: {} }),
    ).toBeNull();
    expect(
      requiredConnectionTypes({ type: "codeAgent", config: { mode: "read" } }),
    ).toBeNull();
  });

  it("asks a WRITE-mode codeAgent for GitHub — the App token authorizing the clone", () => {
    expect(
      requiredConnectionTypes({ type: "codeAgent", config: { mode: "write" } }),
    ).toEqual(["github"]);
  });

  it("never demands one from httpRequest — a public API needs no auth", () => {
    expect(requiredConnectionTypes({ type: "httpRequest" })).toBeNull();
  });

  it("still demands one from the nodes that genuinely cannot run without it", () => {
    expect(requiredConnectionTypes({ type: "sendEmail" })).toEqual(["smtp"]);
    expect(requiredConnectionTypes({ type: "sqlQuery" })).toEqual([
      "postgres",
      "mssql",
      "mysql",
    ]);
  });

  it("is null for a node type that takes no connection at all", () => {
    // `if`/`end`/`start` must not fall into the lint just because they lack a connectionId.
    expect(requiredConnectionTypes({ type: "if" })).toBeNull();
    expect(requiredConnectionTypes({ type: "end" })).toBeNull();
  });
});

describe("connectionTypeLabel", () => {
  it("names ONE type without a list", () => {
    expect(connectionTypeLabel(["github"])).toBe("GitHub");
  });

  it("reads a choice out loud rather than dumping the enum", () => {
    // The whole point of the fix: "needs a connection" left an author guessing which of eight
    // kinds to create.
    expect(connectionTypeLabel(["postgres", "mssql", "mysql"])).toBe(
      "Postgres, SQL Server or MySQL",
    );
  });

  it("is empty for no types, so a caller can't render a dangling article", () => {
    expect(connectionTypeLabel([])).toBe("");
  });
});

describe("integrationsTabFor", () => {
  it("routes apps and providers to the tab that actually hosts their form", () => {
    expect(integrationsTabFor("github")).toBe("apps");
    expect(integrationsTabFor("smtp")).toBe("providers");
  });
});
