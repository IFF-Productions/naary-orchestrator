import { describe, expect, it } from "vitest";
import { resolveRenameKeys } from "../src/rename-keys";
import type { RenameKeysNodeConfig } from "../src/types";

const ctx = {
  trigger: { user_id: "u-7", email: "a@b.co", internal: true },
  agent: { output: { a: 1, b: 2 } },
};

describe("resolveRenameKeys", () => {
  it("renames listed keys and keeps the rest", () => {
    const config: RenameKeysNodeConfig = {
      from: "trigger",
      rename: { user_id: "userId" },
    };
    expect(resolveRenameKeys(config, ctx)).toEqual({
      userId: "u-7",
      email: "a@b.co",
      internal: true,
    });
  });

  it("drops keys (drop wins over rename)", () => {
    const config: RenameKeysNodeConfig = {
      from: "trigger",
      rename: { internal: "keepMe" },
      drop: ["internal", "email"],
    };
    expect(resolveRenameKeys(config, ctx)).toEqual({ user_id: "u-7" });
  });

  it("reads a nested source via path", () => {
    const config: RenameKeysNodeConfig = {
      from: "agent",
      path: "output",
      rename: { a: "alpha" },
    };
    expect(resolveRenameKeys(config, ctx)).toEqual({ alpha: 1, b: 2 });
  });

  it("returns {} for a non-object / missing source", () => {
    expect(resolveRenameKeys({ from: "nope" }, ctx)).toEqual({});
    expect(
      resolveRenameKeys({ from: "trigger", path: "user_id" }, ctx),
    ).toEqual({});
  });

  it("does not mutate the source object", () => {
    const config: RenameKeysNodeConfig = {
      from: "trigger",
      rename: { user_id: "userId" },
    };
    resolveRenameKeys(config, ctx);
    expect(ctx.trigger).toEqual({
      user_id: "u-7",
      email: "a@b.co",
      internal: true,
    });
  });
});
