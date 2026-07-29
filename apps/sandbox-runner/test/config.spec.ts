import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("requires a runner token", () => {
    expect(() => loadConfig({})).toThrow(/SANDBOX_RUNNER_TOKEN is required/);
  });

  it("parses positive-int env vars and falls back safely on junk", () => {
    const cfg = loadConfig({
      SANDBOX_RUNNER_TOKEN: "t",
      SANDBOX_MEMORY_MB: "4096",
      SANDBOX_PIDS: "-5", // negative → fallback (not silently accepted)
      SANDBOX_TIMEOUT_MS: "notanumber", // NaN → fallback
      PORT: "0", // 0 → fallback (not a valid listen port here)
    });
    expect(cfg.limits.memoryMb).toBe(4096);
    expect(cfg.limits.pids).toBe(256); // default
    expect(cfg.defaultTimeoutMs).toBe(15 * 60 * 1000); // default
    expect(cfg.port).toBe(8099); // default
  });

  it("uses safe defaults when optional vars are absent", () => {
    const cfg = loadConfig({ SANDBOX_RUNNER_TOKEN: "t" });
    expect(cfg.network).toBe("naary-sandbox-internal");
    // One image PER TOOL since #680, each with its own DISTINCT default — a missing override
    // must never fall back to another tool's image (that was #933's cursor-argv-to-claude bug).
    expect(cfg.images).toEqual({
      claude: "naary-claude-sandbox:latest",
      cursor: "naary-cursor-sandbox:latest",
      copilot: "naary-copilot-sandbox:latest",
      gemini: "naary-gemini-sandbox:latest",
    });
    expect(cfg.limits.memoryMb).toBe(2048);
    expect(cfg.requireDigest).toBe(false); // dev default — local `:latest` builds still work
  });
});

/**
 * DIGEST PINNING (the production posture). The runner holds the host Docker socket, so a mutable
 * `:latest` tag defeats the whole "pinned image" control — the bytes behind the name can be
 * replaced. CI publishes digest-pinned refs and deploy.yml sets SANDBOX_REQUIRE_DIGEST=1, which
 * must FAIL CLOSED: if the refs ever go missing, `loadImages` falls back to `:latest` and the
 * runner has to refuse to start rather than quietly launch whatever `:latest` now points at.
 */
describe("SANDBOX_REQUIRE_DIGEST", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`;
  const pinned = (tool: string) =>
    `ghcr.io/iff-productions/naary-${tool}-sandbox:sha-0123456789ab@${DIGEST}`;
  const allPinned = {
    SANDBOX_IMAGE_CLAUDE: pinned("claude"),
    SANDBOX_IMAGE_CURSOR: pinned("cursor"),
    SANDBOX_IMAGE_COPILOT: pinned("copilot"),
    SANDBOX_IMAGE_GEMINI: pinned("gemini"),
  };

  it("accepts digest-pinned images and records the flag", () => {
    const cfg = loadConfig({
      SANDBOX_RUNNER_TOKEN: "t",
      SANDBOX_REQUIRE_DIGEST: "1",
      ...allPinned,
    });
    expect(cfg.requireDigest).toBe(true);
    expect(cfg.images.claude).toBe(pinned("claude"));
  });

  it("REFUSES to boot on a mutable tag — including the `:latest` fallback of an unset var", () => {
    // Nothing set at all: every image falls back to its `:latest` default.
    expect(() =>
      loadConfig({ SANDBOX_RUNNER_TOKEN: "t", SANDBOX_REQUIRE_DIGEST: "1" }),
    ).toThrow(/not pinned by digest.*claude=naary-claude-sandbox:latest/s);
    // Three pinned, one not — the partial case CD could produce if one output went missing.
    expect(() =>
      loadConfig({
        SANDBOX_RUNNER_TOKEN: "t",
        SANDBOX_REQUIRE_DIGEST: "1",
        ...allPinned,
        SANDBOX_IMAGE_GEMINI: "naary-gemini-sandbox:latest",
      }),
    ).toThrow(/gemini=naary-gemini-sandbox:latest/);
  });

  it("rejects digest-SHAPED refs that are not actually a full digest", () => {
    for (const bad of [
      `naary-claude-sandbox@sha256:${"a".repeat(63)}`, // too short
      `naary-claude-sandbox@sha256:${"A".repeat(64)}`, // uppercase hex
      `naary-claude-sandbox@sha256:${"a".repeat(64)}-x`, // trailing junk
      `naary-claude-sandbox@sha256:${"a".repeat(64)}:latest`, // digest then a tag
    ]) {
      expect(() =>
        loadConfig({
          SANDBOX_RUNNER_TOKEN: "t",
          SANDBOX_REQUIRE_DIGEST: "1",
          ...allPinned,
          SANDBOX_IMAGE_CLAUDE: bad,
        }),
      ).toThrow(/not pinned by digest/);
    }
  });

  it("stays OFF for anything that isn't an explicit truthy value", () => {
    // Compose interpolates an UNSET var to the empty string, so blank must mean off — otherwise
    // every dev box using the prod overlay would refuse to start.
    for (const raw of ["", " ", "0", "false", "no", undefined]) {
      const cfg = loadConfig({
        SANDBOX_RUNNER_TOKEN: "t",
        ...(raw === undefined ? {} : { SANDBOX_REQUIRE_DIGEST: raw }),
      });
      expect(cfg.requireDigest, JSON.stringify(raw)).toBe(false);
    }
    for (const raw of ["1", "true", "TRUE", "yes", "on"]) {
      expect(() =>
        loadConfig({ SANDBOX_RUNNER_TOKEN: "t", SANDBOX_REQUIRE_DIGEST: raw }),
      ).toThrow(/not pinned by digest/);
    }
  });
});
