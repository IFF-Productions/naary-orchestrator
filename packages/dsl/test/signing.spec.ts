import { describe, expect, it } from "vitest";
import { resolveHmac, resolveJwt } from "../src/signing";
import type { HmacNodeConfig, JwtNodeConfig } from "../src/types";

const ctx = {
  trigger: { body: { amount: 100 }, userId: "u-7" },
};

describe("resolveHmac", () => {
  it("defaults algorithm/encoding and passes the payload through RAW (stringify is in-activity)", () => {
    const config: HmacNodeConfig = {
      connectionId: "sign-1",
      payload: { amount: 100 },
    };
    expect(resolveHmac(config, ctx)).toEqual({
      connectionId: "sign-1",
      algorithm: "sha256",
      payload: { amount: 100 }, // raw — the activity rehydrates + stringifies
      encoding: "hex",
    });
  });

  it("a payloadBinding overrides the static payload from ctx", () => {
    const config: HmacNodeConfig = {
      connectionId: "sign-1",
      algorithm: "sha1",
      encoding: "base64",
      payload: "ignored",
      payloadBinding: { from: "trigger", path: "userId" },
    };
    const r = resolveHmac(config, ctx);
    expect(r).toMatchObject({
      algorithm: "sha1",
      encoding: "base64",
      payload: "u-7",
    });
  });

  it("never carries a key (only connectionId)", () => {
    const r = resolveHmac({ connectionId: "sign-1", payload: "x" }, ctx);
    expect(Object.keys(r)).not.toContain("key");
  });
});

describe("resolveJwt", () => {
  it("builds claims from static + bindings without mutating the source", () => {
    const claims = { iss: "naary" };
    const config: JwtNodeConfig = {
      connectionId: "sign-1",
      claims,
      claimsBindings: { sub: { from: "trigger", path: "userId" } },
      expiresInSeconds: 3600,
    };
    expect(resolveJwt(config, ctx)).toEqual({
      connectionId: "sign-1",
      algorithm: "HS256",
      claims: { iss: "naary", sub: "u-7" },
      expiresInSeconds: 3600,
    });
    expect(claims).toEqual({ iss: "naary" }); // source untouched
  });
});
