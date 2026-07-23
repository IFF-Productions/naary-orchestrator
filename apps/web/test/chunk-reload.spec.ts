import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isChunkLoadError,
  reloadForFreshChunks,
} from "../src/lib/chunk-reload";

describe("isChunkLoadError", () => {
  it("matches the real Vite stale-chunk / dynamic-import messages", () => {
    const messages = [
      "Unable to preload CSS for https://app.naar-y.com/assets/decompile-graph-DLioOiRN.css",
      "Failed to fetch dynamically imported module: https://app/assets/x.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
    ];
    for (const m of messages) {
      expect(isChunkLoadError(new Error(m))).toBe(true);
    }
  });

  it("does NOT match unrelated errors", () => {
    expect(isChunkLoadError(new Error("Network request failed"))).toBe(false);
    expect(isChunkLoadError(new TypeError("x is not a function"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("reloadForFreshChunks (loop guard)", () => {
  const store = new Map<string, string>();
  const reload = vi.fn();

  beforeEach(() => {
    store.clear();
    reload.mockClear();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal("window", { location: { reload } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reloads once, then NOT again within the guard window (no reload loop)", () => {
    reloadForFreshChunks();
    expect(reload).toHaveBeenCalledTimes(1);
    // A second failure right away (fresh index still can't load / offline) must not loop.
    reloadForFreshChunks();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads when sessionStorage throws (private mode)", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    reloadForFreshChunks();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
