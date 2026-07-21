import { InMemoryProvider } from "@openfeature/server-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLAG_CATALOG } from "../src/catalog";
import {
  __flagsDeps,
  __resetFlags,
  flag,
  flagsConfig,
  getAllFlags,
  initFlags,
} from "../src/flags";

afterEach(async () => {
  await __resetFlags();
  vi.restoreAllMocks();
});

describe("flagsConfig", () => {
  it("returns null when FLAGSMITH_ENVIRONMENT_KEY is unset", () => {
    const prev = process.env.FLAGSMITH_ENVIRONMENT_KEY;
    delete process.env.FLAGSMITH_ENVIRONMENT_KEY;
    expect(flagsConfig()).toBeNull();
    if (prev !== undefined) process.env.FLAGSMITH_ENVIRONMENT_KEY = prev;
  });
});

describe("fail-safe defaults (no provider configured)", () => {
  it("initFlags() is a no-op returning false when unconfigured", () => {
    vi.spyOn(__flagsDeps, "config").mockReturnValue(null);
    expect(initFlags()).toBe(false);
  });

  it("flag() returns the passed default on the Noop provider (never throws)", async () => {
    // No init → default OpenFeature Noop provider → resolves to the default.
    await expect(flag("chat-rag", false, "tenant-1")).resolves.toBe(false);
    await expect(flag("chat-rag", true, "tenant-1")).resolves.toBe(true);
  });

  it("getAllFlags() returns every catalog key at its code default", async () => {
    const all = await getAllFlags("tenant-1");
    // Derived from the catalog so adding a flag doesn't require touching this assertion.
    const expected = Object.fromEntries(
      Object.entries(FLAG_CATALOG).map(([k, spec]) => [k, spec.default]),
    );
    expect(all).toEqual(expected);
  });
});

describe("configured provider (InMemory stands in for Flagsmith)", () => {
  it("initFlags() wires the provider and flag()/getAllFlags() reflect it", async () => {
    // Drive init through the seam with an InMemoryProvider so no network/env is needed.
    vi.spyOn(__flagsDeps, "config").mockReturnValue({
      environmentKey: "ser.test",
    });
    vi.spyOn(__flagsDeps, "buildProvider").mockReturnValue(
      new InMemoryProvider({
        "chat-rag": {
          disabled: false,
          variants: { on: true, off: false },
          defaultVariant: "on",
        },
      }) as never,
    );
    expect(initFlags()).toBe(true);
    // setProvider is non-awaited; poll until the provider warms up (deterministic, not a
    // fixed sleep that could flake on slow CI) — it resolves the configured value once ready.
    await expect.poll(() => flag("chat-rag", false, "tenant-1")).toBe(true);

    await expect(flag("chat-rag", false, "tenant-1")).resolves.toBe(true);
    const all = await getAllFlags("tenant-1");
    expect(all["chat-rag"]).toBe(true);
    // A key the provider doesn't define still falls back to its catalog default.
    expect(all["new-canvas-inspector"]).toBe(
      FLAG_CATALOG["new-canvas-inspector"].default,
    );
  });

  it("initFlags() is idempotent (second call short-circuits to true)", () => {
    vi.spyOn(__flagsDeps, "config").mockReturnValue({
      environmentKey: "ser.test",
    });
    const build = vi
      .spyOn(__flagsDeps, "buildProvider")
      .mockReturnValue(new InMemoryProvider({}) as never);
    expect(initFlags()).toBe(true);
    expect(initFlags()).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("stays fail-safe (Noop, returns false) if provider construction throws", () => {
    vi.spyOn(__flagsDeps, "config").mockReturnValue({
      environmentKey: "ser.test",
    });
    vi.spyOn(__flagsDeps, "buildProvider").mockImplementation(() => {
      throw new Error("bad key");
    });
    expect(initFlags()).toBe(false);
  });
});
