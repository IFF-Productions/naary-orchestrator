import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SecretStore } from "@naary/secrets";
import { __httpDeps } from "../src/temporal/activities";
import { __mcpDeps } from "../src/temporal/activities";

// The seam lazily constructs a real SecretStore (createKeyEncryptor reads ENCRYPTION_KEY at build).
// We spy on the prototype method so no DB/crypto actually runs, but construction still needs the key.
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("hex");
});

// Wiring guard (#459): the httpRequest + mcpTool $secrets seams must resolve via the store's
// getWithGlobalFallback (env value WINS, else the tenant-wide one) — NOT the env-only `get`. A
// regression that left a seam on `.get()` would pass every store/service test yet silently never
// consult a tenant-wide secret, so this proves the seams themselves are rewired + `secret:`-prefixed.
describe("worker $secrets seams route through getWithGlobalFallback (env overrides global)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("httpRequest getSecret calls store.getWithGlobalFallback with the secret:-prefixed name", async () => {
    // Spy on the prototype so no real DB/crypto runs (the seam constructs a real SecretStore lazily).
    const spy = vi
      .spyOn(SecretStore.prototype, "getWithGlobalFallback")
      .mockResolvedValue("ENV_WINS");
    const getSpy = vi.spyOn(SecretStore.prototype, "get");

    const out = await __httpDeps.getSecret("t1", "env-prod", "GH_TOKEN");

    expect(out).toBe("ENV_WINS");
    expect(spy).toHaveBeenCalledWith("t1", "env-prod", "secret:GH_TOKEN");
    // The env-only accessor must NOT be the seam — that would skip tenant-wide secrets.
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("mcpTool getSecret calls store.getWithGlobalFallback with the secret:-prefixed name", async () => {
    const spy = vi
      .spyOn(SecretStore.prototype, "getWithGlobalFallback")
      .mockResolvedValue("ENV_WINS");
    const getSpy = vi.spyOn(SecretStore.prototype, "get");

    const out = await __mcpDeps.getSecret("t1", "env-prod", "API_KEY");

    expect(out).toBe("ENV_WINS");
    expect(spy).toHaveBeenCalledWith("t1", "env-prod", "secret:API_KEY");
    expect(getSpy).not.toHaveBeenCalled();
  });
});
