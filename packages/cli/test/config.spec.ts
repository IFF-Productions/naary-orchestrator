import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_URL,
  maskToken,
  readConfigFile,
  resolveConfig,
  updateConfigFile,
  writeConfigFile,
} from "../src/config";

describe("resolveConfig precedence (flags > env > file > default)", () => {
  it("uses the default apiUrl when nothing is set", () => {
    expect(resolveConfig({}).apiUrl).toBe(DEFAULT_API_URL);
  });

  it("file value beats the default", () => {
    const c = resolveConfig({ file: { apiUrl: "https://file.example" } });
    expect(c.apiUrl).toBe("https://file.example");
  });

  it("env beats file", () => {
    const c = resolveConfig({
      env: { NAARY_API_URL: "https://env.example" },
      file: { apiUrl: "https://file.example" },
    });
    expect(c.apiUrl).toBe("https://env.example");
  });

  it("flags beat env and file", () => {
    const c = resolveConfig({
      flags: { apiUrl: "https://flag.example" },
      env: { NAARY_API_URL: "https://env.example" },
      file: { apiUrl: "https://file.example" },
    });
    expect(c.apiUrl).toBe("https://flag.example");
  });

  it("resolves token and env with the same precedence; token has no default", () => {
    expect(resolveConfig({}).token).toBeUndefined();
    const c = resolveConfig({
      flags: { token: "nry_flag" },
      env: { NAARY_TOKEN: "nry_env", NAARY_ENV: "prod" },
      file: { token: "nry_file", env: "sandbox" },
    });
    expect(c.token).toBe("nry_flag");
    expect(c.env).toBe("prod"); // env wins over file, no flag given
  });

  it("treats empty strings as unset (falls through precedence)", () => {
    const c = resolveConfig({
      flags: { token: "" },
      env: { NAARY_TOKEN: "nry_env" },
    });
    expect(c.token).toBe("nry_env");
  });
});

/**
 * Provenance, not diagnostics: `tokenSource` is what stops the refresh hook from rotating a token
 * the caller supplied deliberately (a CI token in `NAARY_TOKEN`, or an explicit `--token`).
 * Silently swapping that for a session token would substitute a different credential — and a
 * different set of permissions — for the one they named.
 */
describe("resolveConfig reports where the token came from", () => {
  it("names the winning source, and undefined when there is no token at all", () => {
    expect(resolveConfig({}).tokenSource).toBeUndefined();
    expect(resolveConfig({ flags: { token: "t" } }).tokenSource).toBe("flag");
    expect(resolveConfig({ env: { NAARY_TOKEN: "t" } }).tokenSource).toBe(
      "env",
    );
    expect(resolveConfig({ file: { token: "t" } }).tokenSource).toBe("file");
  });

  it("follows the SAME precedence as the token itself, including the empty-string rule", () => {
    expect(
      resolveConfig({
        flags: { token: "" },
        env: { NAARY_TOKEN: "" },
        file: { token: "nry_file" },
      }).tokenSource,
    ).toBe("file");
    expect(
      resolveConfig({
        env: { NAARY_TOKEN: "nry_env" },
        file: { token: "nry_file" },
      }).tokenSource,
    ).toBe("env");
  });
});

describe("the config file round-trips every field it is asked to hold", () => {
  const tempFile = (): string =>
    path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "naary-config-")),
      "config.json",
    );

  it("survives write → read → write without losing the session", () => {
    // The bug this pins: `readConfigFile` whitelists known keys, and writes are read-merge-write.
    // A field present in the type but missing from the whitelist is written once and then deleted
    // by the next write of ANY other field — and a login-path test would never see it.
    const file = tempFile();
    writeConfigFile(
      {
        apiUrl: "https://naary.example",
        token: "nry_access",
        refreshToken: "nryr_refresh",
        tokenExpiresAt: "2026-08-06T00:00:00.000Z",
        refreshTokenExpiresAt: "2026-11-03T00:00:00.000Z",
        tenantId: "tenant-A",
        env: "prod",
      },
      file,
    );
    const first = readConfigFile(file);
    updateConfigFile({ env: "sandbox" }, file);
    expect(readConfigFile(file)).toEqual({ ...first, env: "sandbox" });
  });

  it("drops non-string junk instead of producing `Bearer [object Object]`", () => {
    const file = tempFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ token: { nested: true }, refreshToken: 7, env: "prod" }),
    );
    expect(readConfigFile(file)).toEqual({ env: "prod" });
  });

  it("writes 0600 inside a 0700 dir, atomically, leaving no temp file", () => {
    const file = tempFile();
    writeConfigFile({ token: "nry_x", refreshToken: "nryr_y" }, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["config.json"]);
  });

  it("tightens an existing world-readable file rather than inheriting its mode", () => {
    // `writeFileSync`'s `mode` is ignored when the path already exists — which is exactly how a
    // 0644 config from an older CLI (or a restored backup) would keep a 90-day refresh token
    // readable by every account on the box.
    const file = tempFile();
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    writeConfigFile({ token: "nry_x" }, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("deletes keys whose patch value is undefined", () => {
    const file = tempFile();
    writeConfigFile({ apiUrl: "https://x", token: "nry_x" }, file);
    updateConfigFile({ token: undefined }, file);
    expect(readConfigFile(file)).toEqual({ apiUrl: "https://x" });
  });
});

describe("maskToken", () => {
  it("masks a long token to first4…last4", () => {
    expect(maskToken("nry_abcdef1234")).toBe("nry_…1234");
  });
  it("never returns the full token", () => {
    const full = "nry_supersecretvalue";
    expect(maskToken(full)).not.toContain("supersecret");
  });
  it("handles missing/short tokens", () => {
    expect(maskToken(undefined)).toBe("(none)");
    expect(maskToken("ab")).toBe("…ab");
  });
});
