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
    expect(cfg.image).toBe("naary-claude-sandbox:latest");
    expect(cfg.limits.memoryMb).toBe(2048);
  });
});
