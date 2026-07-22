import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnvSecretsService } from "../src/env-secrets/env-secrets.service";

// A fake SecretStore capturing calls — the service must NEVER read a value back (write-only).
const store = {
  listKeys: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  get: vi.fn(), // present so a leak (calling get) would be visible; the service must not call it
  // Tenant-wide (global) secret store methods (#459).
  listGlobalKeys: vi.fn(),
  putGlobal: vi.fn(),
  removeGlobal: vi.fn(),
  getGlobal: vi.fn(), // present so a leak (decrypting to list) would be visible
};
const svc = new EnvSecretsService(store as never);

beforeEach(() => {
  for (const m of Object.values(store)) m.mockReset();
});

describe("EnvSecretsService.list — NAMES only, never values", () => {
  it("returns the secret:-namespaced names (prefix stripped by the store)", async () => {
    store.listKeys.mockResolvedValue(["API_KEY", "GITHUB_TOKEN"]);

    const out = await svc.list("t-1", "env-prod");

    expect(out).toEqual(["API_KEY", "GITHUB_TOKEN"]);
    expect(store.listKeys).toHaveBeenCalledWith("t-1", "env-prod", "secret:");
    // A write-only surface must never decrypt to list.
    expect(store.get).not.toHaveBeenCalled();
  });
});

describe("EnvSecretsService.set — name + value validation, secret: namespacing", () => {
  it("stores a valid secret under the secret: namespace (trims the name)", async () => {
    await svc.set("t-1", "env-prod", "  GITHUB_TOKEN  ", "ghp_abc");

    expect(store.put).toHaveBeenCalledWith(
      "t-1",
      "env-prod",
      "secret:GITHUB_TOKEN", // trimmed + namespaced
      "ghp_abc",
    );
  });

  it.each(["with space", "1leading", "has.dot", "a-b", ""])(
    "rejects an invalid name %j with 400 and never writes",
    async (badName) => {
      await expect(
        svc.set("t-1", "env-prod", badName, "v"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(store.put).not.toHaveBeenCalled();
    },
  );

  it.each([["" as unknown], [123], [null], [{}], [undefined]])(
    "rejects a non-string / empty value %j with 400 and never writes",
    async (badValue) => {
      await expect(
        svc.set("t-1", "env-prod", "TOKEN", badValue),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(store.put).not.toHaveBeenCalled();
    },
  );
});

describe("EnvSecretsService.remove", () => {
  it("removes the namespaced key (trims the name)", async () => {
    await svc.remove("t-1", "env-prod", "  GITHUB_TOKEN  ");

    expect(store.remove).toHaveBeenCalledWith(
      "t-1",
      "env-prod",
      "secret:GITHUB_TOKEN",
    );
  });
});

describe("EnvSecretsService global (tenant-wide) methods — no env, still write-only (#459)", () => {
  it("listGlobal returns NAMES only (never decrypts), no env argument", async () => {
    store.listGlobalKeys.mockResolvedValue(["API_KEY", "GITHUB_TOKEN"]);

    const out = await svc.listGlobal("t-1");

    expect(out).toEqual(["API_KEY", "GITHUB_TOKEN"]);
    expect(store.listGlobalKeys).toHaveBeenCalledWith("t-1", "secret:");
    expect(store.getGlobal).not.toHaveBeenCalled();
  });

  it("setGlobal stores under the secret: namespace (trims the name), no env", async () => {
    await svc.setGlobal("t-1", "  GITHUB_TOKEN  ", "ghp_abc");

    expect(store.putGlobal).toHaveBeenCalledWith(
      "t-1",
      "secret:GITHUB_TOKEN",
      "ghp_abc",
    );
  });

  it.each(["with space", "1leading", "has.dot", "a-b", ""])(
    "setGlobal rejects an invalid name %j with 400 and never writes",
    async (badName) => {
      await expect(svc.setGlobal("t-1", badName, "v")).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(store.putGlobal).not.toHaveBeenCalled();
    },
  );

  it.each([["" as unknown], [123], [null], [{}], [undefined]])(
    "setGlobal rejects a non-string / empty value %j with 400 and never writes",
    async (badValue) => {
      await expect(
        svc.setGlobal("t-1", "TOKEN", badValue),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(store.putGlobal).not.toHaveBeenCalled();
    },
  );

  it("removeGlobal removes the namespaced key (trims the name)", async () => {
    await svc.removeGlobal("t-1", "  GITHUB_TOKEN  ");

    expect(store.removeGlobal).toHaveBeenCalledWith(
      "t-1",
      "secret:GITHUB_TOKEN",
    );
  });
});
