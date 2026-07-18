import { describe, expect, it } from "vitest";
import { DEFAULT_API_URL, maskToken, resolveConfig } from "../src/config";

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
