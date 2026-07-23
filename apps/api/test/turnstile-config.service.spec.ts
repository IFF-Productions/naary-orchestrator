import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma accessor before importing the service.
const turnstileConfig = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
};
vi.mock("@naary/db", () => ({ getPrisma: () => ({ turnstileConfig }) }));

import type { SecretStore } from "@naary/secrets";
import {
  __turnstileDeps,
  TurnstileConfigService,
} from "../src/turnstile/turnstile-config.service";

function makeService() {
  const secrets = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const service = new TurnstileConfigService(secrets as unknown as SecretStore);
  return { service, secrets };
}

const T = "t-1";
const E = "e-1";

beforeEach(() => {
  turnstileConfig.findUnique.mockReset();
  turnstileConfig.upsert.mockReset().mockResolvedValue(undefined);
  turnstileConfig.deleteMany.mockReset().mockResolvedValue({ count: 1 });
});

describe("TurnstileConfigService", () => {
  it("get returns null when no config exists", async () => {
    const { service } = makeService();
    turnstileConfig.findUnique.mockResolvedValue(null);
    expect(await service.get(T, E)).toBeNull();
  });

  it("get returns the view with hasSecret, but NEVER the secret value", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "site",
      enabled: true,
      allowedHostnames: ["example.com"],
    });
    secrets.get.mockResolvedValue("the-secret"); // a secret IS stored
    const view = await service.get(T, E);
    expect(view).toEqual({
      siteKey: "site",
      enabled: true,
      hasSecret: true,
      allowedHostnames: ["example.com"],
    });
    // the plaintext secret must not appear anywhere in the returned view
    expect(JSON.stringify(view)).not.toContain("the-secret");
  });

  it("hasSecret is false when no secret is stored", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "site",
      enabled: false,
    });
    secrets.get.mockResolvedValue(null);
    expect((await service.get(T, E))?.hasSecret).toBe(false);
  });

  it("save upserts site key + enabled and stores the secret when provided", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "site",
      enabled: true,
    });
    secrets.get.mockResolvedValue("x");
    await service.save(T, E, {
      siteKey: " site ",
      secretKey: " sk ",
      enabled: true,
    });
    expect(turnstileConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ siteKey: "site", enabled: true }),
        update: expect.objectContaining({ siteKey: "site", enabled: true }),
      }),
    );
    // secret stored under the reserved, listing-excluded key, trimmed
    expect(secrets.put).toHaveBeenCalledWith(T, E, "turnstile:secret", "sk");
  });

  it("save does NOT touch the secret when secretKey is omitted (write-only keep)", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "site",
      enabled: false,
    });
    secrets.get.mockResolvedValue("x");
    await service.save(T, E, { siteKey: "site", enabled: false });
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it("save rejects a missing site key", async () => {
    const { service } = makeService();
    await expect(
      service.save(T, E, { siteKey: "  ", enabled: true }),
    ).rejects.toThrow();
    expect(turnstileConfig.upsert).not.toHaveBeenCalled();
  });

  it("remove deletes the row AND the stored secret", async () => {
    const { service, secrets } = makeService();
    await service.remove(T, E);
    expect(turnstileConfig.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: T, environmentId: E },
    });
    expect(secrets.remove).toHaveBeenCalledWith(T, E, "turnstile:secret");
  });
});

describe("TurnstileConfigService.publicSiteKey", () => {
  it("returns the site key only when enabled AND a secret is stored", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: true,
    });
    secrets.get.mockResolvedValue("secret");
    expect(await service.publicSiteKey(T, E)).toBe("sk");
  });

  it("returns null when disabled or unconfigured or secret-less", async () => {
    const { service, secrets } = makeService();
    // disabled
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: false,
    });
    secrets.get.mockResolvedValue("secret");
    expect(await service.publicSiteKey(T, E)).toBeNull();
    // enabled but no secret
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: true,
    });
    secrets.get.mockResolvedValue(null);
    expect(await service.publicSiteKey(T, E)).toBeNull();
    // no row
    turnstileConfig.findUnique.mockResolvedValue(null);
    expect(await service.publicSiteKey(T, E)).toBeNull();
  });
});

describe("TurnstileConfigService.verify", () => {
  const realFetch = __turnstileDeps.fetch;
  afterEach(() => {
    __turnstileDeps.fetch = realFetch;
  });

  function enforced(
    secrets: { get: ReturnType<typeof vi.fn> },
    allowedHostnames: string[] = [],
  ) {
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: true,
      allowedHostnames,
    });
    secrets.get.mockResolvedValue("the-secret");
  }

  function siteverifyReturns(json: Record<string, unknown>) {
    __turnstileDeps.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => json,
    }) as never;
  }

  it("ALLOWS (no siteverify) when the gate isn't enforced", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: false,
    });
    secrets.get.mockResolvedValue("x");
    const fetchSpy = vi.fn();
    __turnstileDeps.fetch = fetchSpy as never;
    expect(await service.verify(T, E, "tok")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ALLOWS when enabled but no secret (can't enforce)", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: true,
    });
    secrets.get.mockResolvedValue(null);
    expect(await service.verify(T, E, "tok")).toBe(true);
  });

  it("DENIES when enforced and no token", async () => {
    const { service, secrets } = makeService();
    enforced(secrets);
    expect(await service.verify(T, E, undefined)).toBe(false);
  });

  it("verifies with Cloudflare and DENIES on success:false", async () => {
    const { service, secrets } = makeService();
    enforced(secrets);
    __turnstileDeps.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false }),
    }) as never;
    expect(await service.verify(T, E, "bad")).toBe(false);
  });

  it("ALLOWS on success:true", async () => {
    const { service, secrets } = makeService();
    enforced(secrets);
    __turnstileDeps.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }) as never;
    expect(await service.verify(T, E, "good")).toBe(true);
  });

  it("FAILS OPEN on a network error (Cloudflare outage must not brick the form)", async () => {
    const { service, secrets } = makeService();
    enforced(secrets);
    __turnstileDeps.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network")) as never;
    expect(await service.verify(T, E, "tok")).toBe(true);
  });

  it("FAILS OPEN on a 5xx from Cloudflare", async () => {
    const { service, secrets } = makeService();
    enforced(secrets);
    __turnstileDeps.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }) as never;
    expect(await service.verify(T, E, "tok")).toBe(true);
  });

  // #615 — allowed-hostnames check (server-side "allowed domains", also kills token-replay).
  it("ALLOWS a solved hostname that IS on the allowlist", async () => {
    const { service, secrets } = makeService();
    enforced(secrets, ["example.com"]);
    siteverifyReturns({ success: true, hostname: "example.com" });
    expect(await service.verify(T, E, "good")).toBe(true);
  });

  it("DENIES a solved hostname NOT on the allowlist (replay from another site)", async () => {
    const { service, secrets } = makeService();
    enforced(secrets, ["example.com"]);
    siteverifyReturns({ success: true, hostname: "attacker.test" });
    expect(await service.verify(T, E, "lifted")).toBe(false);
  });

  it("DENIES when the allowlist is set but siteverify returns no hostname", async () => {
    const { service, secrets } = makeService();
    enforced(secrets, ["example.com"]);
    siteverifyReturns({ success: true });
    expect(await service.verify(T, E, "x")).toBe(false);
  });

  it("matches the allowlist case-insensitively", async () => {
    const { service, secrets } = makeService();
    enforced(secrets, ["example.com"]);
    siteverifyReturns({ success: true, hostname: "EXAMPLE.COM" });
    expect(await service.verify(T, E, "x")).toBe(true);
  });

  it("an EMPTY allowlist allows any solved hostname (no restriction)", async () => {
    const { service, secrets } = makeService();
    enforced(secrets, []);
    siteverifyReturns({ success: true, hostname: "anywhere.test" });
    expect(await service.verify(T, E, "x")).toBe(true);
  });
});
