import { describe, expect, it } from "vitest";
import { DSL_PACKAGE } from "@naary/dsl";
import { CONTRACTS_PACKAGE } from "@naary/contracts";

// Proves the pnpm-workspace boundary actually resolves at runtime (built JS in
// node_modules via symlink), not just at type-check time. When dsl/contracts
// gain real exports (Tasks 1 & 3) this becomes a real assertion; for now it
// guards that the workspace wiring + build output are importable.
describe("pnpm workspace cross-package resolution", () => {
  it("imports the built @naary/dsl package", () => {
    expect(DSL_PACKAGE).toBe("@naary/dsl");
  });

  it("imports the built @naary/contracts package", () => {
    expect(CONTRACTS_PACKAGE).toBe("@naary/contracts");
  });
});
