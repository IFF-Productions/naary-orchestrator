import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { CredentialsService } from "@naary/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretsModule } from "../src/secrets/secrets.module";

/**
 * SecretsModule builds CredentialsService in a FACTORY, so a misconfigured secret store
 * (#458) can only fail at module construction — i.e. at boot, invisible to unit tests that
 * hand-build the service. This suite is that gate: the module must still compile with the
 * new SecretProvider seam in place, and must FAIL to compile on bad config rather than
 * booting into a state where the first credential save 500s.
 */
const MASTER =
  "d411941f3d668658dc3942847a957162508d13458c6e2bd6407b13f405899996";

describe("SecretsModule DI (#458 secret-provider seam)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
      SECRET_PROVIDER: process.env.SECRET_PROVIDER,
      VAULT_ADDR: process.env.VAULT_ADDR,
      VAULT_TOKEN: process.env.VAULT_TOKEN,
    };
    process.env.ENCRYPTION_KEY = MASTER;
    delete process.env.SECRET_PROVIDER;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("compiles with the default (db) provider and resolves CredentialsService", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SecretsModule],
    }).compile();
    expect(moduleRef.get(CredentialsService, { strict: false })).toBeInstanceOf(
      CredentialsService,
    );
  });

  it("compiles with SECRET_PROVIDER=vault when fully configured", async () => {
    process.env.SECRET_PROVIDER = "vault";
    process.env.VAULT_ADDR = "https://vault.test:8200";
    process.env.VAULT_TOKEN = "unit-test-token";
    const moduleRef = await Test.createTestingModule({
      imports: [SecretsModule],
    }).compile();
    expect(moduleRef.get(CredentialsService, { strict: false })).toBeInstanceOf(
      CredentialsService,
    );
  });

  it("fails to boot on an incomplete vault config (never silently uses the DB)", async () => {
    process.env.SECRET_PROVIDER = "vault"; // no VAULT_ADDR / VAULT_TOKEN
    await expect(
      Test.createTestingModule({ imports: [SecretsModule] }).compile(),
    ).rejects.toThrow(/VAULT_ADDR/);
  });

  it("fails to boot on an unknown SECRET_PROVIDER", async () => {
    process.env.SECRET_PROVIDER = "asm"; // not implemented yet — must not fall back
    await expect(
      Test.createTestingModule({ imports: [SecretsModule] }).compile(),
    ).rejects.toThrow(/Unsupported SECRET_PROVIDER/);
  });

  it("still fails to boot without ENCRYPTION_KEY (unchanged security checklist)", async () => {
    delete process.env.ENCRYPTION_KEY;
    await expect(
      Test.createTestingModule({ imports: [SecretsModule] }).compile(),
    ).rejects.toThrow(/ENCRYPTION_KEY is required/);
  });
});
