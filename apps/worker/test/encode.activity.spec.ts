import { beforeEach, describe, expect, it } from "vitest";
import { __setObjectStore, MemoryObjectStore } from "@naary/storage";
import { callEncode } from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };
const enc = (operation: string, input: unknown) =>
  callEncode({ operation } as never, input, meta).then((r) => r.result);

beforeEach(() => {
  __setObjectStore(new MemoryObjectStore());
});

describe("callEncode", () => {
  it("base64 encode/decode round-trips", async () => {
    expect(await enc("base64Encode", "hello")).toBe("aGVsbG8=");
    expect(await enc("base64Decode", "aGVsbG8=")).toBe("hello");
  });

  it("base64url (no +/=/ padding chars)", async () => {
    const s = "a?b>c";
    const e = await enc("base64urlEncode", s);
    expect(e).not.toMatch(/[+/=]/);
    expect(await enc("base64urlDecode", e)).toBe(s);
  });

  it("hex encode/decode", async () => {
    expect(await enc("hexEncode", "AB")).toBe("4142");
    expect(await enc("hexDecode", "4142")).toBe("AB");
  });

  it("url encode/decode", async () => {
    expect(await enc("urlEncode", "a b&c=d")).toBe("a%20b%26c%3Dd");
    expect(await enc("urlDecode", "a%20b%26c%3Dd")).toBe("a b&c=d");
  });

  it("coerces non-strings and handles empty/null input", async () => {
    expect(await enc("base64Encode", 123)).toBe(
      Buffer.from("123").toString("base64"),
    );
    expect(await enc("base64Encode", null)).toBe("");
  });
});
