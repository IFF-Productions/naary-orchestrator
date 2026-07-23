import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma accessor before importing the service.
const turnstileConfig = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
};
vi.mock("@naary/db", () => ({ getPrisma: () => ({ turnstileConfig }) }));

import type { SecretStore } from "@naary/secrets";
import { TurnstileConfigService } from "../src/turnstile/turnstile-config.service";

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
    });
    secrets.get.mockResolvedValue("the-secret"); // a secret IS stored
    const view = await service.get(T, E);
    expect(view).toEqual({ siteKey: "site", enabled: true, hasSecret: true });
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
